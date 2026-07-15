<script setup lang="ts">
import { reactive, computed } from 'vue'
import type { ProvisionConfig } from '@shared/types'
import { useProvisioningStore } from '@/stores/provisioning'
import { useAutoProvisioning } from '@/composables/useAutoProvisioning'

const store = useProvisioningStore()
const { start, stop } = useAutoProvisioning()

const form = reactive<ProvisionConfig>({
  ipStart: '', ipEnd: '', mask: '255.255.255.0', gateway: '',
  extStart: 8001, extEnd: 8100, sipPassword: '', sipServer: '', sipPort: 5060, namePrefix: '',
})

const error = computed<string | null>(() => {
  if (!store.running) {
    if (!form.ipStart || !form.ipEnd) return '請填 IP 範圍'
    if (!form.gateway) return '請填閘道'
    if (form.extStart > form.extEnd) return '分機起始不可大於結束'
    if (!form.sipServer) return '請填 SIP Server'
    if (!form.sipPassword) return '請填 SIP 密碼'
  }
  return null
})

function statusLabel(s: string): string {
  return { discovered: '已發現', ip_assigning: '改 IP 中', waiting_online: '等待上線',
    sip_configuring: '設定 SIP 中', done: '完成', skipped: '已跳過', failed: '失敗' }[s] ?? s
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString('zh-TW', { hour12: false })
}

async function onStart() { if (!error.value) await start({ ...form }) }
function onStop() { stop() }
</script>

<template>
  <div class="p-6 space-y-6 text-on-surface">
    <h2 class="text-lg font-bold text-primary uppercase tracking-wider">自動供裝</h2>

    <!-- 設定表單 -->
    <div class="grid grid-cols-2 md:grid-cols-3 gap-4 bg-surface-container p-4 rounded-lg border border-outline-variant/20">
      <label class="flex flex-col gap-1 text-xs">IP 起<input v-model="form.ipStart" :disabled="store.running" class="input" placeholder="192.168.1.101" /></label>
      <label class="flex flex-col gap-1 text-xs">IP 訖<input v-model="form.ipEnd" :disabled="store.running" class="input" placeholder="192.168.1.200" /></label>
      <label class="flex flex-col gap-1 text-xs">遮罩<input v-model="form.mask" :disabled="store.running" class="input" /></label>
      <label class="flex flex-col gap-1 text-xs">閘道<input v-model="form.gateway" :disabled="store.running" class="input" placeholder="192.168.1.1" /></label>
      <label class="flex flex-col gap-1 text-xs">分機起<input v-model.number="form.extStart" :disabled="store.running" type="number" class="input" /></label>
      <label class="flex flex-col gap-1 text-xs">分機訖<input v-model.number="form.extEnd" :disabled="store.running" type="number" class="input" /></label>
      <label class="flex flex-col gap-1 text-xs">SIP Server<input v-model="form.sipServer" :disabled="store.running" class="input" /></label>
      <label class="flex flex-col gap-1 text-xs">SIP Port<input v-model.number="form.sipPort" :disabled="store.running" type="number" class="input" /></label>
      <label class="flex flex-col gap-1 text-xs">SIP 密碼<input v-model="form.sipPassword" :disabled="store.running" type="password" class="input" /></label>
      <label class="flex flex-col gap-1 text-xs">名稱前綴<input v-model="form.namePrefix" :disabled="store.running" class="input" placeholder="GT-" /></label>
    </div>

    <!-- 啟停 + 狀態列 -->
    <div class="flex items-center gap-4">
      <button v-if="!store.running" class="btn-primary" :disabled="!!error" @click="onStart">▶ 啟動供裝</button>
      <button v-else class="btn-danger" @click="onStop">⏹ 停止</button>
      <span v-if="error" class="text-error text-xs">{{ error }}</span>
      <span v-if="store.running" class="text-xs text-on-surface-variant">
        第 {{ store.round }} 輪 · IP {{ store.pool.ipUsed }}/{{ store.pool.ipTotal }} · 分機 {{ store.pool.extUsed }}/{{ store.pool.extTotal }}
      </span>
      <span v-if="store.paused" class="text-error text-xs font-bold">⚠️ 號碼池用盡，已暫停</span>
    </div>

    <!-- 任務表 -->
    <div class="bg-surface-container rounded-lg border border-outline-variant/20 overflow-hidden">
      <table class="w-full text-xs">
        <thead class="bg-surface-container-high text-on-surface-variant uppercase tracking-wider">
          <tr><th class="p-2 text-left">MAC</th><th class="p-2 text-left">狀態</th><th class="p-2 text-left">分配 IP</th><th class="p-2 text-left">分機</th><th class="p-2 text-left">錯誤</th></tr>
        </thead>
        <tbody>
          <tr v-for="t in store.tasks" :key="t.mac" class="border-t border-outline-variant/10">
            <td class="p-2 font-mono">{{ t.mac }}</td>
            <td class="p-2">{{ statusLabel(t.status) }}</td>
            <td class="p-2 font-mono">{{ t.assignedIp }}</td>
            <td class="p-2">{{ t.assignedExt }}</td>
            <td class="p-2 text-error">{{ t.error ?? '' }}</td>
          </tr>
          <tr v-if="store.tasks.length === 0"><td colspan="5" class="p-4 text-center text-on-surface-variant">尚無設備</td></tr>
        </tbody>
      </table>
    </div>

    <!-- 活動日誌 -->
    <div class="bg-black/40 rounded-lg p-3 h-48 overflow-y-auto font-mono text-[11px] text-on-surface-variant space-y-0.5">
      <div v-for="(l, i) in store.logs" :key="i"><span class="text-primary/60">{{ fmtTime(l.ts) }}</span> {{ l.message }}</div>
    </div>
  </div>
</template>

<style scoped>
.input { @apply bg-surface border border-outline-variant/30 rounded px-2 py-1 text-on-surface focus:border-primary outline-none; }
.btn-primary { @apply px-4 py-2 bg-primary/20 text-primary border border-primary/40 rounded uppercase text-xs tracking-wider hover:bg-primary/30 disabled:opacity-40 disabled:cursor-not-allowed; }
.btn-danger { @apply px-4 py-2 bg-error/20 text-error border border-error/40 rounded uppercase text-xs tracking-wider hover:bg-error/30; }
</style>

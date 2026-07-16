<script setup lang="ts">
import { reactive, computed, ref, onMounted, onUnmounted } from 'vue'
import type { ProvisionConfig, ProvisionTask } from '@shared/types'
import { useProvisioningStore } from '@/stores/provisioning'
import { useAutoProvisioning } from '@/composables/useAutoProvisioning'

const store = useProvisioningStore()
const { start, stop, retry } = useAutoProvisioning()

const form = reactive<ProvisionConfig>({
  ipStart: '', ipEnd: '', mask: '255.255.255.0', gateway: '',
  extStart: 8001, extEnd: 8100, sipPassword: '', sipServer: '', sipPort: 5060, namePrefix: '',
  factoryDefaultIp: '',
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
  return { discovered: '待重試', ip_assigning: '改 IP 中', waiting_online: '等待上線',
    sip_configuring: '設定 SIP 中', done: '完成', skipped: '已跳過', failed: '失敗' }[s] ?? s
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString('zh-TW', { hour12: false })
}

// 每秒更新的時鐘，讓 waiting_online 倒數即時遞減（deadline 為絕對時間戳）
const nowTick = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | null = null
onMounted(() => { ticker = setInterval(() => { nowTick.value = Date.now() }, 1000) })
onUnmounted(() => { if (ticker) clearInterval(ticker) })

/** waiting_online 剩餘秒數（下限 0）；無 deadline 回 null。 */
function countdown(t: ProvisionTask): number | null {
  if (t.status !== 'waiting_online' || t.deadline === undefined) return null
  return Math.max(0, Math.ceil((t.deadline - nowTick.value) / 1000))
}

async function onStart() { if (!error.value) await start({ ...form }) }
function onStop() { stop() }
function onRetry(mac: string) { retry(mac) }
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
      <label class="flex flex-col gap-1 text-xs">工廠預設 IP<input v-model="form.factoryDefaultIp" :disabled="store.running" class="input" placeholder="192.168.1.200（留空=不設限）" /></label>
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

    <!-- 降級警示：登記表寫入失敗，進度無法保存 -->
    <div v-if="store.degraded" class="bg-error/20 border border-error/50 text-error text-xs px-4 py-2 rounded-lg font-bold">
      ⚠️ 進度無法保存（登記表寫入失敗），重開 App 後可能重複供裝，請檢查磁碟空間與權限。
    </div>

    <!-- 任務表 -->
    <div class="bg-surface-container rounded-lg border border-outline-variant/20 overflow-hidden">
      <table class="w-full text-xs">
        <thead class="bg-surface-container-high text-on-surface-variant uppercase tracking-wider">
          <tr><th class="p-2 text-left">MAC</th><th class="p-2 text-left">狀態</th><th class="p-2 text-left">分配 IP</th><th class="p-2 text-left">分機</th><th class="p-2 text-left">錯誤</th><th class="p-2 text-left">操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="t in store.tasks" :key="t.mac" class="border-t border-outline-variant/10">
            <td class="p-2 font-mono">{{ t.mac }}</td>
            <td class="p-2">
              {{ statusLabel(t.status) }}
              <span v-if="countdown(t) !== null" class="text-on-surface-variant">（{{ countdown(t) }}s）</span>
            </td>
            <td class="p-2 font-mono">{{ t.assignedIp }}</td>
            <td class="p-2">{{ t.assignedExt }}</td>
            <td class="p-2 text-error">{{ t.error ?? '' }}</td>
            <td class="p-2">
              <button v-if="t.status === 'failed'" class="btn-retry" @click="onRetry(t.mac)">重試</button>
            </td>
          </tr>
          <tr v-if="store.tasks.length === 0"><td colspan="6" class="p-4 text-center text-on-surface-variant">尚無設備</td></tr>
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
.btn-retry { @apply px-2 py-0.5 bg-primary/15 text-primary border border-primary/40 rounded text-[11px] hover:bg-primary/25; }
</style>

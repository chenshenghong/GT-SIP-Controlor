<template>
  <div class="dayu-detail">
    <div class="detail-header">
      <button class="back-btn" @click="$emit('close')">← 返回列表</button>
      <h2>{{ device.name || device.ip }}</h2>
      <span class="kind-badge">DAYU-OT300（Phase 1 唯讀）</span>
    </div>

    <div class="info-grid">
      <div class="info-card"><span class="label">IP 位址</span><span class="value">{{ device.ip }}</span></div>
      <div class="info-card"><span class="label">型號</span><span class="value">{{ device.type }}</span></div>
      <div class="info-card"><span class="label">連線狀態</span><span class="value">{{ device.status === 'ONLINE' ? '🟢 可連線' : '🔴 離線' }}</span></div>
      <div class="info-card">
        <span class="label">喇叭音量等級</span>
        <span class="value">{{ media ? `${media.speakerVolume} / 9` : '—' }}</span>
      </div>
      <div class="info-card wide">
        <span class="label">Codec 順序</span>
        <span class="value">{{ media?.codecOrder || '—' }}</span>
      </div>
    </div>

    <div class="actions">
      <button class="read-btn" :disabled="loading" @click="readMedia">
        {{ loading ? '讀取中…' : '🔄 重新讀取音量 / Codec' }}
      </button>
    </div>
    <div v-if="errMsg" class="err-msg">{{ errMsg }}</div>
    <div class="note-box">
      此設備走 Web 表單協定（Rapid Logic），寫入控制（音量/SIP/組播設定）將於 Phase 2 提供。
      設定變更請暫時使用設備 Web 頁面 <code>http://{{ device.ip }}/</code>。
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import type { DeviceNode, DayuMediaInfo } from '@shared/types'

const props = defineProps<{ device: DeviceNode }>()
defineEmits<{ close: [] }>()

const media = ref<DayuMediaInfo | null>(null)
const loading = ref(false)
const errMsg = ref('')

async function readMedia() {
  loading.value = true
  errMsg.value = ''
  try {
    const r = await window.electronAPI.dayuGetMedia(props.device.ip, 'admin', 'admin')
    if (r.ok) {
      media.value = r.value
    } else {
      errMsg.value = r.reason === 'auth-failed' ? '❌ 登入失敗（非預設帳密？）'
        : r.reason === 'busy' ? '⚠️ 設備忙碌，請稍後重試'
        : r.reason === 'parse-failed' ? '⚠️ 設備回應不完整，請重試'
        : '❌ 連線失敗'
    }
  } finally {
    loading.value = false
  }
}

onMounted(readMedia) // 單次讀取；絕不背景輪詢（設備 web server 脆弱）
</script>

<style scoped>
.dayu-detail { padding: 1.5rem; }
.detail-header { display: flex; align-items: center; gap: 1rem; margin-bottom: 1.5rem; }
.detail-header h2 { margin: 0; color: #e0f2e9; font-size: 1.3rem; }
.back-btn { background: rgba(139,157,195,0.1); border: 1px solid rgba(139,157,195,0.3); color: #8b9dc3; padding: 6px 14px; border-radius: 8px; cursor: pointer; }
.kind-badge { background: rgba(255,152,0,0.15); border: 1px solid rgba(255,152,0,0.35); color: #ffcc80; padding: 3px 10px; border-radius: 999px; font-size: 0.78rem; }
.info-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.75rem; margin-bottom: 1.25rem; }
.info-card { background: rgba(0,0,0,0.25); border: 1px solid rgba(78,222,163,0.15); border-radius: 10px; padding: 0.9rem 1rem; display: flex; flex-direction: column; gap: 6px; }
.info-card.wide { grid-column: span 4; }
.info-card .label { color: #8b9dc3; font-size: 0.78rem; }
.info-card .value { color: #e0f2e9; font-size: 1.05rem; }
.actions { margin-bottom: 0.75rem; }
.read-btn { background: linear-gradient(135deg, #4edea3, #3bc991); border: none; color: #0c1324; padding: 8px 20px; border-radius: 8px; cursor: pointer; font-weight: 600; }
.read-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.err-msg { color: #ff8a80; font-size: 0.85rem; margin-bottom: 0.75rem; }
.note-box { padding: 10px 14px; background: rgba(255,152,0,0.1); border: 1px solid rgba(255,152,0,0.3); border-radius: 8px; color: #ffcc80; font-size: 0.82rem; }
</style>

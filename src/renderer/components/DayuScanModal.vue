<template>
  <Teleport to="body">
    <div v-if="visible" class="modal-overlay" @click.self="$emit('close')">
      <div class="modal-card">
        <div class="modal-header">
          <h3>🔈 DAYU-OT300 網段掃描</h3>
          <button class="close-btn" @click="$emit('close')">✕</button>
        </div>
        <div class="device-info">
          以 Rapid Logic 指紋（Server header ＋ nonce 端點）掃描整個 /24 網段，不會送出任何帳密。
        </div>
        <div class="form-body">
          <div class="form-group">
            <label>網段前綴（/24）*</label>
            <input v-model="subnet" placeholder="192.168.1" @keyup.enter="handleScan" />
          </div>
        </div>
        <div v-if="scanning" class="progress-line">
          掃描中… {{ progress.done }}/{{ progress.total }}（找到 {{ progress.found }} 台）
        </div>
        <div class="modal-footer">
          <button class="cancel-btn" @click="$emit('close')">取消</button>
          <button class="submit-btn" :disabled="scanning || !subnet" @click="handleScan">
            {{ scanning ? '掃描中...' : '🔍 開始掃描' }}
          </button>
        </div>
        <div v-if="resultMsg" :class="['result-msg', resultOk ? 'success' : 'error']">{{ resultMsg }}</div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, reactive, watch, onUnmounted } from 'vue'
import type { DeviceNode, RestScanProgress } from '@shared/types'

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{
  close: []
  found: [devices: DeviceNode[]]
}>()

const subnet = ref('')
const scanning = ref(false)
const resultMsg = ref('')
const resultOk = ref(false)
const progress = reactive<RestScanProgress>({ done: 0, total: 254, found: 0 })

// 開啟時預填本機 /24 網段
watch(() => props.visible, async (v) => {
  if (v && !subnet.value) {
    subnet.value = (await window.electronAPI.getLocalSubnet()) ?? ''
  }
})

let offProgress: (() => void) | null = null
onUnmounted(() => offProgress?.())

const SUBNET_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

async function handleScan() {
  const s = subnet.value.trim()
  if (!SUBNET_RE.test(s)) {
    resultOk.value = false
    resultMsg.value = '❌ 請輸入 /24 網段前綴，例如 192.168.1'
    return
  }
  scanning.value = true
  resultMsg.value = ''
  progress.done = 0; progress.found = 0
  offProgress = window.electronAPI.onDayuScanProgress((p) => Object.assign(progress, p))
  try {
    const r = await window.electronAPI.dayuScan(s)
    if (r.success && r.devices) {
      resultOk.value = true
      resultMsg.value = `✅ 找到 ${r.devices.length} 台 DAYU-OT300`
      emit('found', r.devices)
    } else {
      resultOk.value = false
      resultMsg.value = `❌ 掃描失敗：${r.error ?? '未知錯誤'}`
    }
  } finally {
    scanning.value = false
    offProgress?.()
    offProgress = null
  }
}
</script>

<style scoped>
.modal-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.7); backdrop-filter: blur(4px); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.modal-card { background: linear-gradient(145deg, #141e35, #0c1324); border: 1px solid rgba(78,222,163,0.2); border-radius: 16px; width: 460px; box-shadow: 0 20px 60px rgba(0,0,0,0.5); }
.modal-header { display: flex; justify-content: space-between; align-items: center; padding: 1.25rem 1.5rem; border-bottom: 1px solid rgba(78,222,163,0.1); }
.modal-header h3 { margin: 0; color: #e0f2e9; font-size: 1.1rem; }
.close-btn { background: none; border: none; color: #8b9dc3; font-size: 1.2rem; cursor: pointer; }
.device-info { padding: 0.75rem 1.5rem; font-size: 0.82rem; color: #8b9dc3; background: rgba(0,0,0,0.2); }
.form-body { padding: 1rem 1.5rem; }
.form-group { display: flex; flex-direction: column; gap: 4px; }
.form-group label { color: #8b9dc3; font-size: 0.8rem; }
.form-group input { background: rgba(0,0,0,0.3); border: 1px solid rgba(78,222,163,0.2); color: #e0f2e9; padding: 8px 12px; border-radius: 6px; font-size: 0.9rem; }
.progress-line { padding: 0 1.5rem 0.5rem; color: #4edea3; font-size: 0.85rem; }
.modal-footer { display: flex; justify-content: flex-end; gap: 12px; padding: 1rem 1.5rem; border-top: 1px solid rgba(78,222,163,0.1); }
.cancel-btn { background: rgba(139,157,195,0.1); border: 1px solid rgba(139,157,195,0.3); color: #8b9dc3; padding: 8px 20px; border-radius: 8px; cursor: pointer; }
.submit-btn { background: linear-gradient(135deg, #4edea3, #3bc991); border: none; color: #0c1324; padding: 8px 24px; border-radius: 8px; cursor: pointer; font-weight: 600; }
.submit-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.result-msg { margin: 0.75rem 1.5rem 1rem; padding: 10px 14px; border-radius: 8px; font-size: 0.85rem; }
.result-msg.success { background: rgba(78,222,163,0.1); border: 1px solid rgba(78,222,163,0.3); color: #4edea3; }
.result-msg.error { background: rgba(255,82,82,0.1); border: 1px solid rgba(255,82,82,0.3); color: #ff5252; }
</style>

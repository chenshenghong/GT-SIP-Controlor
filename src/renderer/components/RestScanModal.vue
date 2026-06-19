<template>
  <Teleport to="body">
    <div v-if="visible" class="modal-overlay" @click.self="!isScanning && $emit('close')">
      <div class="modal-card">
        <div class="modal-header">
          <h3>🔎 REST 掃描（發現 SIP 終端）</h3>
          <button class="close-btn" :disabled="isScanning" @click="$emit('close')">✕</button>
        </div>

        <div class="device-info">
          掃描整個網段的 <code>:80</code>，自動找出回應 REST 的 SIP 終端（含 DBP 掃不到的新機種）。
        </div>

        <div class="form-body">
          <div class="form-group">
            <label>網段（/24）</label>
            <div class="subnet-row">
              <input v-model="subnetBase" placeholder="192.168.0" :disabled="isScanning" />
              <span class="subnet-suffix">.1 ~ .254</span>
            </div>
          </div>
        </div>

        <div v-if="isScanning || progress" class="progress-area">
          <div class="progress-bar">
            <div class="progress-fill" :style="{ width: pct + '%' }"></div>
          </div>
          <div class="progress-text">
            <span>{{ progress?.done || 0 }} / 254</span>
            <span class="found">找到 {{ progress?.found || 0 }} 台</span>
          </div>
        </div>

        <div v-if="resultMsg" :class="['result-msg', resultOk ? 'success' : 'error']">
          {{ resultMsg }}
        </div>

        <div class="modal-footer">
          <button class="cancel-btn" :disabled="isScanning" @click="$emit('close')">關閉</button>
          <button class="submit-btn" :disabled="isScanning || !subnetValid" @click="handleScan">
            {{ isScanning ? '掃描中...' : '▶ 開始掃描' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import type { DeviceNode } from '@shared/types'
import { restScanSubnet, type RestScanProgress } from '@/composables/useRestScan'

defineProps<{ visible: boolean }>()
const emit = defineEmits<{
  close: []
  found: [devices: DeviceNode[]]
}>()

const subnetBase = ref('192.168.0')
const isScanning = ref(false)
const progress = ref<RestScanProgress | null>(null)
const resultMsg = ref('')
const resultOk = ref(false)

const subnetValid = computed(() => /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(subnetBase.value.trim()))
const pct = computed(() => (progress.value ? Math.round((progress.value.done / progress.value.total) * 100) : 0))

async function handleScan() {
  if (!subnetValid.value) return
  isScanning.value = true
  resultMsg.value = ''
  progress.value = { done: 0, total: 254, found: 0 }
  try {
    const devices = await restScanSubnet(subnetBase.value.trim(), (p) => { progress.value = p })
    if (devices.length > 0) {
      emit('found', devices)
      resultOk.value = true
      resultMsg.value = `✅ 找到 ${devices.length} 台，已加入設備清單`
      setTimeout(() => emit('close'), 1200)
    } else {
      resultOk.value = false
      resultMsg.value = '⚠️ 此網段未找到 REST SIP 終端'
    }
  } catch (err) {
    resultOk.value = false
    resultMsg.value = `❌ 掃描失敗：${err}`
  } finally {
    isScanning.value = false
  }
}
</script>

<style scoped>
.modal-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.7); backdrop-filter: blur(4px); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.modal-card { background: linear-gradient(145deg, #141e35, #0c1324); border: 1px solid rgba(78,222,163,0.2); border-radius: 16px; width: 460px; box-shadow: 0 20px 60px rgba(0,0,0,0.5); }
.modal-header { display: flex; justify-content: space-between; align-items: center; padding: 1.25rem 1.5rem; border-bottom: 1px solid rgba(78,222,163,0.1); }
.modal-header h3 { margin: 0; color: #e0f2e9; font-size: 1.1rem; }
.close-btn { background: none; border: none; color: #8b9dc3; font-size: 1.2rem; cursor: pointer; }
.close-btn:hover:not(:disabled) { color: #ff5252; }
.close-btn:disabled { opacity: 0.4; cursor: not-allowed; }

.device-info { padding: 0.75rem 1.5rem; font-size: 0.82rem; color: #8b9dc3; background: rgba(0,0,0,0.2); }
.device-info code { background: rgba(78,222,163,0.1); padding: 1px 6px; border-radius: 4px; color: #4edea3; }

.form-body { padding: 1rem 1.5rem; }
.form-group { display: flex; flex-direction: column; gap: 4px; }
.form-group label { color: #8b9dc3; font-size: 0.8rem; }
.subnet-row { display: flex; align-items: center; gap: 8px; }
.subnet-row input { flex: 1; background: rgba(0,0,0,0.3); border: 1px solid rgba(78,222,163,0.2); color: #e0f2e9; padding: 8px 12px; border-radius: 6px; font-size: 0.9rem; }
.subnet-row input:focus { outline: none; border-color: #4edea3; }
.subnet-suffix { color: #8b9dc3; font-size: 0.85rem; font-family: monospace; }

.progress-area { padding: 0 1.5rem 0.5rem; }
.progress-bar { height: 8px; background: rgba(0,0,0,0.3); border-radius: 4px; overflow: hidden; }
.progress-fill { height: 100%; background: linear-gradient(90deg, #4edea3, #3bc991); transition: width 0.2s; }
.progress-text { display: flex; justify-content: space-between; margin-top: 6px; font-size: 0.8rem; color: #8b9dc3; }
.progress-text .found { color: #4edea3; font-weight: 600; }

.result-msg { margin: 0.5rem 1.5rem; padding: 10px 14px; border-radius: 8px; font-size: 0.85rem; }
.result-msg.success { background: rgba(78,222,163,0.1); border: 1px solid rgba(78,222,163,0.3); color: #4edea3; }
.result-msg.error { background: rgba(255,82,82,0.1); border: 1px solid rgba(255,82,82,0.3); color: #ff5252; }

.modal-footer { display: flex; justify-content: flex-end; gap: 12px; padding: 1rem 1.5rem; border-top: 1px solid rgba(78,222,163,0.1); }
.cancel-btn { background: rgba(139,157,195,0.1); border: 1px solid rgba(139,157,195,0.3); color: #8b9dc3; padding: 8px 20px; border-radius: 8px; cursor: pointer; }
.cancel-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.submit-btn { background: linear-gradient(135deg, #4edea3, #3bc991); border: none; color: #0c1324; padding: 8px 24px; border-radius: 8px; cursor: pointer; font-weight: 600; }
.submit-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.submit-btn:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 4px 15px rgba(78,222,163,0.3); }
</style>

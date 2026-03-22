<template>
  <Teleport to="body">
    <div v-if="visible" class="modal-overlay" @click.self="$emit('close')">
      <div class="modal-card">
        <div class="modal-header">
          <h3>🔧 修改 IP 設定 (DBP SET)</h3>
          <button class="close-btn" @click="$emit('close')">✕</button>
        </div>

        <div class="device-info">
          <span>目標設備:</span>
          <code>{{ device.mac }}</code>
          <span class="current-ip">目前 IP: <strong>{{ device.ip }}</strong></span>
        </div>

        <div class="duplicate-warning" v-if="isDuplicateIp">
          ⚠️ 此 IP 有 {{ duplicateCount }} 台設備共用出廠預設 IP！
          建議修改為獨立 IP 避免衝突。
        </div>

        <div class="form-body">
          <div class="form-group">
            <label>新 IP 位址</label>
            <input v-model="form.newIp" placeholder="192.168.1.200" />
          </div>
          <div class="form-group">
            <label>子網路遮罩</label>
            <input v-model="form.newMask" placeholder="255.255.255.0" />
          </div>
          <div class="form-group">
            <label>閘道</label>
            <input v-model="form.newGateway" placeholder="192.168.1.1" />
          </div>
          <div class="form-group">
            <label>IP 模式</label>
            <select v-model.number="form.autoIp">
              <option :value="0">手動 (Static)</option>
              <option :value="1">自動 (DHCP)</option>
            </select>
          </div>
          <div class="form-group">
            <label>DNS1 (可選)</label>
            <input v-model="form.dns1" placeholder="8.8.8.8" />
          </div>
          <div class="form-group">
            <label>DNS2 (可選)</label>
            <input v-model="form.dns2" placeholder="8.8.4.4" />
          </div>
        </div>

        <div class="warning-box">
          ⚠️ 修改 IP 後設備會重新啟動，原 IP 將無法連線。
          系統會自動 Ping 新 IP 直到設備恢復上線。
        </div>

        <div class="modal-footer">
          <button class="cancel-btn" @click="$emit('close')">取消</button>
          <button class="submit-btn" :disabled="isSending" @click="handleSubmit">
            {{ isSending ? '發送中...' : '✅ 確認修改 IP' }}
          </button>
        </div>

        <!-- Result message -->
        <div v-if="resultMsg" :class="['result-msg', resultOk ? 'success' : 'error']">
          {{ resultMsg }}
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, reactive, computed } from 'vue'
import type { DeviceNode, IpChangeRequest } from '@shared/types'

const props = defineProps<{
  visible: boolean
  device: DeviceNode
  duplicateCount: number
}>()

const emit = defineEmits<{
  close: []
  success: [newIp: string]
}>()

const isDuplicateIp = computed(() => props.duplicateCount > 1)

const form = reactive<Omit<IpChangeRequest, 'targetIp'>>({
  newIp: '',
  newMask: props.device.mask || '255.255.255.0',
  newGateway: props.device.gateway || '192.168.1.1',
  autoIp: 0,
  dns1: props.device.dns1 || '',
  dns2: props.device.dns2 || '',
})

const isSending = ref(false)
const resultMsg = ref('')
const resultOk = ref(false)

async function handleSubmit() {
  if (!form.newIp) {
    resultMsg.value = '❌ 請輸入新 IP 位址'
    resultOk.value = false
    return
  }

  isSending.value = true
  resultMsg.value = ''

  try {
    const request: IpChangeRequest = {
      targetIp: props.device.ip,
      ...form,
    }

    const result = await window.electronAPI.changeIp(request)

    if (result.success) {
      resultMsg.value = `✅ IP 已修改為 ${form.newIp}，等待設備重啟...`
      resultOk.value = true
      setTimeout(() => emit('success', form.newIp), 1500)
    } else {
      resultMsg.value = `❌ 修改失敗: ${result.error}`
      resultOk.value = false
    }
  } catch (err) {
    resultMsg.value = `❌ 發送錯誤: ${err}`
    resultOk.value = false
  } finally {
    isSending.value = false
  }
}
</script>

<style scoped>
.modal-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.7); backdrop-filter: blur(4px); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.modal-card { background: linear-gradient(145deg, #141e35, #0c1324); border: 1px solid rgba(78,222,163,0.2); border-radius: 16px; width: 480px; max-height: 90vh; overflow-y: auto; box-shadow: 0 20px 60px rgba(0,0,0,0.5); }
.modal-header { display: flex; justify-content: space-between; align-items: center; padding: 1.25rem 1.5rem; border-bottom: 1px solid rgba(78,222,163,0.1); }
.modal-header h3 { margin: 0; color: #e0f2e9; font-size: 1.1rem; }
.close-btn { background: none; border: none; color: #8b9dc3; font-size: 1.2rem; cursor: pointer; }
.close-btn:hover { color: #ff5252; }

.device-info { padding: 0.75rem 1.5rem; display: flex; align-items: center; gap: 12px; font-size: 0.85rem; color: #8b9dc3; background: rgba(0,0,0,0.2); }
.device-info code { background: rgba(78,222,163,0.1); padding: 2px 8px; border-radius: 4px; color: #4edea3; }
.current-ip { margin-left: auto; }
.current-ip strong { color: #e0f2e9; }

.duplicate-warning { margin: 0 1.5rem; padding: 10px 14px; background: rgba(255,82,82,0.1); border: 1px solid rgba(255,82,82,0.3); border-radius: 8px; color: #ff8a80; font-size: 0.85rem; margin-top: 0.75rem; }

.form-body { padding: 1rem 1.5rem; display: grid; gap: 0.75rem; }
.form-group { display: flex; flex-direction: column; gap: 4px; }
.form-group label { color: #8b9dc3; font-size: 0.8rem; }
.form-group input, .form-group select { background: rgba(0,0,0,0.3); border: 1px solid rgba(78,222,163,0.2); color: #e0f2e9; padding: 8px 12px; border-radius: 6px; font-size: 0.9rem; }
.form-group input:focus, .form-group select:focus { outline: none; border-color: #4edea3; }

.warning-box { margin: 0 1.5rem; padding: 10px 14px; background: rgba(255,152,0,0.1); border: 1px solid rgba(255,152,0,0.3); border-radius: 8px; color: #ffcc80; font-size: 0.85rem; }

.modal-footer { display: flex; justify-content: flex-end; gap: 12px; padding: 1rem 1.5rem; border-top: 1px solid rgba(78,222,163,0.1); }
.cancel-btn { background: rgba(139,157,195,0.1); border: 1px solid rgba(139,157,195,0.3); color: #8b9dc3; padding: 8px 20px; border-radius: 8px; cursor: pointer; }
.submit-btn { background: linear-gradient(135deg, #4edea3, #3bc991); border: none; color: #0c1324; padding: 8px 24px; border-radius: 8px; cursor: pointer; font-weight: 600; }
.submit-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.submit-btn:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 4px 15px rgba(78,222,163,0.3); }

.result-msg { margin: 0.75rem 1.5rem 1rem; padding: 10px 14px; border-radius: 8px; font-size: 0.85rem; }
.result-msg.success { background: rgba(78,222,163,0.1); border: 1px solid rgba(78,222,163,0.3); color: #4edea3; }
.result-msg.error { background: rgba(255,82,82,0.1); border: 1px solid rgba(255,82,82,0.3); color: #ff5252; }
</style>

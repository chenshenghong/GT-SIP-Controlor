<template>
  <div class="device-detail">
    <!-- Header -->
    <div class="detail-header">
      <button class="back-btn" @click="$emit('close')">
        <span class="icon">←</span> 返回設備清單
      </button>
      <div class="device-identity">
        <h2>{{ device.name || device.hostName || 'Unknown Device' }}</h2>
        <span class="device-type">{{ device.type }}</span>
        <span :class="['status-badge', device.status.toLowerCase()]">{{ device.status }}</span>
      </div>
      <div class="device-meta">
        <span>IP: <strong>{{ device.ip }}</strong></span>
        <span>MAC: <code>{{ device.mac }}</code></span>
        <span>FW: {{ device.version }}</span>
      </div>
    </div>

    <!-- Tab Navigation -->
    <div class="tab-bar">
      <button v-for="tab in tabs" :key="tab.id"
        :class="['tab-btn', { active: activeTab === tab.id }]"
        @click="activeTab = tab.id">
        {{ tab.label }}
      </button>
    </div>

    <!-- Tab Content -->
    <div class="tab-content">

      <!-- Status Tab -->
      <div v-if="activeTab === 'status'" class="tab-panel">
        <div class="panel-header">
          <h3>設備狀態</h3>
          <button class="poll-btn" :class="{ active: polling.isPolling.value }"
            @click="polling.isPolling.value ? polling.stopPolling() : polling.startPolling()">
            {{ polling.isPolling.value ? '⏸ 停止輪詢' : '▶ 開始輪詢 (3s)' }}
          </button>
        </div>
        <pre class="status-json">{{ polling.deviceStatus.value ? JSON.stringify(polling.deviceStatus.value, null, 2) : '尚未取得...' }}</pre>
        <div class="call-section" v-if="polling.callStatus.value">
          <h4>通話狀態</h4>
          <pre class="status-json">{{ JSON.stringify(polling.callStatus.value, null, 2) }}</pre>
        </div>
        <div class="system-actions">
          <button class="danger-btn" @click="handleRestart">⚠️ 重啟設備</button>
        </div>
      </div>

      <!-- Audio Tab -->
      <div v-if="activeTab === 'audio'" class="tab-panel">
        <h3>音頻控制</h3>
        <div class="form-group">
          <label>播放音量 (broadcast_volume)</label>
          <input type="range" v-model.number="audioForm.broadcast_volume" min="0" max="15" />
          <span class="vol-value">{{ audioForm.broadcast_volume }}</span>
        </div>
        <div class="form-group">
          <label>麥克風音量 (microphone_volume)</label>
          <input type="range" v-model.number="audioForm.microphone_volume" min="0" max="15" />
          <span class="vol-value">{{ audioForm.microphone_volume }}</span>
        </div>
        <button class="primary-btn" @click="handleSetVolume">儲存音量</button>
      </div>

      <!-- SIP Tab -->
      <div v-if="activeTab === 'sip'" class="tab-panel">
        <h3>SIP 設定</h3>
        <div class="form-grid">
          <div class="form-group">
            <label>SIP Server</label>
            <input v-model="sipForm.server_address" placeholder="192.168.1.11" />
          </div>
          <div class="form-group">
            <label>Port</label>
            <input v-model.number="sipForm.server_port" type="number" placeholder="8899" />
          </div>
          <div class="form-group">
            <label>User ID</label>
            <input v-model="sipForm.user_id" placeholder="1027" />
          </div>
          <div class="form-group">
            <label>Password</label>
            <input type="password" v-model="sipForm.password" placeholder="123456" />
          </div>
          <div class="form-group">
            <label>Protocol</label>
            <select v-model="sipForm.transport_protocol">
              <option value="TCP">TCP</option>
              <option value="UDP">UDP</option>
            </select>
          </div>
          <div class="form-group">
            <label>Register Timeout</label>
            <input v-model.number="sipForm.register_timeout" type="number" />
          </div>
          <div class="form-group checkbox">
            <label><input type="checkbox" v-model="sipForm.auto_answer" /> Auto Answer</label>
          </div>
        </div>
        <button class="primary-btn" @click="handleSetSip">儲存 SIP 設定</button>

        <hr class="section-divider" />

        <h3>組播接收 (Multicast)</h3>
        <div class="form-grid">
          <div class="form-group">
            <label>Multicast Address</label>
            <input v-model="multicastForm.multicast_address" placeholder="239.168.12.1" />
          </div>
          <div class="form-group">
            <label>Port</label>
            <input v-model.number="multicastForm.multicast_port" type="number" placeholder="2000" />
          </div>
          <div class="form-group">
            <label>Codec</label>
            <select v-model="multicastForm.audio_codec">
              <option value="G.722">G.722</option>
              <option value="Opus">Opus</option>
              <option value="G.711 uLaw">G.711 uLaw</option>
              <option value="G.711 aLaw">G.711 aLaw</option>
            </select>
          </div>
          <div class="form-group checkbox">
            <label><input type="checkbox" v-model="multicastForm.enabled" /> 啟用組播</label>
          </div>
        </div>
        <button class="primary-btn" @click="handleSetMulticast">儲存組播設定</button>
      </div>

      <!-- Call Tab -->
      <div v-if="activeTab === 'call'" class="tab-panel">
        <h3>通話控制</h3>
        <div class="form-group">
          <label>撥號號碼</label>
          <input v-model="dialNumber" placeholder="1001" />
        </div>
        <div class="call-actions">
          <button class="success-btn" @click="handleCall('dial')">📞 撥號</button>
          <button class="primary-btn" @click="handleCall('answer')">📱 接聽</button>
          <button class="danger-btn" @click="handleCall('hangup')">📵 掛斷</button>
        </div>
      </div>

      <!-- Network Tab -->
      <div v-if="activeTab === 'network'" class="tab-panel">
        <h3>網路設定</h3>
        <div class="form-grid">
          <div class="form-group">
            <label>Network Mode</label>
            <select v-model="networkForm.network_mode">
              <option value="static">Static</option>
              <option value="dhcp">DHCP</option>
            </select>
          </div>
          <div class="form-group">
            <label>IP Address</label>
            <input v-model="networkForm.ip_address" placeholder="192.168.1.200" />
          </div>
          <div class="form-group">
            <label>Subnet Mask</label>
            <input v-model="networkForm.subnet_mask" placeholder="255.255.255.0" />
          </div>
          <div class="form-group">
            <label>Gateway</label>
            <input v-model="networkForm.gateway" placeholder="192.168.1.1" />
          </div>
          <div class="form-group">
            <label>DNS</label>
            <input v-model="networkForm.dns" placeholder="8.8.8.8" />
          </div>
        </div>
        <div class="warning-box">
          ⚠️ 修改 IP 後設備將斷線！CMS 會自動偵測新 IP 並重新連線。
        </div>
        <button class="danger-btn" @click="handleSetNetwork">💾 儲存網路設定</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, toRef } from 'vue'
import type { DeviceNode } from '@shared/types'
import { useDevicePolling } from '@/composables/useDevicePolling'
import {
  setDeviceVolume, setSipPrimary, setSipMulticast,
  callControl, setNetworkConfig, restartDevice,
} from '@/composables/deviceApi'

const props = defineProps<{ device: DeviceNode }>()
const emit = defineEmits<{
  close: []
  reconnect: [newIp: string]
}>()

const tabs = [
  { id: 'status', label: '📊 狀態監控' },
  { id: 'audio', label: '🔊 音頻控制' },
  { id: 'sip', label: '📡 SIP / 組播' },
  { id: 'call', label: '📞 通話控制' },
  { id: 'network', label: '🌐 網路設定' },
]

const activeTab = ref('status')
const deviceIp = toRef(() => props.device.ip)
const polling = useDevicePolling(deviceIp)

// Form states
const audioForm = reactive({ broadcast_volume: props.device.playVol, microphone_volume: props.device.captureVol })
const sipForm = reactive({
  server_address: props.device.server.split(':')[0] || '',
  server_port: parseInt(props.device.server.split(':')[1]) || 8899,
  user_id: '', password: '', auto_answer: true,
  register_timeout: 3600, transport_protocol: 'TCP',
})
const multicastForm = reactive({
  multicast_address: '239.168.12.1', multicast_port: 2000,
  enabled: true, audio_codec: 'G.722',
})
const networkForm = reactive({
  network_mode: props.device.autoIp === 1 ? 'dhcp' as const : 'static' as const,
  ip_address: props.device.ip,
  subnet_mask: props.device.mask,
  gateway: props.device.gateway,
  dns: props.device.dns1,
})
const dialNumber = ref('')

// Handlers
async function handleSetVolume() {
  const ok = await setDeviceVolume(props.device.ip, audioForm)
  alert(ok ? '✅ 音量已更新' : '❌ 更新失敗')
}

async function handleSetSip() {
  const ok = await setSipPrimary(props.device.ip, sipForm)
  alert(ok ? '✅ SIP 設定已更新' : '❌ 更新失敗')
}

async function handleSetMulticast() {
  const ok = await setSipMulticast(props.device.ip, multicastForm)
  alert(ok ? '✅ 組播設定已更新' : '❌ 更新失敗')
}

async function handleCall(action: 'dial' | 'answer' | 'hangup') {
  const ok = await callControl(props.device.ip, action, dialNumber.value || undefined)
  alert(ok ? `✅ ${action} 成功` : `❌ ${action} 失敗`)
}

async function handleSetNetwork() {
  if (!confirm('⚠️ 修改網路設定可能導致設備斷線，確定繼續？')) return
  const ok = await setNetworkConfig(props.device.ip, networkForm)
  if (ok && networkForm.ip_address !== props.device.ip) {
    emit('reconnect', networkForm.ip_address)
  } else if (!ok) {
    alert('❌ 網路設定更新失敗')
  }
}

async function handleRestart() {
  if (!confirm('⚠️ 確定要重啟設備？設備將離線約 45 秒。')) return
  const ok = await restartDevice(props.device.ip)
  if (ok) {
    emit('reconnect', props.device.ip)
  } else {
    alert('❌ 重啟指令失敗')
  }
}
</script>

<style scoped>
.device-detail { padding: 0 1.5rem 1.5rem; }
.detail-header { padding: 1rem 0; border-bottom: 1px solid rgba(78,222,163,0.15); }
.back-btn { background: none; border: 1px solid rgba(78,222,163,0.3); color: var(--color-primary, #4edea3); padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 0.85rem; transition: all 0.2s; }
.back-btn:hover { background: rgba(78,222,163,0.1); }
.device-identity { display: flex; align-items: center; gap: 12px; margin-top: 12px; }
.device-identity h2 { margin: 0; font-size: 1.3rem; color: #e0f2e9; }
.device-type { background: rgba(78,222,163,0.15); color: #4edea3; padding: 2px 10px; border-radius: 12px; font-size: 0.75rem; }
.status-badge { padding: 2px 10px; border-radius: 12px; font-size: 0.75rem; font-weight: 600; }
.status-badge.online { background: rgba(78,222,163,0.2); color: #4edea3; }
.status-badge.disconnected { background: rgba(255,82,82,0.2); color: #ff5252; }
.device-meta { display: flex; gap: 1.5rem; margin-top: 8px; font-size: 0.85rem; color: #8b9dc3; }
.device-meta strong { color: #e0f2e9; }
.device-meta code { background: rgba(78,222,163,0.1); padding: 1px 6px; border-radius: 4px; font-size: 0.8rem; }

.tab-bar { display: flex; gap: 4px; margin-top: 1rem; border-bottom: 1px solid rgba(78,222,163,0.1); }
.tab-btn { background: none; border: none; color: #8b9dc3; padding: 10px 16px; cursor: pointer; font-size: 0.85rem; transition: all 0.2s; border-bottom: 2px solid transparent; }
.tab-btn.active { color: #4edea3; border-bottom-color: #4edea3; }
.tab-btn:hover { color: #e0f2e9; }

.tab-content { margin-top: 1rem; }
.tab-panel { animation: fadeIn 0.2s ease-in; }
.tab-panel h3 { color: #e0f2e9; margin: 0 0 1rem; font-size: 1.05rem; }
.tab-panel h4 { color: #8b9dc3; margin: 1rem 0 0.5rem; }

.panel-header { display: flex; justify-content: space-between; align-items: center; }
.poll-btn { background: rgba(78,222,163,0.1); border: 1px solid rgba(78,222,163,0.3); color: #4edea3; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 0.8rem; }
.poll-btn.active { background: rgba(78,222,163,0.2); }

.status-json { background: rgba(0,0,0,0.3); border: 1px solid rgba(78,222,163,0.1); border-radius: 8px; padding: 1rem; color: #8b9dc3; font-size: 0.8rem; max-height: 300px; overflow-y: auto; white-space: pre-wrap; }

.form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 1rem; }
.form-group { display: flex; flex-direction: column; gap: 4px; }
.form-group label { color: #8b9dc3; font-size: 0.8rem; }
.form-group input, .form-group select { background: rgba(0,0,0,0.3); border: 1px solid rgba(78,222,163,0.2); color: #e0f2e9; padding: 8px 12px; border-radius: 6px; font-size: 0.9rem; }
.form-group input:focus, .form-group select:focus { outline: none; border-color: #4edea3; }
.form-group input[type="range"] { accent-color: #4edea3; }
.form-group.checkbox { flex-direction: row; align-items: center; }
.form-group.checkbox label { display: flex; align-items: center; gap: 8px; }
.vol-value { color: #4edea3; font-weight: 700; font-size: 1.1rem; min-width: 30px; text-align: center; }

.primary-btn { background: linear-gradient(135deg, #4edea3, #3bc991); border: none; color: #0c1324; padding: 10px 24px; border-radius: 8px; cursor: pointer; font-weight: 600; margin-top: 1rem; transition: all 0.2s; }
.primary-btn:hover { transform: translateY(-1px); box-shadow: 0 4px 15px rgba(78,222,163,0.3); }
.success-btn { background: linear-gradient(135deg, #4edea3, #3bc991); border: none; color: #0c1324; padding: 10px 24px; border-radius: 8px; cursor: pointer; font-weight: 600; }
.danger-btn { background: linear-gradient(135deg, #ff5252, #d32f2f); border: none; color: white; padding: 10px 24px; border-radius: 8px; cursor: pointer; font-weight: 600; margin-top: 1rem; }
.danger-btn:hover { transform: translateY(-1px); box-shadow: 0 4px 15px rgba(255,82,82,0.3); }

.call-actions { display: flex; gap: 12px; margin-top: 1rem; }
.section-divider { border: none; border-top: 1px solid rgba(78,222,163,0.1); margin: 2rem 0; }
.system-actions { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid rgba(255,82,82,0.2); }
.warning-box { background: rgba(255,152,0,0.1); border: 1px solid rgba(255,152,0,0.3); color: #ffcc80; padding: 10px 14px; border-radius: 8px; font-size: 0.85rem; margin: 1rem 0; }

@keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
</style>

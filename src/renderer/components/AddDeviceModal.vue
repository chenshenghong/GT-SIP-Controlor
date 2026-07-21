<template>
  <Teleport to="body">
    <div v-if="visible" class="modal-overlay" @click.self="$emit('close')">
      <div class="modal-card">
        <div class="modal-header">
          <h3>➕ 手動新增設備</h3>
          <button class="close-btn" @click="$emit('close')">✕</button>
        </div>

        <div class="device-info">
          <span>掃描不到的設備可用 IP 直接加入控制：GT 走 REST 登入，DAYU-OT300 走 Web 表單（main process）。</span>
        </div>

        <div class="form-body">
          <div class="form-group">
            <label>設備型號 *</label>
            <select v-model="form.kind" @change="applyKindDefaults">
              <option value="gt-sip-gw">GT-SIP-GW / SIP-Player（REST JSON）</option>
              <option value="dayu-ot300">DAYU-OT300 音柱（Web 表單）</option>
            </select>
          </div>
          <div class="form-group">
            <label>設備 IP 位址 *</label>
            <input v-model="form.ip" placeholder="192.168.0.147" @keyup.enter="handleSubmit" />
          </div>
          <div class="form-group">
            <label>顯示名稱 (可選)</label>
            <input v-model="form.name" placeholder="1F-大廳廣播" />
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>帳號</label>
              <input v-model="form.username" placeholder="admin" />
            </div>
            <div class="form-group">
              <label>密碼</label>
              <input type="password" v-model="form.password" :placeholder="form.kind === 'dayu-ot300' ? 'admin' : '123456'" />
            </div>
          </div>
        </div>

        <div class="warning-box">
          會先嘗試登入並讀取設備資訊；登入失敗仍會以「離線」狀態加入，方便稍後重試。
        </div>

        <div class="modal-footer">
          <button class="cancel-btn" @click="$emit('close')">取消</button>
          <button class="submit-btn" :disabled="isSubmitting || !form.ip" @click="handleSubmit">
            {{ isSubmitting ? '連線中...' : '✅ 加入設備' }}
          </button>
        </div>

        <div v-if="resultMsg" :class="['result-msg', resultOk ? 'success' : 'error']">
          {{ resultMsg }}
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, reactive } from 'vue'
import type { DeviceNode, DeviceKind } from '@shared/types'
import { loginToDevice, getDeviceStatus, getSipConfig } from '@/composables/deviceApi'

defineProps<{ visible: boolean }>()
const emit = defineEmits<{
  close: []
  added: [device: DeviceNode]
}>()

const form = reactive({
  kind: 'gt-sip-gw' as DeviceKind,
  ip: '',
  name: '',
  username: 'admin',
  password: '123456',
})

/** 切換型號時帶入該家族的出廠預設帳密（DAYU: admin/admin；GT: admin/123456） */
function applyKindDefaults() {
  form.password = form.kind === 'dayu-ot300' ? 'admin' : '123456'
}

const isSubmitting = ref(false)
const resultMsg = ref('')
const resultOk = ref(false)

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

function makeNode(ip: string): DeviceNode {
  return {
    deviceKind: form.kind,
    id: 0, type: form.kind === 'dayu-ot300' ? 'DAYU-OT300' : 'SIP-Player',
    mac: '', sn: '', name: form.name || ip, hostName: '',
    ip, mask: '255.255.255.0', gateway: '', autoIp: 0, dns1: '', dns2: '', useDns: 0,
    server: '', server2: '', mode: '', isBroadcast: 0, version: '',
    playVol: 0, captureVol: 0, treble: 0, bass: 0, tbAgc: 0, tbLinein: 0,
    group: 0, speed: 0, encrypt: 0, reboot: '', website: '', svcConfig: '', localSet: '',
    status: 'DISCONNECTED',
  }
}

/** GT 路徑：維持既有行為（renderer axios REST） */
async function submitGt(node: DeviceNode, ip: string) {
  const ok = await loginToDevice(ip, form.username, form.password)
  if (ok) {
    const status = await getDeviceStatus(ip)
    const di = status?.sip_status?.device_info
    const ni = status?.sip_status?.network_info
    if (di) {
      node.type = di.model || node.type
      node.version = di.software_version || ''
      node.playVol = di.broadcast_volume ?? 0
      node.captureVol = di.microphone_volume ?? 0
    }
    if (ni) {
      node.mac = ni.mac_address || ''
      node.ip = ni.ip_address || ip
      node.mask = ni.subnet_mask || node.mask
      node.gateway = ni.gateway || ''
      node.dns1 = ni.dns || ''
    }
    const sip = await getSipConfig(ip)
    const pl = sip?.primary_line
    if (pl?.server_address) node.server = `${pl.server_address}:${pl.server_port}`
    node.status = 'ONLINE'
    node.name = form.name || node.type || ip
    resultOk.value = true
    resultMsg.value = `✅ 已加入 ${node.name}（${node.mac || ip}）`
  } else {
    resultOk.value = false
    resultMsg.value = '⚠️ 登入失敗（帳密或連線問題），已以離線狀態加入。'
  }
}

/** DAYU 路徑：一律走 main process（nonce/MD5 + per-IP 佇列） */
async function submitDayu(node: DeviceNode, ip: string) {
  const login = await window.electronAPI.dayuLoginCheck(ip, form.username, form.password)
  if (login.ok) {
    node.status = 'ONLINE'
    const media = await window.electronAPI.dayuGetMedia(ip, form.username, form.password)
    if (media.ok) node.playVol = media.value.speakerVolume // canonical 0-9 原始值
    resultOk.value = true
    resultMsg.value = `✅ 已加入 DAYU-OT300（${ip}）${media.ok ? `，音量等級 ${media.value.speakerVolume}/9` : ''}`
  } else {
    resultOk.value = false
    const why = login.reason === 'auth-failed' ? '帳密錯誤'
      : login.reason === 'busy' ? '設備忙碌（nonce 無回應）'
      : '連線失敗'
    resultMsg.value = `⚠️ DAYU 登入失敗（${why}），已以離線狀態加入。`
  }
}

async function handleSubmit() {
  const ip = form.ip.trim()
  if (!IPV4.test(ip)) {
    resultOk.value = false
    resultMsg.value = '❌ 請輸入有效的 IPv4 位址'
    return
  }
  isSubmitting.value = true
  resultMsg.value = ''
  const node = makeNode(ip)
  try {
    if (form.kind === 'dayu-ot300') await submitDayu(node, ip)
    else await submitGt(node, ip)
    emit('added', node)
    setTimeout(() => emit('close'), 900)
  } catch (err) {
    resultOk.value = false
    resultMsg.value = `❌ 加入失敗：${err}`
  } finally {
    isSubmitting.value = false
  }
}
</script>

<style scoped>
.modal-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.7); backdrop-filter: blur(4px); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.modal-card { background: linear-gradient(145deg, #141e35, #0c1324); border: 1px solid rgba(78,222,163,0.2); border-radius: 16px; width: 460px; max-height: 90vh; overflow-y: auto; box-shadow: 0 20px 60px rgba(0,0,0,0.5); }
.modal-header { display: flex; justify-content: space-between; align-items: center; padding: 1.25rem 1.5rem; border-bottom: 1px solid rgba(78,222,163,0.1); }
.modal-header h3 { margin: 0; color: #e0f2e9; font-size: 1.1rem; }
.close-btn { background: none; border: none; color: #8b9dc3; font-size: 1.2rem; cursor: pointer; }
.close-btn:hover { color: #ff5252; }

.device-info { padding: 0.75rem 1.5rem; font-size: 0.82rem; color: #8b9dc3; background: rgba(0,0,0,0.2); }

.form-body { padding: 1rem 1.5rem; display: grid; gap: 0.75rem; }
.form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; }
.form-group { display: flex; flex-direction: column; gap: 4px; }
.form-group label { color: #8b9dc3; font-size: 0.8rem; }
.form-group input, .form-group select { background: rgba(0,0,0,0.3); border: 1px solid rgba(78,222,163,0.2); color: #e0f2e9; padding: 8px 12px; border-radius: 6px; font-size: 0.9rem; }
.form-group input:focus, .form-group select:focus { outline: none; border-color: #4edea3; }

.warning-box { margin: 0 1.5rem; padding: 10px 14px; background: rgba(255,152,0,0.1); border: 1px solid rgba(255,152,0,0.3); border-radius: 8px; color: #ffcc80; font-size: 0.82rem; }

.modal-footer { display: flex; justify-content: flex-end; gap: 12px; padding: 1rem 1.5rem; border-top: 1px solid rgba(78,222,163,0.1); }
.cancel-btn { background: rgba(139,157,195,0.1); border: 1px solid rgba(139,157,195,0.3); color: #8b9dc3; padding: 8px 20px; border-radius: 8px; cursor: pointer; }
.submit-btn { background: linear-gradient(135deg, #4edea3, #3bc991); border: none; color: #0c1324; padding: 8px 24px; border-radius: 8px; cursor: pointer; font-weight: 600; }
.submit-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.submit-btn:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 4px 15px rgba(78,222,163,0.3); }

.result-msg { margin: 0.75rem 1.5rem 1rem; padding: 10px 14px; border-radius: 8px; font-size: 0.85rem; }
.result-msg.success { background: rgba(78,222,163,0.1); border: 1px solid rgba(78,222,163,0.3); color: #4edea3; }
.result-msg.error { background: rgba(255,82,82,0.1); border: 1px solid rgba(255,82,82,0.3); color: #ff5252; }
</style>

<template>
  <div id="app-root">
    <AppLayout
      :current-view="currentView"
      @navigate="handleNavigate"
    >
      <!-- Network Radar (Scan) View -->
      <template v-if="currentView === 'radar'">
        <NetworkRadar
          :is-scanning="isScanning"
          :found="foundCount"
          :elapsed-ms="elapsedMs"
          @start-scan="startScan"
        />
      </template>

      <!-- Device List View -->
      <template v-if="currentView === 'devices'">
        <DeviceTable
          v-if="!selectedDevice"
          :devices="deviceStore.devices"
          :scanning="isScanning"
          @scan="startScan"
          @select="handleSelectDevice"
          @change-ip="handleOpenIpChange"
          @add="showAddDevice = true"
          @rest-scan="showRestScan = true"
          @dayu-scan="showDayuScan = true"
        />
        <DeviceDetail
          v-else-if="selectedDevice.deviceKind === 'gt-sip-gw'"
          :device="selectedDevice"
          @close="handleDetailClose"
          @reconnect="handleReconnect"
        />
        <DayuDetail
          v-else
          :device="selectedDevice"
          @close="handleDetailClose"
        />
      </template>

      <!-- Auto Provisioning View -->
      <template v-if="currentView === 'provision'">
        <AutoProvisionView />
      </template>

    </AppLayout>

    <!-- IP Change Modal -->
    <IpChangeModal
      :visible="ipChangeTarget !== null"
      :device="ipChangeTarget!"
      :duplicate-count="ipChangeTarget ? getIpDuplicateCount(ipChangeTarget.ip) : 0"
      @close="ipChangeTarget = null"
      @success="handleIpChangeSuccess"
      v-if="ipChangeTarget"
    />

    <!-- Reconnect Overlay -->
    <ReconnectOverlay
      v-if="reconnectIp"
      :target-ip="reconnectIp"
      @connected="handleReconnected"
      @timeout="handleReconnectTimeout"
    />

    <!-- Batch Sync Modal -->
    <BatchSyncModal
      :show="showBatchSync"
      :selected-devices="deviceStore.devices.filter(d => getDeviceCapabilities(d.deviceKind).canBatchSyncRest)"
      @close="handleBatchClose"
    />

    <!-- Manual Add Device Modal -->
    <AddDeviceModal
      :visible="showAddDevice"
      @close="showAddDevice = false"
      @added="handleDeviceAdded"
    />

    <!-- REST Discovery Scan Modal -->
    <RestScanModal
      :visible="showRestScan"
      @close="showRestScan = false"
      @found="handleDevicesFound"
    />

    <!-- DAYU-OT300 Fingerprint Scan Modal -->
    <DayuScanModal
      :visible="showDayuScan"
      @close="showDayuScan = false"
      @found="handleDevicesFound"
    />
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useDeviceStore } from '@/stores/devices'
import type { DeviceNode, DeviceStatus } from '@shared/types'
import { getDeviceCapabilities } from '@shared/deviceCapabilities'
import AppLayout from '@/components/AppLayout.vue'
import NetworkRadar from '@/components/NetworkRadar.vue'
import DeviceTable from '@/components/DeviceTable.vue'
import DeviceDetail from '@/components/DeviceDetail.vue'
import DayuDetail from '@/components/DayuDetail.vue'
import IpChangeModal from '@/components/IpChangeModal.vue'
import ReconnectOverlay from '@/components/ReconnectOverlay.vue'
import BatchSyncModal from '@/components/BatchSyncModal.vue'
import AddDeviceModal from '@/components/AddDeviceModal.vue'
import RestScanModal from '@/components/RestScanModal.vue'
import DayuScanModal from '@/components/DayuScanModal.vue'
import AutoProvisionView from '@/components/AutoProvisionView.vue'

const deviceStore = useDeviceStore()

// After discovery, fetch each device's live SIP registration status via REST
// (only reachable / same-subnet devices return it). Runs in the background.
async function enrichRegStatus(devices: DeviceNode[]) {
  // Per device, in parallel — a cross-subnet device's login timeout must not
  // block reachable devices from filling in (different IPs = independent).
  //
  // 走「主行程」REST（Node TLS 放寬 legacy renegotiation）：fresh GT-SIP-GW 韌體的
  // https 不支援 RFC 5746，renderer 的 Chromium 一律握手失敗 → 舊版此處會全「連線
  // 失敗」。改走主行程後才讀得到即時狀態。
  await Promise.all(devices.map(async (d) => {
    if (!getDeviceCapabilities(d.deviceKind).canGtRest) return // DAYU 無 GT REST，打了必失敗且傷其脆弱 web server
    if (!d.ip || !d.mac) return
    let st: DeviceStatus | null = null
    for (let i = 0; i < 6 && !st; i++) st = await window.electronAPI.deviceGetStatus(d.ip)
    if (!st) {
      deviceStore.patchDevice(d.mac, { sipRegStatus: '連線失敗' })
      return
    }
    const pl = st?.sip_status?.primary_line as Record<string, unknown> | undefined
    const patch: Partial<DeviceNode> = { sipRegStatus: pl?.status ? String(pl.status) : '未知' }
    // account = "101@192.168.1.203:5060" — the LIVE registered identity, which
    // overrides the device's stale DBP RegUser (IFCFG-APP 與 primary_line 是兩個
    // 分開的儲存區；DBP 讀 IFCFG-APP，REST /set/sip/primary 只動 primary_line)。
    const account = pl?.account ? String(pl.account) : ''
    const m = account.match(/^([^@]+)@([^:]+)(?::(\d+))?/)
    if (m) {
      patch.regUser = m[1]
      patch.regAddr = m[2]
      if (m[3]) patch.regPort = m[3]
    }
    // Live volume (REST PLAY_VOL/CAP_VOL) overrides the stale DBP OutVol/MicVol
    const di = st?.sip_status?.device_info as Record<string, unknown> | undefined
    if (di) {
      if (di.broadcast_volume != null) patch.outVol = Number(di.broadcast_volume)
      if (di.microphone_volume != null) patch.micVol = Number(di.microphone_volume)
    }
    deviceStore.patchDevice(d.mac, patch)

    // 若尚未註冊（account 空），改讀「已設定」的 primary_line，讓清單顯示我們供裝的
    // 分機/伺服器（101/.203）而非 DBP 舊值，才能確認供裝設定已寫入。
    if (!m) {
      const sip = await window.electronAPI.deviceGetSipConfig(d.ip)
      const cfg = sip?.primary_line
      if (cfg) {
        const p2: Partial<DeviceNode> = {}
        if (cfg.user_id) p2.regUser = String(cfg.user_id)
        if (cfg.server_address) { p2.regAddr = String(cfg.server_address); p2.regPort = String(cfg.server_port || 5060) }
        if (Object.keys(p2).length) deviceStore.patchDevice(d.mac, p2)
      }
    }
  }))
}

// Navigation
const currentView = ref<'radar' | 'devices' | 'provision'>('radar')

function handleNavigate(view: string) {
  if (view === 'batch') {
    // Batch config push acts on the discovered device list
    showBatchSync.value = true
    currentView.value = 'devices'
    return
  }
  if (view === 'radar' || view === 'devices' || view === 'provision') {
    currentView.value = view
    if (view !== 'devices') selectedDevice.value = null
  }
}

// Scanning state — radar runs DBP/1.0 UDP broadcast discovery (finds all subnets)
const isScanning = ref(false)
const foundCount = ref(0)
const elapsedMs = ref(0)

async function startScan() {
  isScanning.value = true
  elapsedMs.value = 0
  foundCount.value = 0
  const startTime = Date.now()

  const interval = setInterval(() => {
    elapsedMs.value = Date.now() - startTime
  }, 100)

  const cleanup = window.electronAPI.onDbpProgress((found) => {
    foundCount.value = found
  })

  try {
    const result = await window.electronAPI.dbpDiscover()
    if (result.success && result.devices) {
      deviceStore.setDevices(result.devices)
      // Auto-switch to device list
      currentView.value = 'devices'
      enrichRegStatus(result.devices) // background: fill SIP registration status
    }
  } catch (err) {
    console.error('DBP discovery failed:', err)
  } finally {
    clearInterval(interval)
    cleanup()
    isScanning.value = false
  }
}

// Device selection
const selectedDevice = ref<DeviceNode | null>(null)

function handleSelectDevice(device: DeviceNode) {
  selectedDevice.value = device
}

// Returning from detail / closing batch sync may have changed config → refresh list
function handleDetailClose() {
  const d = selectedDevice.value
  selectedDevice.value = null
  if (d) enrichRegStatus([d])
}

function handleBatchClose() {
  showBatchSync.value = false
  enrichRegStatus(deviceStore.devices)
}

// IP Change
const ipChangeTarget = ref<DeviceNode | null>(null)

function handleOpenIpChange(device: DeviceNode) {
  ipChangeTarget.value = device
}

function getIpDuplicateCount(ip: string): number {
  return deviceStore.devices.filter(d => d.ip === ip).length
}

function handleIpChangeSuccess(newIp: string) {
  ipChangeTarget.value = null
  reconnectIp.value = newIp
}

// Reconnect
const reconnectIp = ref<string | null>(null)

function handleReconnect(ip: string) {
  reconnectIp.value = ip
}

function handleReconnected() {
  reconnectIp.value = null
  // Re-scan after reconnect
  startScan()
}

function handleReconnectTimeout() {
  reconnectIp.value = null
  alert('⚠️ 設備重連超時，請手動檢查設備狀態。')
}

// Batch Sync
const showBatchSync = ref(false)

// Manual add device (by IP, REST-only devices that DBP scan can't find)
const showAddDevice = ref(false)

function handleDeviceAdded(device: DeviceNode) {
  deviceStore.addDevice(device)
  currentView.value = 'devices'
  enrichRegStatus([device])
}

// REST discovery scan
const showRestScan = ref(false)

// DAYU-OT300 fingerprint scan
const showDayuScan = ref(false)

function handleDevicesFound(devices: DeviceNode[]) {
  for (const d of devices) deviceStore.addDevice(d)
  currentView.value = 'devices'
  enrichRegStatus(devices)
}
</script>

<style>
.placeholder-view {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 60vh;
  color: #8b9dc3;
}
.placeholder-view h3 {
  font-size: 1.5rem;
  margin-bottom: 0.5rem;
  color: #e0f2e9;
}
</style>

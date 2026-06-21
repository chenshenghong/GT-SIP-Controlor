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
          @select="handleSelectDevice"
          @change-ip="handleOpenIpChange"
          @add="showAddDevice = true"
          @rest-scan="showRestScan = true"
        />
        <DeviceDetail
          v-else
          :device="selectedDevice"
          @close="selectedDevice = null"
          @reconnect="handleReconnect"
        />
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
      :selected-devices="deviceStore.devices"
      @close="showBatchSync = false"
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
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useDeviceStore } from '@/stores/devices'
import type { DeviceNode } from '@shared/types'
import { loginToDevice, getDeviceStatus } from '@/composables/deviceApi'
import AppLayout from '@/components/AppLayout.vue'
import NetworkRadar from '@/components/NetworkRadar.vue'
import DeviceTable from '@/components/DeviceTable.vue'
import DeviceDetail from '@/components/DeviceDetail.vue'
import IpChangeModal from '@/components/IpChangeModal.vue'
import ReconnectOverlay from '@/components/ReconnectOverlay.vue'
import BatchSyncModal from '@/components/BatchSyncModal.vue'
import AddDeviceModal from '@/components/AddDeviceModal.vue'
import RestScanModal from '@/components/RestScanModal.vue'

const deviceStore = useDeviceStore()

// After discovery, fetch each device's live SIP registration status via REST
// (only reachable / same-subnet devices return it). Runs in the background.
async function enrichRegStatus(devices: DeviceNode[]) {
  // Per device, in parallel — a cross-subnet device's login timeout must not
  // block reachable devices from filling in (different IPs = independent).
  await Promise.all(devices.map(async (d) => {
    if (!d.ip || !d.mac) return
    let ok = false
    for (let i = 0; i < 2 && !ok; i++) ok = await loginToDevice(d.ip)
    if (!ok) {
      deviceStore.patchDevice(d.mac, { sipRegStatus: '連線失敗' })
      return
    }
    let st: Awaited<ReturnType<typeof getDeviceStatus>> = null
    for (let i = 0; i < 4 && !st; i++) st = await getDeviceStatus(d.ip)
    const pl = st?.sip_status?.primary_line as Record<string, unknown> | undefined
    deviceStore.patchDevice(d.mac, { sipRegStatus: pl?.status ? String(pl.status) : '未知' })
  }))
}

// Navigation
const currentView = ref<'radar' | 'devices'>('radar')

function handleNavigate(view: string) {
  if (view === 'batch') {
    // Batch config push acts on the discovered device list
    showBatchSync.value = true
    currentView.value = 'devices'
    return
  }
  if (view === 'radar' || view === 'devices') {
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

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
          :progress="scanProgress"
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
        />
        <DeviceDetail
          v-else
          :device="selectedDevice"
          @close="selectedDevice = null"
          @reconnect="handleReconnect"
        />
      </template>

      <!-- Traffic Logs View (placeholder) -->
      <template v-if="currentView === 'logs'">
        <div class="placeholder-view">
          <h3>📋 流量日誌</h3>
          <p>此功能將在後續階段實作</p>
        </div>
      </template>

      <!-- Security View (placeholder) -->
      <template v-if="currentView === 'security'">
        <div class="placeholder-view">
          <h3>🔒 安全維運</h3>
          <p>此功能將在後續階段實作</p>
        </div>
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
      v-if="showBatchSync"
      :devices="deviceStore.onlineDevices"
      @close="showBatchSync = false"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useDeviceStore } from '@/stores/devices'
import type { DeviceNode, ScanProgress } from '@shared/types'
import AppLayout from '@/components/AppLayout.vue'
import NetworkRadar from '@/components/NetworkRadar.vue'
import DeviceTable from '@/components/DeviceTable.vue'
import DeviceDetail from '@/components/DeviceDetail.vue'
import IpChangeModal from '@/components/IpChangeModal.vue'
import ReconnectOverlay from '@/components/ReconnectOverlay.vue'
import BatchSyncModal from '@/components/BatchSyncModal.vue'

const deviceStore = useDeviceStore()

// Navigation
const currentView = ref<'radar' | 'devices' | 'logs' | 'security'>('radar')

function handleNavigate(view: string) {
  currentView.value = view as typeof currentView.value
  if (view !== 'devices') {
    selectedDevice.value = null
  }
}

// Scanning state
const isScanning = ref(false)
const scanProgress = ref<ScanProgress>({ currentIp: '', currentIndex: 0, total: 254 })
const elapsedMs = ref(0)

async function startScan() {
  isScanning.value = true
  elapsedMs.value = 0
  const startTime = Date.now()

  const interval = setInterval(() => {
    elapsedMs.value = Date.now() - startTime
  }, 100)

  const cleanup = window.electronAPI.onScanProgress((progress) => {
    scanProgress.value = progress
  })

  try {
    const result = await window.electronAPI.startScan('192.168.1.0')
    if (result.success && result.data) {
      deviceStore.setDevices(result.data.devices)
      elapsedMs.value = result.data.elapsedMs
      // Auto-switch to device list
      currentView.value = 'devices'
    }
  } catch (err) {
    console.error('Scan failed:', err)
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

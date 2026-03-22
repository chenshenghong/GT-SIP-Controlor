<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import AppLayout from '@/components/AppLayout.vue'
import NetworkRadar from '@/components/NetworkRadar.vue'
import DeviceTable from '@/components/DeviceTable.vue'
import BatchSyncModal from '@/components/BatchSyncModal.vue'
import ReconnectOverlay from '@/components/ReconnectOverlay.vue'
import { useDeviceStore } from '@/stores/devices'
import type { DeviceNode } from '@shared/types'

const deviceStore = useDeviceStore()

const currentView = ref('scan')
const showBatchModal = ref(false)
const selectedDevicesForSync = ref<DeviceNode[]>([])

// Reconnect state
const showReconnect = ref(false)
const reconnectTargetIp = ref('')

// Scan timer
const elapsedSeconds = ref(0)
let timerInterval: ReturnType<typeof setInterval> | null = null
let cleanupProgressListener: (() => void) | null = null

async function startScan() {
  deviceStore.startScan()
  elapsedSeconds.value = 0

  // Start timer
  timerInterval = setInterval(() => {
    elapsedSeconds.value++
  }, 1000)

  // Listen for progress events
  cleanupProgressListener = window.electronAPI.onScanProgress((progress) => {
    deviceStore.updateProgress(progress)
  })

  // Invoke scan
  const result = await window.electronAPI.startScan('192.168.1.1')

  // Stop timer
  if (timerInterval) clearInterval(timerInterval)
  timerInterval = null

  if (cleanupProgressListener) {
    cleanupProgressListener()
    cleanupProgressListener = null
  }

  if (result.success && result.data) {
    deviceStore.finishScan(result.data.devices)
    // Auto-switch to device list after scan
    currentView.value = 'devices'
  } else {
    deviceStore.finishScan([])
  }
}

function handleBatchSync(devices: DeviceNode[]) {
  selectedDevicesForSync.value = devices
  showBatchModal.value = true
}

onMounted(() => {
  // Auto-start scan on app launch
  startScan()
})

onUnmounted(() => {
  if (timerInterval) clearInterval(timerInterval)
  if (cleanupProgressListener) cleanupProgressListener()
})
</script>

<template>
  <AppLayout v-model="currentView">
    <!-- Scan View -->
    <NetworkRadar
      v-if="currentView === 'scan'"
      :current-ip="deviceStore.scanProgress?.currentIp || '192.168.1.1'"
      :progress="deviceStore.scanProgress?.currentIndex || 0"
      :is-scanning="deviceStore.isScanning"
      :elapsed-seconds="elapsedSeconds"
    />

    <!-- Device List View -->
    <DeviceTable
      v-if="currentView === 'devices'"
      :devices="deviceStore.devices"
      @batch-sync="handleBatchSync"
    />

    <!-- Placeholder for other views -->
    <div v-if="currentView === 'logs'" class="flex-1 flex items-center justify-center">
      <div class="text-center">
        <span class="material-symbols-outlined text-6xl text-outline-variant mb-4">construction</span>
        <p class="text-on-surface-variant uppercase tracking-widest text-sm">流量日誌模組開發中</p>
      </div>
    </div>

    <div v-if="currentView === 'security'" class="flex-1 flex items-center justify-center">
      <div class="text-center">
        <span class="material-symbols-outlined text-6xl text-outline-variant mb-4">construction</span>
        <p class="text-on-surface-variant uppercase tracking-widest text-sm">安全維運模組開發中</p>
      </div>
    </div>
  </AppLayout>

  <!-- Batch Sync Modal -->
  <BatchSyncModal
    :show="showBatchModal"
    :selected-devices="selectedDevicesForSync"
    @close="showBatchModal = false"
  />

  <!-- Reconnect Overlay -->
  <ReconnectOverlay
    :show="showReconnect"
    :target-ip="reconnectTargetIp"
    @reconnected="showReconnect = false; currentView = 'devices'"
    @timeout="showReconnect = false"
  />
</template>

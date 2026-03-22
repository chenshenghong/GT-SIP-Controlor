// ============================================
// SIP CMS — Device Store (Pinia)
// Stores scanned devices with shallowRef for perf
// ============================================
import { defineStore } from 'pinia'
import { shallowRef, ref } from 'vue'
import type { DeviceNode, ScanProgress } from '@shared/types'

export const useDeviceStore = defineStore('devices', () => {
  // CRITICAL: Use shallowRef for large device arrays to avoid deep reactivity overhead
  const devices = shallowRef<DeviceNode[]>([])
  const isScanning = ref(false)
  const scanProgress = ref<ScanProgress | null>(null)

  function setDevices(list: DeviceNode[]) {
    devices.value = [...list] // Trigger shallowRef reactivity
  }

  function updateDeviceStatus(ip: string, status: DeviceNode['status']) {
    const updated = devices.value.map((d) =>
      d.ip === ip ? { ...d, status } : d
    )
    devices.value = updated
  }

  function startScan() {
    isScanning.value = true
    scanProgress.value = null
  }

  function updateProgress(progress: ScanProgress) {
    scanProgress.value = { ...progress }
  }

  function finishScan(result: DeviceNode[]) {
    isScanning.value = false
    setDevices(result)
  }

  return {
    devices,
    isScanning,
    scanProgress,
    setDevices,
    updateDeviceStatus,
    startScan,
    updateProgress,
    finishScan,
  }
})

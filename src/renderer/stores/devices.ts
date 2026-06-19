// ============================================
// SIP CMS — Device Store (Pinia)
// Stores scanned devices with shallowRef for perf
// ============================================
import { defineStore } from 'pinia'
import { shallowRef, ref, computed } from 'vue'
import type { DeviceNode } from '@shared/types'

export const useDeviceStore = defineStore('devices', () => {
  // shallowRef for large arrays — avoid deep reactivity overhead
  const devices = shallowRef<DeviceNode[]>([])
  const lastScanAt = ref<number | null>(null)

  function setDevices(list: DeviceNode[]) {
    devices.value = [...list] // Trigger shallowRef reactivity
    lastScanAt.value = Date.now()
  }

  /**
   * Add (or merge) a single device — used by manual "add by IP".
   * De-dupes by MAC (fallback IP); merges fields onto an existing entry.
   */
  function addDevice(node: DeviceNode) {
    const match = (d: DeviceNode) =>
      (node.mac && d.mac === node.mac) || (!node.mac && d.ip === node.ip)
    if (devices.value.some(match)) {
      devices.value = devices.value.map((d) => (match(d) ? { ...d, ...node } : d))
    } else {
      devices.value = [...devices.value, node]
    }
  }

  function updateDeviceStatus(mac: string, status: DeviceNode['status']) {
    devices.value = devices.value.map((d) =>
      d.mac === mac ? { ...d, status } : d
    )
  }

  function clearDevices() {
    devices.value = []
  }

  // Computed
  const onlineDevices = computed(() => devices.value.filter(d => d.status === 'ONLINE'))
  const offlineDevices = computed(() => devices.value.filter(d => d.status !== 'ONLINE'))
  const duplicateIps = computed(() => {
    const counts: Record<string, number> = {}
    for (const d of devices.value) {
      counts[d.ip] = (counts[d.ip] || 0) + 1
    }
    return Object.entries(counts).filter(([, c]) => c > 1).map(([ip]) => ip)
  })

  return {
    devices,
    lastScanAt,
    setDevices,
    addDevice,
    updateDeviceStatus,
    clearDevices,
    onlineDevices,
    offlineDevices,
    duplicateIps,
  }
})

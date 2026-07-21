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

  /**
   * 取代整份列表 — 用於 DBP/REST 掃描結果。
   * DAYU-OT300 不會回應 DBP/REST 掃描，永遠不會出現在 list 裡；若直接整包取代，
   * 既有的 DAYU 節點會被靜默清空。因此保留既有 DAYU 節點（掃描結果沒有的那些）。
   */
  function setDevices(list: DeviceNode[]) {
    devices.value = [
      ...list,
      ...devices.value.filter(
        (d) => d.deviceKind === 'dayu-ot300' && !list.some((n) => n.ip === d.ip && n.deviceKind === 'dayu-ot300')
      ),
    ] // Trigger shallowRef reactivity
    lastScanAt.value = Date.now()
  }

  /**
   * Add (or merge) a single device — used by manual "add by IP".
   * De-dupes by MAC (fallback IP)，並要求 deviceKind 相同才視為同一台設備 —
   * 否則 mac='' 的 DAYU 節點會以 IP 命中同 IP 的 GT 節點並覆蓋（deviceKind 被
   * 翻轉、真實 mac 被清空）。
   */
  function addDevice(node: DeviceNode) {
    const match = (d: DeviceNode) =>
      d.deviceKind === node.deviceKind &&
      ((node.mac && d.mac === node.mac) || (!node.mac && d.ip === node.ip))
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

  /** Merge partial fields onto a device (matched by MAC) — used for async enrichment. */
  function patchDevice(mac: string, partial: Partial<DeviceNode>) {
    devices.value = devices.value.map((d) =>
      d.mac === mac ? { ...d, ...partial } : d
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
    patchDevice,
    clearDevices,
    onlineDevices,
    offlineDevices,
    duplicateIps,
  }
})

import { ref, onMounted, watch, unref, type Ref } from 'vue'
import { probeSipMulticastZones } from '@/composables/deviceApi'
import type { MulticastZone } from '@shared/types'

export type ZonesCapability = 'unknown' | 'zones' | 'unsupported' | 'error'

export function useMulticastZonesCapability(ip: Ref<string> | string) {
  const capable = ref<ZonesCapability>('unknown')
  const zones = ref<MulticastZone[] | null>(null)

  async function reprobe(): Promise<void> {
    const targetIp = unref(ip)
    if (!targetIp) return
    capable.value = 'unknown'
    zones.value = null
    const r = await probeSipMulticastZones(targetIp)
    capable.value = r.status
    zones.value = r.status === 'zones' ? r.zones : null
  }

  onMounted(reprobe)
  // DeviceDetail 未 keyed（App.vue 切設備時複用實例）→ 監看 ip 變化重探，避免能力/zones 過期
  watch(() => unref(ip), () => { void reprobe() })
  return { capable, zones, reprobe }
}

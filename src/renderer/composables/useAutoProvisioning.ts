import { createProvisionEngine, type ProvisionDeps } from '@shared/provisionEngine'
import type { ProvisionConfig, ProvisionRegistryFile } from '@shared/types'
import { useProvisioningStore } from '@/stores/provisioning'

export function useAutoProvisioning() {
  const store = useProvisioningStore()
  let engine: ReturnType<typeof createProvisionEngine> | null = null

  async function start(config: ProvisionConfig): Promise<void> {
    store.reset()
    store.config = config
    // 啟動時把 config 併入登記表持久化（保留既有 records）
    const read = await window.electronAPI.readRegistry()
    const existing: ProvisionRegistryFile = read.success && read.data ? read.data : { config: null, records: [] }
    await window.electronAPI.writeRegistry({ config, records: existing.records })

    const deps: ProvisionDeps = {
      discover: async () => {
        const r = await window.electronAPI.dbpDiscover()
        return r.success && r.devices ? r.devices : []
      },
      changeIp: (req) => window.electronAPI.changeIp(req),
      ensureReachable: async (ip) => { await window.electronAPI.ensureReachable(ip) },
      // REST 走主行程（Node TLS 放寬 legacy renegotiation；renderer 的 Chromium
      // 對不支援 RFC 5746 重協商的 fresh 韌體 https 會直接握手失敗）
      getSipConfig: (ip) => window.electronAPI.deviceGetSipConfig(ip),
      setSipPrimary: (ip, cfg) => window.electronAPI.deviceSetSipPrimary(ip, cfg),
      loadRegistry: async () => {
        const res = await window.electronAPI.readRegistry()
        return res.success && res.data ? res.data : { config, records: [] }
      },
      saveRegistry: async (data) => {
        const res = await window.electronAPI.writeRegistry(data)
        if (!res.success) throw new Error(res.error ?? 'registry write failed')
      },
      now: () => Date.now(),
      emit: (e) => store.applyEvent(e),
    }
    engine = createProvisionEngine(config, deps)
    store.setRunning(true)
    await engine.start()
  }

  function stop(): void {
    engine?.stop()
    engine = null
    store.setRunning(false)
  }

  /** 手動重試一台失敗設備（沿用原分配，下一輪掃描重跑）。 */
  function retry(mac: string): void {
    engine?.retry(mac)
  }

  return { start, stop, retry }
}

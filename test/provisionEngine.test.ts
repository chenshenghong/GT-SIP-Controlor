import { createProvisionEngine, createLimiter, type ProvisionDeps } from '@shared/provisionEngine'
import type { DeviceNode, IpChangeRequest, ProvisionConfig, ProvisionRegistryFile, SipConfig, SipConfigResponse } from '@shared/types'

const cfg: ProvisionConfig = {
  ipStart: '192.168.1.101', ipEnd: '192.168.1.110',
  mask: '255.255.255.0', gateway: '192.168.1.1',
  extStart: 8001, extEnd: 8010,
  sipPassword: 'pw', sipServer: '192.168.1.10', sipPort: 5060, namePrefix: 'GT-',
}

function dev(mac: string, ip: string, regUser = ''): DeviceNode {
  return { id: 1, type: 'SIP', mac, sn: '', name: '', hostName: '', ip, mask: '', gateway: '',
    autoIp: 0, dns1: '', dns2: '', useDns: 0, server: '', server2: '', mode: '', isBroadcast: 1,
    version: '', playVol: 50, captureVol: 50, treble: 0, bass: 0, tbAgc: 4, tbLinein: 0, group: 9999,
    speed: 0, encrypt: 0, reboot: '', website: '', svcConfig: '', localSet: '', regUser,
    status: 'ONLINE' } as DeviceNode
}

const sipResp: SipConfigResponse = {
  primary_line: { server_address: '', server_port: 5060, user_id: '', password: '',
    auto_answer: false, register_timeout: 3600, transport_protocol: 'UDP' },
  multicast_config: { multicast_address: '', multicast_port: 0, enabled: false, audio_codec: '' },
  sip_parameters: { local_port: 5060, rtp_start_port: 0, rtp_end_port: 0, rtp_timeout: 0, echo_cancellation: false },
  audio_codecs: { g722: true, opus: false, g711_ulaw: true, g711_alaw: true },
}

function makeDeps(over: Partial<ProvisionDeps> & { clock?: { t: number } }): ProvisionDeps {
  const store: ProvisionRegistryFile = { config: null, records: [] }
  const clock = over.clock ?? { t: 1_000_000 }
  return {
    discover: over.discover ?? (async () => []),
    changeIp: over.changeIp ?? (async () => ({ success: true })),
    ensureReachable: over.ensureReachable ?? (async () => {}),
    getSipConfig: over.getSipConfig ?? (async () => sipResp),
    setSipPrimary: over.setSipPrimary ?? (async () => true),
    loadRegistry: over.loadRegistry ?? (async () => store),
    saveRegistry: over.saveRegistry ?? (async (d) => { store.records = d.records }),
    now: over.now ?? (() => clock.t),
    emit: over.emit ?? (() => {}),
  }
}

describe('createLimiter', () => {
  it('併發不超過上限', async () => {
    const limiter = createLimiter(2)
    let active = 0, peak = 0
    const task = () => limiter.submit(async () => {
      active++; peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 5)); active--
    })
    await Promise.all([task(), task(), task(), task()])
    expect(peak).toBeLessThanOrEqual(2)
  })
})

describe('provisionEngine', () => {
  it('新設備：改 IP → 下一輪認回 → 設 SIP → done', async () => {
    const changeIp = jest.fn<Promise<{ success: boolean }>, [IpChangeRequest]>(async () => ({ success: true }))
    const setSip = jest.fn<Promise<boolean>, [string, SipConfig]>(async () => true)
    const seq = [[dev('AA', '192.168.0.50')], [dev('AA', '192.168.1.101')]]
    let round = 0
    const deps = makeDeps({ discover: async () => seq[round++] ?? [], changeIp, setSipPrimary: setSip })
    const eng = createProvisionEngine(cfg, deps)
    await eng.runRound() // 發現 AA → changeIp(→.101, name GT-8001) → waiting_online
    expect(changeIp).toHaveBeenCalledTimes(1)
    expect(changeIp.mock.calls[0][0]).toMatchObject({ newIp: '192.168.1.101', newName: 'GT-8001' })
    await eng.runRound() // AA 以 .101 回來 → 設 SIP → done
    expect(setSip).toHaveBeenCalledTimes(1)
    expect(setSip.mock.calls[0][1]).toMatchObject({ user_id: '8001', password: 'pw', server_address: '192.168.1.10', server_port: 5060 })
    expect(eng.getTasks().find((t) => t.mac === 'AA')?.status).toBe('done')
  })

  it('登記表已 provisioned 且 regUser 相符 → 跳過', async () => {
    const store: ProvisionRegistryFile = { config: null, records: [
      { mac: 'BB', assignedIp: '192.168.1.101', assignedExt: 8001, status: 'provisioned', updatedAt: '' }] }
    const changeIp = jest.fn(async () => ({ success: true }))
    const deps = makeDeps({ discover: async () => [dev('BB', '192.168.1.101', '8001')],
      loadRegistry: async () => store, changeIp })
    const eng = createProvisionEngine(cfg, deps)
    await eng.runRound()
    expect(changeIp).not.toHaveBeenCalled()
    expect(eng.getTasks().find((t) => t.mac === 'BB')?.status).toBe('skipped')
  })

  it('crash 真空：status=pending 但 regUser 已相符 → 補標 provisioned、跳過', async () => {
    const store: ProvisionRegistryFile = { config: null, records: [
      { mac: 'CC', assignedIp: '192.168.1.101', assignedExt: 8001, status: 'pending', updatedAt: '' }] }
    const setSip = jest.fn(async () => true)
    const deps = makeDeps({ discover: async () => [dev('CC', '192.168.1.101', '8001')],
      loadRegistry: async () => store, setSipPrimary: setSip })
    const eng = createProvisionEngine(cfg, deps)
    await eng.runRound()
    expect(setSip).not.toHaveBeenCalled()
    expect(store.records[0].status).toBe('provisioned')
    expect(eng.getTasks().find((t) => t.mac === 'CC')?.status).toBe('skipped')
  })

  it('恢復出廠：登記表有但 regUser 不符 → 沿用原分配重供裝、不取新號', async () => {
    const store: ProvisionRegistryFile = { config: null, records: [
      { mac: 'DD', assignedIp: '192.168.1.105', assignedExt: 8005, status: 'provisioned', updatedAt: '' }] }
    const changeIp = jest.fn<Promise<{ success: boolean }>, [IpChangeRequest]>(async () => ({ success: true }))
    // DD 現在 IP 就是原分配 .105（已在正確 IP），regUser 空 → 跳過改 IP、直接設 SIP
    const setSip = jest.fn<Promise<boolean>, [string, SipConfig]>(async () => true)
    const deps = makeDeps({ discover: async () => [dev('DD', '192.168.1.105', '')],
      loadRegistry: async () => store, changeIp, setSipPrimary: setSip })
    const eng = createProvisionEngine(cfg, deps)
    await eng.runRound()
    expect(changeIp).not.toHaveBeenCalled() // 已在分配 IP → 免改 IP
    expect(setSip.mock.calls[0][1]).toMatchObject({ user_id: '8005' }) // 沿用原分機
  })

  it('waiting_online 逾時：改 IP 後設備不再出現、超過 120s → failed', async () => {
    const clock = { t: 1_000_000 }
    const changeIp = jest.fn(async () => ({ success: true }))
    let round = 0
    const deps = makeDeps({ clock,
      discover: async () => (round++ === 0 ? [dev('EE', '192.168.0.50')] : []), changeIp })
    const eng = createProvisionEngine(cfg, deps)
    await eng.runRound() // → waiting_online, deadline = t + 120000
    clock.t += 121_000
    await eng.runRound() // 設備缺席且逾時 → failed
    expect(eng.getTasks().find((t) => t.mac === 'EE')?.status).toBe('failed')
  })

  it('IP 池用盡 → 暫停並發 paused 事件', async () => {
    const smallCfg: ProvisionConfig = { ...cfg, ipStart: '192.168.1.101', ipEnd: '192.168.1.101', extStart: 8001, extEnd: 8001 }
    const store: ProvisionRegistryFile = { config: null, records: [
      { mac: 'X', assignedIp: '192.168.1.101', assignedExt: 8001, status: 'provisioned', updatedAt: '' }] }
    const events: string[] = []
    const deps = makeDeps({ discover: async () => [dev('YY', '192.168.0.60')],
      loadRegistry: async () => store, emit: (e) => { if (e.kind === 'paused') events.push(e.reason) } })
    const eng = createProvisionEngine(smallCfg, deps)
    await eng.runRound()
    expect(eng.isPaused()).toBe(true)
    expect(events.length).toBeGreaterThan(0)
  })
})

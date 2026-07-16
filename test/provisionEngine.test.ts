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

  // 回歸（adversarial finding 1）：設備在「跨越 deadline 的那一輪」帶正確 IP 回來，
  // 認回必須排在逾時 sweep 之前——健康設備不可被誤判 failed，且要完成 SIP 設定。
  it('逾時窗口認回：改 IP 後恰在 deadline 後帶正確 IP 回來 → done 而非 failed', async () => {
    const clock = { t: 1_000_000 }
    const setSip = jest.fn<Promise<boolean>, [string, SipConfig]>(async () => true)
    let round = 0
    const deps = makeDeps({ clock, setSipPrimary: setSip,
      discover: async () => (round++ === 0 ? [dev('FF', '192.168.0.50')] : [dev('FF', '192.168.1.101')]) })
    const eng = createProvisionEngine(cfg, deps)
    await eng.runRound() // → waiting_online, deadline = t + 120000
    clock.t += 121_000    // 已過 deadline
    await eng.runRound() // FF 帶正確 IP .101 回來：先認回 → 設 SIP → done（不得被逾時誤判）
    expect(setSip).toHaveBeenCalledTimes(1)
    expect(eng.getTasks().find((t) => t.mac === 'FF')?.status).toBe('done')
  })

  // 回歸（adversarial finding 2）：retry 清掉 failed 任務，下一輪沿用原分配重供裝。
  // 預置登記表讓 GG 已在分配 IP .105（規則3、免改 IP、直接設 SIP）。
  it('retry：失敗後重試 → 下一輪沿用原分配重跑並完成', async () => {
    const clock = { t: 1_000_000 }
    const store: ProvisionRegistryFile = { config: null, records: [
      { mac: 'GG', assignedIp: '192.168.1.105', assignedExt: 8005, status: 'failed', updatedAt: '' }] }
    let sipOk = false
    const setSip = jest.fn<Promise<boolean>, [string, SipConfig]>(async () => sipOk)
    const deps = makeDeps({ clock, discover: async () => [dev('GG', '192.168.1.105', '')],
      loadRegistry: async () => store, setSipPrimary: setSip,
      saveRegistry: async (d) => { store.records = d.records } })
    const eng = createProvisionEngine(cfg, deps)
    await eng.runRound() // 規則3 免改IP → SIP 失敗 → 開重試窗、退回 waiting_online
    clock.t += 130_000    // 超過 deadline，讓自動重試收斂為 failed
    await eng.runRound() // 再試仍失敗 → 過 deadline → failed
    expect(eng.getTasks().find((t) => t.mac === 'GG')?.status).toBe('failed')
    sipOk = true          // 修好 SIP server 後
    eng.retry('GG')       // 手動重試 → 清 failed 任務
    await eng.runRound() // 下一輪沿用登記表 .105/8005 重跑 → done
    expect(eng.getTasks().find((t) => t.mac === 'GG')?.status).toBe('done')
    // 沿用原分機，未重新取號
    expect(setSip.mock.calls.at(-1)?.[1]).toMatchObject({ user_id: '8005' })
  })

  // 工廠預設 IP 保護：只對現況 IP == 工廠預設的新設備供裝，既有現役設備不碰。
  it('工廠預設 IP 保護：只有在 .200 的新設備被供裝，.101 現役設備被略過', async () => {
    const gatedCfg: ProvisionConfig = { ...cfg, factoryDefaultIp: '192.168.1.200' }
    const changeIp = jest.fn<Promise<{ success: boolean }>, [IpChangeRequest]>(async () => ({ success: true }))
    // 同輪：FRESH 在工廠預設 .200；LIVE 是既有設備在 .101（範圍內、非工廠預設）
    const deps = makeDeps({ changeIp,
      discover: async () => [dev('FRESH', '192.168.1.200'), dev('LIVE', '192.168.1.101', '')] })
    const eng = createProvisionEngine(gatedCfg, deps)
    await eng.runRound()
    // 只有 FRESH 被改 IP（供裝）；LIVE 完全沒被碰
    expect(changeIp).toHaveBeenCalledTimes(1)
    expect(changeIp.mock.calls[0][0].device.mac).toBe('FRESH')
    expect(eng.getTasks().some((t) => t.mac === 'LIVE')).toBe(false)
  })

  // 未設工廠預設 IP → 維持原行為（對任何新設備供裝）。
  it('未設工廠預設 IP：任何新設備都供裝（向後相容）', async () => {
    const changeIp = jest.fn<Promise<{ success: boolean }>, [IpChangeRequest]>(async () => ({ success: true }))
    const deps = makeDeps({ changeIp, discover: async () => [dev('ANY', '192.168.9.9')] })
    const eng = createProvisionEngine(cfg, deps) // cfg 無 factoryDefaultIp
    await eng.runRound()
    expect(changeIp).toHaveBeenCalledTimes(1)
  })

  // SIP 未就緒自動重試：設備改 IP 重開後 web 慢起，首輪設 SIP 失敗應自動隔輪重試、
  // 撐過 web 啟動而非立刻判死（全自動、免手動重試）。
  it('SIP 未就緒自動重試：先失敗一輪、下一輪成功 → done', async () => {
    const clock = { t: 1_000_000 }
    let sipCalls = 0
    const setSip = jest.fn<Promise<boolean>, [string, SipConfig]>(async () => { sipCalls++; return sipCalls >= 2 })
    const seq = [[dev('AA', '192.168.0.50')], [dev('AA', '192.168.1.101')], [dev('AA', '192.168.1.101')]]
    let round = 0
    const deps = makeDeps({ clock, setSipPrimary: setSip, discover: async () => seq[round++] ?? [] })
    const eng = createProvisionEngine(cfg, deps)
    await eng.runRound() // changeIp → waiting_online（deadline t+120000）
    clock.t += 3000
    await eng.runRound() // 認回 → 設 SIP 第1次失敗 → 退回 waiting_online（仍在 deadline 內）
    expect(eng.getTasks().find((t) => t.mac === 'AA')?.status).toBe('waiting_online')
    clock.t += 3000
    await eng.runRound() // 再認回 → 設 SIP 第2次成功 → done
    expect(setSip).toHaveBeenCalledTimes(2)
    expect(eng.getTasks().find((t) => t.mac === 'AA')?.status).toBe('done')
  })

  // 逾時上限：SIP 一直失敗且超過 deadline → 最終 failed（不無限重試）。
  it('SIP 一直失敗且過 deadline → 最終 failed', async () => {
    const clock = { t: 1_000_000 }
    const setSip = jest.fn<Promise<boolean>, [string, SipConfig]>(async () => false)
    const deps = makeDeps({ clock, setSipPrimary: setSip,
      discover: async () => [dev('AA', '192.168.1.101', '')],
      loadRegistry: async () => ({ config: null, records: [
        { mac: 'AA', assignedIp: '192.168.1.101', assignedExt: 8001, status: 'failed', updatedAt: '' }] }) })
    const eng = createProvisionEngine(cfg, deps)
    await eng.runRound()      // 規則3 免改IP → 設 SIP 失敗 → 開重試窗、退回 waiting_online
    clock.t += 130_000        // 超過 deadline
    await eng.runRound()      // 再認回設 SIP 失敗 → 過 deadline → failed
    expect(eng.getTasks().find((t) => t.mac === 'AA')?.status).toBe('failed')
  })

  // 回歸（adversarial finding 5）：注入的網路 dep 拋例外時，任務轉 failed 而非永久卡住。
  it('dep 拋例外：configureSip 例外 → failed，不永久卡在 sip_configuring', async () => {
    const store: ProvisionRegistryFile = { config: null, records: [
      { mac: 'HH', assignedIp: '192.168.1.105', assignedExt: 8005, status: 'pending', updatedAt: '' }] }
    const deps = makeDeps({ discover: async () => [dev('HH', '192.168.1.105', '')],
      loadRegistry: async () => store, saveRegistry: async (d) => { store.records = d.records },
      getSipConfig: async () => { throw new Error('boom') } })
    const eng = createProvisionEngine(cfg, deps)
    await eng.runRound() // 規則3 → 免改IP → configureSip → getSipConfig 拋例外 → failed
    expect(eng.getTasks().find((t) => t.mac === 'HH')?.status).toBe('failed')
  })
})

import type {
  DeviceNode, IpChangeRequest, ProvisionConfig, ProvisionEvent,
  ProvisionRegistryFile, ProvisionTask, SipConfig, SipConfigResponse,
} from './types'
import { allocate, poolUsage } from './provisionAllocator'

export const ONLINE_TIMEOUT_MS = 120_000
export const ROUND_MIN_MS = 5_000
const MAX_CONCURRENT = 5

/** 小型併發閘：submit 個別 thunk，最多 max 個同時執行，其餘排隊。 */
export function createLimiter(max: number) {
  let active = 0
  const queue: Array<() => void> = []
  const pump = () => {
    if (active >= max || queue.length === 0) return
    active++
    const run = queue.shift()!
    run()
  }
  function submit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        fn().then(resolve, reject).finally(() => { active--; pump() })
      })
      pump()
    })
  }
  return { submit }
}

export interface ProvisionDeps {
  discover: () => Promise<DeviceNode[]>
  changeIp: (req: IpChangeRequest) => Promise<{ success: boolean; error?: string }>
  ensureReachable: (ip: string) => Promise<void>
  getSipConfig: (ip: string) => Promise<SipConfigResponse | null>
  setSipPrimary: (ip: string, cfg: SipConfig) => Promise<boolean>
  loadRegistry: () => Promise<ProvisionRegistryFile>
  saveRegistry: (data: ProvisionRegistryFile) => Promise<void>
  now: () => number
  emit: (e: ProvisionEvent) => void
}

const DEFAULT_SIP: Omit<SipConfig, 'server_address' | 'server_port' | 'user_id' | 'password'> = {
  auto_answer: false, register_timeout: 3600, transport_protocol: 'UDP',
}

export function createProvisionEngine(config: ProvisionConfig, deps: ProvisionDeps) {
  const tasks = new Map<string, ProvisionTask>()
  const limiter = createLimiter(MAX_CONCURRENT)
  let registry: ProvisionRegistryFile = { config, records: [] }
  let loaded = false
  let paused = false
  let stopped = false
  let round = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  const iso = () => new Date(deps.now()).toISOString()
  const log = (message: string) => deps.emit({ kind: 'log', ts: deps.now(), message })
  const pushTask = (t: ProvisionTask) => { tasks.set(t.mac, t); deps.emit({ kind: 'task', task: { ...t } }) }
  const emitPool = () => {
    const u = poolUsage(config, registry.records)
    deps.emit({ kind: 'pool', ipUsed: u.ipUsed, ipTotal: u.ipTotal, extUsed: u.extUsed, extTotal: u.extTotal })
  }

  async function persist() {
    try {
      await deps.saveRegistry(registry)
    } catch (e) {
      deps.emit({ kind: 'degraded', reason: String(e) })
      log(`⚠️ 登記表寫入失敗，進入降級模式（進度可能無法保存，重開 App 後可能重複供裝）：${String(e)}`)
    }
  }

  function recordFor(mac: string) {
    return registry.records.find((r) => r.mac === mac)
  }

  async function setRecord(mac: string, patch: Partial<ProvisionRegistryFile['records'][number]>) {
    const rec = recordFor(mac)
    if (rec) Object.assign(rec, patch, { updatedAt: iso() })
    await persist()
  }

  function failTask(mac: string, error: string) {
    const t = tasks.get(mac)
    if (t) { t.status = 'failed'; t.error = error; pushTask(t) }
    log(`❌ ${mac} 供裝失敗：${error}`)
  }

  /** 對某分配 IP，是否被「其他 MAC」的在線設備佔用（本輪掃描）。 */
  function ipTakenByOther(ip: string, selfMac: string, devices: DeviceNode[]): boolean {
    return devices.some((d) => d.ip === ip && d.mac !== selfMac)
  }

  async function configureSip(mac: string, ip: string, ext: number) {
    try {
      await deps.ensureReachable(ip)
      const cur = await deps.getSipConfig(ip)
      const base = cur?.primary_line
      const merged: SipConfig = {
        auto_answer: base?.auto_answer ?? DEFAULT_SIP.auto_answer,
        register_timeout: base?.register_timeout ?? DEFAULT_SIP.register_timeout,
        transport_protocol: base?.transport_protocol ?? DEFAULT_SIP.transport_protocol,
        server_address: config.sipServer,
        server_port: config.sipPort,
        user_id: String(ext),
        password: config.sipPassword,
      }
      const ok = await deps.setSipPrimary(ip, merged)
      if (ok) {
        const t = tasks.get(mac)
        if (t) { t.status = 'done'; pushTask(t) }
        await setRecord(mac, { status: 'provisioned', lastError: undefined })
        log(`✅ ${mac} 供裝完成（IP ${ip}、分機 ${ext}）`)
      } else {
        failTask(mac, 'SIP 設定回報失敗')
        await setRecord(mac, { status: 'failed', lastError: 'SIP 設定回報失敗' })
      }
    } catch (e) {
      // 防禦性：任一注入的網路 dep 若拋例外，轉為 failed，避免任務永久卡在 sip_configuring
      failTask(mac, `SIP 設定例外：${String(e)}`)
      await setRecord(mac, { status: 'failed', lastError: String(e) })
    }
  }

  /** 開始一台的供裝（回傳要交給 limiter 的 thunk）。 */
  function beginProvision(d: DeviceNode, ip: string, ext: number): () => Promise<void> {
    pushTask({ mac: d.mac, ip: d.ip, assignedIp: ip, assignedExt: ext, status: 'ip_assigning' })
    return async () => {
      if (stopped) return
      try {
        // 已在分配 IP（重供裝場景）→ 免改 IP，直接設 SIP
        if (d.ip === ip) {
          const t = tasks.get(d.mac); if (t) { t.status = 'sip_configuring'; pushTask(t) }
          await configureSip(d.mac, ip, ext)
          return
        }
        const newName = config.namePrefix + ext
        log(`→ ${d.mac} 改 IP ${d.ip} → ${ip}（名稱 ${newName}），設備將重開機`)
        const res = await deps.changeIp({ device: d, newIp: ip, newMask: config.mask, newGateway: config.gateway, autoIp: 0, newName })
        if (stopped) return
        if (res.success) {
          const t = tasks.get(d.mac)
          if (t) { t.status = 'waiting_online'; t.deadline = deps.now() + ONLINE_TIMEOUT_MS; pushTask(t) }
        } else {
          failTask(d.mac, `IP 設定失敗：${res.error ?? '未知'}`)
          await setRecord(d.mac, { status: 'failed', lastError: res.error })
        }
      } catch (e) {
        // 防禦性：changeIp 若拋例外，轉為 failed，避免任務永久卡在 ip_assigning
        failTask(d.mac, `改 IP 例外：${String(e)}`)
        await setRecord(d.mac, { status: 'failed', lastError: String(e) })
      }
    }
  }

  /** 對單台設備做判定，回傳要執行的 thunk 或 null（判定本身同步取號、避免競態）。 */
  async function decide(d: DeviceNode, devices: DeviceNode[]): Promise<(() => Promise<void>) | null> {
    if (!d.mac) return null
    const existing = tasks.get(d.mac)
    if (existing) {
      if (existing.status === 'ip_assigning' || existing.status === 'sip_configuring') return null // 忙碌中
      if (existing.status === 'waiting_online') {
        if (d.ip === existing.assignedIp) { // 以新 IP 認回
          existing.status = 'sip_configuring'; existing.ip = d.ip; pushTask(existing)
          return () => configureSip(d.mac, existing.assignedIp, existing.assignedExt)
        }
        return null // 仍在等待
      }
      if (existing.status === 'done' || existing.status === 'skipped') return null
      // failed → 允許本輪不自動重試（交由手動重試）；避免無限重跑
      if (existing.status === 'failed') return null
    }

    const rec = recordFor(d.mac)
    // 規則 2：現況已相符 → 跳過（不看 status，補標 provisioned，堵 crash 真空）
    if (rec && d.regUser && d.regUser === String(rec.assignedExt)) {
      if (rec.status !== 'provisioned') await setRecord(d.mac, { status: 'provisioned', lastError: undefined })
      pushTask({ mac: d.mac, ip: d.ip, assignedIp: rec.assignedIp, assignedExt: rec.assignedExt, status: 'skipped' })
      return null
    }
    // 規則 3：登記表有但現況不符 → 沿用原分配重供裝
    if (rec) {
      if (d.ip !== rec.assignedIp && ipTakenByOther(rec.assignedIp, d.mac, devices)) {
        pushTask({ mac: d.mac, ip: d.ip, assignedIp: rec.assignedIp, assignedExt: rec.assignedExt, status: 'ip_assigning' })
        failTask(d.mac, `分配 IP ${rec.assignedIp} 已被其他設備佔用`)
        return null
      }
      return beginProvision(d, rec.assignedIp, rec.assignedExt)
    }
    // 規則 4：新設備 → 取號 + 佔位
    const alloc = allocate(config, registry.records, new Set(devices.map((x) => x.ip).filter(Boolean)))
    if (!alloc) {
      if (!paused) { paused = true; deps.emit({ kind: 'paused', reason: '號碼池已用盡，供裝暫停' }); log('⏸ 號碼池已用盡，暫停對新設備派工') }
      return null
    }
    registry.records.push({ mac: d.mac, assignedIp: alloc.ip, assignedExt: alloc.ext, status: 'pending', updatedAt: iso() })
    await persist()
    emitPool()
    log(`＋ 發現新設備 ${d.mac} → 分配 IP ${alloc.ip}、分機 ${alloc.ext}`)
    return beginProvision(d, alloc.ip, alloc.ext)
  }

  async function runRound(): Promise<void> {
    if (!loaded) {
      const persisted = await deps.loadRegistry()
      registry = { config, records: persisted.records ?? [] }
      loaded = true
      emitPool()
    }
    round++
    deps.emit({ kind: 'round', round })
    const devices = await deps.discover()

    // 1. 逐台判定（同步取號避免競態），收集要執行的網路動作。
    //    waiting_online 的認回也在此發生：帶正確分配 IP 回來的任務會「同步」轉入
    //    sip_configuring，因此下一步的逾時 sweep 不會再把它們當成未上線。
    const actions: Array<() => Promise<void>> = []
    for (const d of devices) {
      const action = await decide(d, devices)
      if (action) actions.push(action)
    }

    // 2. 逾時檢查（**排在認回之後**）：只有本輪認回後「仍」停在 waiting_online
    //    （設備缺席、或回來但 IP 不等於分配值）且超過 deadline 者才判 failed。
    //    這修正了「重開機恰好落在 deadline 窗口、已帶正確 IP 回來的健康設備被誤判失敗」。
    const now = deps.now()
    for (const t of tasks.values()) {
      if (t.status === 'waiting_online' && t.deadline !== undefined && now > t.deadline) {
        failTask(t.mac, '改 IP 後未在時限內上線')
        await setRecord(t.mac, { status: 'failed', lastError: '改 IP 後未在時限內上線' })
      }
    }

    // 3. 併發閘執行網路動作（上限 5）；等本輪動作全部落定
    await Promise.all(actions.map((a) => limiter.submit(a)))
  }

  async function loop(): Promise<void> {
    if (stopped) return
    const started = deps.now()
    try {
      await runRound()
    } catch (e) {
      log(`⚠️ 掃描輪發生例外：${String(e)}`)
    }
    if (stopped) return
    const elapsed = deps.now() - started
    const wait = Math.max(0, ROUND_MIN_MS - elapsed)
    timer = setTimeout(() => { void loop() }, wait)
  }

  async function start(): Promise<void> {
    stopped = false
    void loop()
  }

  function stop(): void {
    stopped = true
    if (timer) { clearTimeout(timer); timer = null }
    // 進行中的 waiting_online 任務視為中止（保留登記表 pending，重啟後由判定接手）
    for (const t of tasks.values()) {
      if (t.status === 'waiting_online' || t.status === 'ip_assigning') {
        t.status = 'failed'; t.error = '供裝已停止'; pushTask(t)
      }
    }
    log('⏹ 供裝已停止')
  }

  /**
   * 手動重試一台失敗的設備：清掉其 failed 任務，讓下一輪掃描由 decide 規則2/3
   * 依登記表**沿用原分配 IP/分機**重新供裝（不重新取號）。設備需仍能被掃描到。
   */
  function retry(mac: string): void {
    const t = tasks.get(mac)
    if (!t || t.status !== 'failed') return
    tasks.delete(mac)
    log(`🔁 ${mac} 已排入重試，將於下一輪掃描沿用原分配重新供裝`)
    // 通知 UI 該列進入「待重試」狀態（下一輪認回後會轉 ip_assigning/sip_configuring）
    deps.emit({ kind: 'task', task: { ...t, status: 'discovered', error: undefined } })
  }

  return {
    runRound,
    start,
    stop,
    retry,
    getTasks: () => Array.from(tasks.values()).map((t) => ({ ...t })),
    isPaused: () => paused,
  }
}

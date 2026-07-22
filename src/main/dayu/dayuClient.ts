// ============================================
// SIP CMS — DAYU-OT300 協定 client（MAIN process）
//
// 為什麼隔離在 main：需手動操縱 cookie（renderer fetch 做不到跨源帶自訂
// Cookie）、且 Rapid Logic web server 脆弱，需 per-IP 序列化＋最小間隔
// （dayuQueue.ts）。協定事實全部來自實機驗證（Obsidian「DAYU-OT300
// HTTP API 批次管理」）：
//   1. GET /key==nonce?now=<ms> 取 nonce（過載時回空 body → 等待重試）
//   2. 必須把 nonce 設為 `auth` cookie（漏這步 server 只回登入頁）
//   3. POST / 送 encoded=<user>:md5(<user>:<pass>:<nonce>)
// Phase 2 起寫入面在 dayuWrite.ts（本檔維持讀取與 session/傳輸原語）；
// 仍嚴禁在此檔直接 POST 設定表單。
// ============================================
import * as http from 'http'
import * as crypto from 'crypto'
import type { DayuResult, DayuMediaInfo } from '@shared/types'
import { enqueueDayu } from './dayuQueue'
import { gbkDecode, gbkFormEncode } from './gbk'
import { checkDayuHealth, reportDayuFailure, reportDayuSuccess, backoffDetail } from './dayuHealth'

export interface DayuSession {
  ip: string
  port: number
  cookie: string
}

export interface RawResp {
  code: number
  headers: http.IncomingHttpHeaders
  body: string
}

export function rawGet(
  ip: string, port: number, path: string, cookie?: string, timeoutMs = 4000
): Promise<RawResp> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {}
    if (cookie) headers['Cookie'] = cookie
    const req = http.request(
      { host: ip, port, path, method: 'GET', headers, timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({ code: res.statusCode ?? 0, headers: res.headers, body: gbkDecode(Buffer.concat(chunks)) })
        )
      }
    )
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    req.end()
  })
}

/** 有序欄位 POST（GBK percent-encode body；表單回帶用） */
export function rawPostFields(
  ip: string, port: number, path: string, fields: Array<[string, string]>,
  cookie?: string, referer?: string, timeoutMs = 6000
): Promise<RawResp> {
  return new Promise((resolve, reject) => {
    const data = gbkFormEncode(fields)
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': String(data.length),
    }
    if (cookie) headers['Cookie'] = cookie
    if (referer) headers['Referer'] = referer
    const req = http.request(
      { host: ip, port, path, method: 'POST', headers, timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({ code: res.statusCode ?? 0, headers: res.headers, body: gbkDecode(Buffer.concat(chunks)) })
        )
      }
    )
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    req.write(data)
    req.end()
  })
}

export function rawPostForm(
  ip: string, port: number, path: string, form: Record<string, string>, cookie?: string, timeoutMs = 6000
): Promise<RawResp> {
  return rawPostFields(ip, port, path, Object.entries(form), cookie, undefined, timeoutMs)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function isLoginPage(body: string): boolean {
  return /<title>\s*Login\s*<\/title>/i.test(body)
}

/**
 * 登入：nonce → auth cookie → MD5 POST。
 * nonce 空 body（設備過載）重試 3 次、間隔 2s。
 */
export async function dayuLogin(
  ip: string, username = 'admin', password = 'admin', port = 80
): Promise<DayuResult<DayuSession>> {
  let nonce = ''
  try {
    for (let i = 0; i < 3; i++) {
      const r = await rawGet(ip, port, `/key==nonce?now=${Date.now()}`)
      nonce = r.body.trim()
      if (nonce) break
      await sleep(2000)
    }
  } catch (e) {
    return { ok: false, reason: 'unreachable', detail: String(e) }
  }
  if (!nonce) return { ok: false, reason: 'busy', detail: 'nonce 連續回空值' }

  const cookie = `auth=${nonce}`
  const md5 = crypto.createHash('md5').update(`${username}:${password}:${nonce}`).digest('hex')
  let resp: RawResp
  try {
    resp = await rawPostForm(ip, port, '/', {
      encoded: `${username}:${md5}`,
      CurLanguage: 'en',
      ReturnPage: '/',
    }, cookie)
  } catch (e) {
    return { ok: false, reason: 'unreachable', detail: String(e) }
  }
  if (isLoginPage(resp.body)) return { ok: false, reason: 'auth-failed' }
  return { ok: true, value: { ip, port, cookie } }
}

// --- session 重用（wedge 防護核心之一：請求數 讀 3→1、寫 4→2） ---
export const SESSION_TTL_MS = 5 * 60_000 // 真機實測 session ≥7 分鐘存活，取保守 5 分鐘

interface CachedSession {
  session: DayuSession
  expiresAt: number
}

const sessions = new Map<string, CachedSession>()

export function storeSession(ip: string, session: DayuSession): void {
  sessions.set(ip, { session, expiresAt: Date.now() + SESSION_TTL_MS })
}

/**
 * 復用快取 session 執行 fn；TTL 過期或 fn 回 auth-failed（server 回登入頁）
 * 時清快取、重登**一次**、重跑 fn 一次。讀寫共用此路徑。
 */
export async function withSession<T>(
  ip: string, username: string, password: string, port: number,
  fn: (session: DayuSession) => Promise<DayuResult<T>>
): Promise<DayuResult<T>> {
  const cached = sessions.get(ip)
  let session: DayuSession
  if (cached && cached.expiresAt > Date.now()) {
    session = cached.session
  } else {
    const login = await dayuLogin(ip, username, password, port)
    if (!login.ok) return login
    storeSession(ip, login.value)
    session = login.value
  }
  let r = await fn(session)
  if (!r.ok && r.reason === 'auth-failed') {
    sessions.delete(ip)
    const relogin = await dayuLogin(ip, username, password, port)
    if (!relogin.ok) return relogin
    storeSession(ip, relogin.value)
    r = await fn(relogin.value)
  }
  return r
}

export function __clearSessionsForTesting(): void {
  sessions.clear()
}

export function __expireSessionsForTesting(): void {
  for (const [ip, c] of sessions) sessions.set(ip, { ...c, expiresAt: 0 })
}

// media.htm 是唯一「值 inline 在 HTML」可正則讀取的頁面（lines.htm 的 value
// 由 JS 動態填入、讀了是假值 — 實機驗證）。但重複 fetch 有時回半頁（無音量
// 欄位）→ 必須驗證頁面完整性後才信，否則 retry。
export const VOL_RE = /name="DSP_HandfreeVolume_RW"[^>]*\bvalue="(\d)"/
const CODEC_RE = /name="DSP_CodecSets_RW"[^>]*\bvalue="([^"]*)"/

export function isCompleteMediaPage(html: string): boolean {
  return VOL_RE.test(html)
}

/**
 * GET 頁面並重試到「完整頁」（isComplete 判定）。半頁（欄位缺值）是
 * Rapid Logic 已知行為；拿不到完整頁一律回 parse-failed（上層拒發部分 POST）。
 */
export async function fetchFullPage(
  session: DayuSession, path: string, isComplete: (html: string) => boolean, tries = 4
): Promise<DayuResult<string>> {
  let lastDetail = ''
  for (let i = 0; i < tries; i++) {
    let resp: RawResp
    try {
      resp = await rawGet(session.ip, session.port, path, session.cookie)
    } catch (e) {
      return { ok: false, reason: 'unreachable', detail: String(e) }
    }
    if (isLoginPage(resp.body)) return { ok: false, reason: 'auth-failed' }
    if (isComplete(resp.body)) return { ok: true, value: resp.body }
    lastDetail = `第 ${i + 1} 次為不完整頁面（${resp.body.length} bytes）`
    if (i < tries - 1) await sleep(1500) // 同一操作內的頁面重抓間隔
  }
  return { ok: false, reason: 'parse-failed', detail: lastDetail }
}

export async function getMediaInfo(
  session: DayuSession, tries = 4
): Promise<DayuResult<DayuMediaInfo>> {
  const page = await fetchFullPage(session, '/media.htm', isCompleteMediaPage, tries)
  if (!page.ok) return page
  const vol = page.value.match(VOL_RE)!
  const codec = page.value.match(CODEC_RE)
  return { ok: true, value: { speakerVolume: Number(vol[1]), codecOrder: codec?.[1] ?? '' } }
}

/** 依結果回報 health（negative cache）；busy/unreachable 是 wedge 訊號 */
function trackOutcome(ip: string, r: DayuResult<unknown>): void {
  if (r.ok) reportDayuSuccess(ip)
  else if (r.reason === 'busy' || r.reason === 'unreachable') reportDayuFailure(ip)
}

/** 登入檢查（AddDeviceModal 用）。全部經佇列＋health gate。 */
export function dayuLoginCheck(
  ip: string, username = 'admin', password = 'admin', port = 80
): Promise<DayuResult<Record<string, never>>> {
  return enqueueDayu(`${ip}:${port}`, async () => {
    const gate = checkDayuHealth(ip)
    if (gate.blocked) return { ok: false as const, reason: 'busy' as const, detail: backoffDetail(gate) }
    const r = await dayuLogin(ip, username, password, port)
    trackOutcome(ip, r)
    if (!r.ok) return r
    storeSession(ip, r.value)
    return { ok: true as const, value: {} }
  })
}

/** 讀音量/codec。session 復用；失效惰性重登一次（withSession）。 */
export function dayuGetMedia(
  ip: string, username = 'admin', password = 'admin', port = 80
): Promise<DayuResult<DayuMediaInfo>> {
  return enqueueDayu(`${ip}:${port}`, async () => {
    const gate = checkDayuHealth(ip)
    if (gate.blocked) return { ok: false as const, reason: 'busy' as const, detail: backoffDetail(gate) }
    const r = await withSession(ip, username, password, port, (s) => getMediaInfo(s))
    trackOutcome(ip, r)
    return r
  })
}

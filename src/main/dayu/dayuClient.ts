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
// Phase 1 僅讀取；嚴禁在此檔加入任何設定寫入（POST *.htm 表單）。
// ============================================
import * as http from 'http'
import * as crypto from 'crypto'
import type { DayuResult } from '@shared/types'

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
          resolve({ code: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
        )
      }
    )
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    req.end()
  })
}

export function rawPostForm(
  ip: string, port: number, path: string, form: Record<string, string>, cookie?: string, timeoutMs = 6000
): Promise<RawResp> {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(new URLSearchParams(form).toString())
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': String(data.length),
    }
    if (cookie) headers['Cookie'] = cookie
    const req = http.request(
      { host: ip, port, path, method: 'POST', headers, timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({ code: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
        )
      }
    )
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    req.write(data)
    req.end()
  })
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

// media.htm 是唯一「值 inline 在 HTML」可正則讀取的頁面（lines.htm 的 value
// 由 JS 動態填入、讀了是假值 — 實機驗證）。但重複 fetch 有時回半頁（無音量
// 欄位）→ 必須驗證頁面完整性後才信，否則 retry。
const VOL_RE = /name="DSP_HandfreeVolume_RW"[^>]*\bvalue="(\d)"/
const CODEC_RE = /name="DSP_CodecSets_RW"[^>]*\bvalue="([^"]*)"/

export async function getMediaInfo(
  session: DayuSession, tries = 4
): Promise<DayuResult<import('@shared/types').DayuMediaInfo>> {
  let lastDetail = ''
  for (let i = 0; i < tries; i++) {
    let resp: RawResp
    try {
      resp = await rawGet(session.ip, session.port, '/media.htm', session.cookie)
    } catch (e) {
      return { ok: false, reason: 'unreachable', detail: String(e) }
    }
    if (isLoginPage(resp.body)) return { ok: false, reason: 'auth-failed' }
    const vol = resp.body.match(VOL_RE)
    if (vol) {
      const codec = resp.body.match(CODEC_RE)
      return { ok: true, value: { speakerVolume: Number(vol[1]), codecOrder: codec?.[1] ?? '' } }
    }
    lastDetail = `第 ${i + 1} 次為不完整頁面（${resp.body.length} bytes）`
    await sleep(1500) // 讀取最小間隔（Global Constraints）
  }
  return { ok: false, reason: 'parse-failed', detail: lastDetail }
}

// src/main/dayu/dayuWrite.ts
// ============================================
// DAYU-OT300 寫入面（Phase 2）。全部經 per-IP 佇列＋health gate＋withSession。
// 寫入配方（2026-07-21 真機釘死，.155 實測 200 生效）：
//   GET 完整頁 → 全表單保真回帶 → 只改目標欄位 + DefaultSubmit=Apply
//   → GBK body POST 帶 Referer → 503/連線重置最多 4 retry、間隔 3s、重試前重登。
// 驗證分流：media.htm readback 可信 → 音量可達 applied-verified；
// lines.htm readback 必假（value 由 JS 填）→ SIP 恆為 applied-unverified，
// 絕不解析 lines.htm 驗證（會製造假信心或假 mismatch）。
// 只准 POST media.htm / lines.htm；network.htm（改 IP）是 Phase 3 交易。
// ============================================
import type { DayuResult, DayuSipConfig, DayuWriteOutcome } from '@shared/types'
import {
  DayuSession, RawResp, VOL_RE, dayuLogin, fetchFullPage, isCompleteMediaPage,
  isLoginPage, rawPostFields, storeSession, withSession,
} from './dayuClient'
import { buildSubmitFields, parseFormFields } from './dayuForm'
import { checkDayuHealth, reportDayuFailure, reportDayuSuccess, backoffDetail } from './dayuHealth'
import { enqueueDayu } from './dayuQueue'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const WRITE_RETRIES = 4
const WRITE_RETRY_GAP_MS = 3000

/**
 * POST 表單（GBK、帶 Referer）。503／連線重置重試（重試前重新登入刷新
 * session——真機配方）；登入頁回應＝session 失效，交還 withSession 重登重跑。
 */
export async function postWithRetry(
  session: DayuSession, path: string, fields: Array<[string, string]>,
  username: string, password: string
): Promise<DayuResult<{ resp: RawResp; cookie: string }>> {
  let cookie = session.cookie
  for (let i = 0; i < WRITE_RETRIES; i++) {
    let resp: RawResp | null = null
    try {
      resp = await rawPostFields(
        session.ip, session.port, path, fields, cookie, `http://${session.ip}:${session.port}${path}`
      )
    } catch {
      resp = null // ConnectionReset / timeout → 視同 busy，走重試
    }
    if (resp) {
      if (isLoginPage(resp.body)) return { ok: false, reason: 'auth-failed' }
      if (resp.code === 200) return { ok: true, value: { resp, cookie } }
      if (resp.code !== 503) {
        return { ok: false, reason: 'parse-failed', detail: `非預期 HTTP ${resp.code}` }
      }
    }
    if (i < WRITE_RETRIES - 1) {
      await sleep(WRITE_RETRY_GAP_MS)
      const relogin = await dayuLogin(session.ip, username, password, session.port)
      if (relogin.ok) {
        cookie = relogin.value.cookie
        storeSession(session.ip, relogin.value)
      }
    }
  }
  return { ok: false, reason: 'busy', detail: `連續 ${WRITE_RETRIES} 次 503／連線重置` }
}

/** DayuResult 殼 → 四態 outcome，並回報 health（negative cache） */
function finishWrite(ip: string, r: DayuResult<DayuWriteOutcome>): DayuWriteOutcome {
  if (r.ok) {
    if (r.value.state === 'applied-verified' || r.value.state === 'applied-unverified') {
      reportDayuSuccess(ip)
    } else if (r.value.state === 'busy') {
      reportDayuFailure(ip)
    }
    return r.value
  }
  if (r.reason === 'busy' || r.reason === 'unreachable') reportDayuFailure(ip)
  if (r.reason === 'busy') return { state: 'busy', detail: r.detail }
  return { state: 'failed', reason: r.reason, detail: r.detail }
}

/** 設定喇叭音量（canonical 0–9）。readback 驗證，可達 applied-verified。 */
export function dayuSetVolume(
  ip: string, volume: number, username = 'admin', password = 'admin', port = 80
): Promise<DayuWriteOutcome> {
  return enqueueDayu(`${ip}:${port}`, async (): Promise<DayuWriteOutcome> => {
    if (!Number.isInteger(volume) || volume < 0 || volume > 9) {
      return { state: 'failed', reason: 'parse-failed', detail: '音量須為 0–9 整數' }
    }
    const gate = checkDayuHealth(ip)
    if (gate.blocked) return { state: 'busy', detail: backoffDetail(gate) }

    const r = await withSession(
      ip, username, password, port,
      async (session): Promise<DayuResult<DayuWriteOutcome>> => {
        // 1. 完整頁（拿不到就拒發部分 POST — 漏欄位＝關功能）
        const page = await fetchFullPage(session, '/media.htm', isCompleteMediaPage)
        if (!page.ok) return page
        // 2. 全表單保真回帶，只改音量
        const fields = buildSubmitFields(parseFormFields(page.value), {
          DSP_HandfreeVolume_RW: String(volume),
        })
        // 3. POST（503 重試、重試前重登）
        const post = await postWithRetry(session, '/media.htm', fields, username, password)
        if (!post.ok) return post
        // 4. readback 驗證（media.htm 可信）；拿不到完整頁一律降級 unverified，不得謊稱
        // verified，也不可把 auth-failed 往上拋 —— POST 已成功，往上拋會被 withSession
        // 重登並重跑整個 callback，導致重複 POST 且把已成功的寫入誤報 failed。
        const back = await fetchFullPage(
          { ...session, cookie: post.value.cookie }, '/media.htm', isCompleteMediaPage, 3
        )
        if (!back.ok) {
          return {
            ok: true,
            value: {
              state: 'applied-unverified',
              detail: 'POST 成功但回讀失敗（session 失效或頁面不完整）',
            },
          }
        }
        const got = back.value.match(VOL_RE)?.[1]
        if (got === String(volume)) return { ok: true, value: { state: 'applied-verified' } }
        return {
          ok: true,
          value: {
            state: 'failed', reason: 'verify-mismatch',
            detail: `寫入 ${volume} 但回讀為 ${got ?? '無值'}`,
          },
        }
      }
    )
    return finishWrite(ip, r)
  })
}

/** lines.htm 完整頁判定：表單結構在（值可為空 — 真機行為 value 全由 JS 填） */
export function isCompleteLinesPage(html: string): boolean {
  return /name="SIP_PhoneNum_R"/.test(html) && /name="SIP_RegAddr_R"/.test(html)
}

const SIP_FIELD_MAP: Array<[keyof DayuSipConfig, string]> = [
  ['phoneNum', 'SIP_PhoneNum_R'],
  ['regUser', 'SIP_RegUser_R'],
  ['displayName', 'SIP_DisPlayName_R'],
  ['regPasswd', 'SIP_RegPasswd_R'],
  ['regAddr', 'SIP_RegAddr_R'],
  ['regPort', 'SIP_RegPort_R'],
]

/**
 * 設定 SIP 帳號（line 1）。lines.htm readback 不可信（value 由 JS 填）→
 * 本函式**恆**回 applied-unverified／busy／failed，絕不 applied-verified；
 * 也絕不解析 lines.htm 回讀值。真實註冊狀態僅能於 SIP 伺服器端
 * （pjsip show contacts）或抓包確認 — UI 須如實揭露。
 */
export function dayuSetSip(
  ip: string, cfg: DayuSipConfig, username = 'admin', password = 'admin', port = 80
): Promise<DayuWriteOutcome> {
  return enqueueDayu(`${ip}:${port}`, async (): Promise<DayuWriteOutcome> => {
    const gate = checkDayuHealth(ip)
    if (gate.blocked) return { state: 'busy', detail: backoffDetail(gate) }

    const r = await withSession(
      ip, username, password, port,
      async (session): Promise<DayuResult<DayuWriteOutcome>> => {
        const page = await fetchFullPage(session, '/lines.htm', isCompleteLinesPage)
        if (!page.ok) return page
        const overrides: Record<string, string> = {
          // checkbox：表單漏送＝停用 SIP 註冊（真機最隱蔽陷阱），一律強制送
          SIP_EnableSipReg_RW: 'ON',
          SIP_PhoneLineTabIndex_R: '0', // line 1
          SIP_PhoneLineEntry: '1',
        }
        for (const [key, field] of SIP_FIELD_MAP) overrides[field] = cfg[key]
        const fields = buildSubmitFields(parseFormFields(page.value), overrides)
        const post = await postWithRetry(session, '/lines.htm', fields, username, password)
        if (!post.ok) return post
        return {
          ok: true,
          value: {
            state: 'applied-unverified',
            detail: 'SIP 設定已送出；真實註冊狀態僅能於 SIP 伺服器端確認',
          },
        }
      }
    )
    return finishWrite(ip, r)
  })
}

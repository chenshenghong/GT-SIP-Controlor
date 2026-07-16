// ============================================
// SIP CMS — Device REST via MAIN process (Node TLS)
//
// 為什麼存在：部分 GT-SIP-GW fresh 韌體的 https server 不支援 RFC 5746 安全
// 重協商（TLS handshake 帶 `unsafe legacy renegotiation disabled`）。Renderer 的
// Chromium/BoringSSL 一律拒絕這種 server，導致 renderer 端 axios 的 REST 全數在
// TLS 層失敗（DBP/ping 正常，但設 SIP 失敗）。Node 的 OpenSSL 可用
// SSL_OP_LEGACY_SERVER_CONNECT 放寬，故把供裝所需的 REST 呼叫改走主行程。
// （實測 2026-07-16 .184：Node+此旗標登入 200、set/sip/primary status:success。）
// ============================================
import * as https from 'https'
import * as http from 'http'
import * as crypto from 'crypto'
import { DEVICE_DEFAULT_USERNAME, DEVICE_DEFAULT_PASSWORD } from '@shared/constants'
import type { SipConfig, SipConfigResponse, DeviceStatus } from '@shared/types'

/** 放寬 legacy renegotiation + 忽略自簽憑證（設備 https 用自簽）。 */
const legacyAgent = new https.Agent({
  rejectUnauthorized: false,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  secureOptions: (crypto.constants as any).SSL_OP_LEGACY_SERVER_CONNECT,
  keepAlive: false,
})

const gbk = new TextDecoder('gbk')
const tokens = new Map<string, string>()          // ip -> Bearer token（trim 過）
const protoCache = new Map<string, 'https' | 'http'>() // ip -> 學到的協定

interface RawResp { code: number; body: string }

function rawRequest(
  ip: string, scheme: 'https' | 'http', method: string, path: string,
  body: unknown, token?: string, timeoutMs = 4000
): Promise<RawResp> {
  return new Promise((resolve, reject) => {
    const data = body != null ? Buffer.from(JSON.stringify(body)) : null
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (token) headers['Authorization'] = `Bearer ${token}`
    if (data) headers['Content-Length'] = String(data.length)
    const mod = scheme === 'https' ? https : http
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts: any = { host: ip, port: scheme === 'https' ? 443 : 80, path, method, headers, timeout: timeoutMs }
    if (scheme === 'https') opts.agent = legacyAgent
    const req = mod.request(opts, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ code: res.statusCode ?? 0, body: gbk.decode(Buffer.concat(chunks)) }))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    if (data) req.write(data)
    req.end()
  })
}

/** 去除控制字元（0x00-0x1F、0x7F-0x9F）。避免在原始碼放 unicode escape 被工具誤解。 */
function stripControls(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if ((c >= 0x00 && c <= 0x1f) || (c >= 0x7f && c <= 0x9f)) continue
    out += text[i]
  }
  return out
}

/** GBK 解碼後的髒 JSON 修補（沿用 renderer deviceApi 的規則）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseDirty(text: string): any {
  try {
    let clean = stripControls(text)
      .replace(/"broadcast_volume:/g, '"broadcast_volume":')
      .trim()
    const opens = (clean.match(/{/g) || []).length
    const closes = (clean.match(/}/g) || []).length
    if (opens > closes) clean += '}'.repeat(opens - closes)
    return JSON.parse(clean)
  } catch {
    return null
  }
}

async function login(ip: string, scheme: 'https' | 'http'): Promise<string | null> {
  const r = await rawRequest(ip, scheme, 'POST', '/auth/login',
    { username: DEVICE_DEFAULT_USERNAME, password: DEVICE_DEFAULT_PASSWORD })
  const obj = parseDirty(r.body)
  const token = obj?.data?.token ?? obj?.token ?? obj?.access_token
  if (token) { const t = String(token).trim(); tokens.set(ip, t); return t } // 韌體 token 尾有 \n，必 trim
  return null
}

interface ParsedResp { code: number; data: unknown }

/** 通用請求：https-first + http fallback、per-IP 協定快取、401/A003 自動登入重試一次。 */
async function request(ip: string, method: string, path: string, body?: unknown): Promise<ParsedResp> {
  const order: Array<'https' | 'http'> = protoCache.has(ip) ? [protoCache.get(ip)!] : ['https', 'http']
  let lastErr: unknown
  for (const scheme of order) {
    try {
      let r = await rawRequest(ip, scheme, method, path, body, tokens.get(ip))
      // 新韌體 http → 301 導向 https：視為協定不對，換 https
      if (scheme === 'http' && r.code >= 300 && r.code < 400) { lastErr = new Error('http 301 → https'); continue }
      let obj = parseDirty(r.body)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (r.code === 401 || (obj as any)?.error_code === 'A003') {
        const t = await login(ip, scheme)
        if (t) { r = await rawRequest(ip, scheme, method, path, body, t); obj = parseDirty(r.body) }
      }
      protoCache.set(ip, scheme)
      return { code: r.code, data: obj }
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr
}

/** 通用 GET：回已解析物件（含 401 自動登入重試）。失敗回 null。 */
export async function restGetJson(ip: string, apiPath: string): Promise<unknown | null> {
  try {
    const r = await request(ip, 'GET', apiPath)
    return r.data && typeof r.data === 'object' ? r.data : null
  } catch {
    return null
  }
}

/** GET /get/sip/config（巢狀結構）。失敗回 null。 */
export async function restGetSipConfig(ip: string): Promise<SipConfigResponse | null> {
  return (await restGetJson(ip, '/get/sip/config')) as SipConfigResponse | null
}

/** GET /get/device/status（含即時 SIP 註冊狀態 account）。失敗回 null。 */
export async function restGetDeviceStatus(ip: string): Promise<DeviceStatus | null> {
  return (await restGetJson(ip, '/get/device/status')) as DeviceStatus | null
}

/** POST /set/sip/primary。韌體恆回 HTTP 200，看 body status；error=確定拒絕不重試。回 true/false。 */
export async function restSetSipPrimary(ip: string, cfg: SipConfig): Promise<boolean> {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await request(ip, 'POST', '/set/sip/primary', cfg)
      const status = (r.data as { status?: string })?.status
      if (status === 'success') return true
      if (status === 'error') return false
    } catch {
      // 掉包 / 暫時失敗 → 重試
    }
  }
  return false
}

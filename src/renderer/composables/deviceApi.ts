// ============================================
// SIP CMS — Device REST API Client
// Verified against factory firmware websetsip.c (19 endpoints)
// ============================================
import axios, { type AxiosInstance } from 'axios'
import { useAuthStore } from '@/stores/auth'
import { DEVICE_DEFAULT_USERNAME, DEVICE_DEFAULT_PASSWORD } from '@shared/constants'
import type {
  DeviceStatus, VolumeConfig, SipConfig, SipConfigResponse, MulticastConfig,
  SipParameters, SipCodecs, CallStatus, NetworkConfig,
} from '@shared/types'

/** Firmware responds in GBK (Content-Type: ...;charset=GBK) */
const gbkDecoder = new TextDecoder('gbk')

/**
 * Per-device-IP request queue. The firmware web server (lgw_web) uses a single
 * short-lived connection per request (Connection: close); serializing requests to
 * the same IP avoids overlapping connections. Different IPs still run in parallel.
 *
 * NOTE: the historical ~50% failure rate was NOT a single-thread timeout — it was
 * a firmware defect where a second web server (hbi_web) also bound :80 and answered
 * ~half the connections with 403. The factory removed hbi_web from :80 (verified
 * 2026-06-22: .147/.148 now answer 100% from lgw_web). The serialize + retry below
 * are kept as cheap insurance.
 */
const ipQueue = new Map<string, Promise<unknown>>()
function enqueue<T>(ip: string, task: () => Promise<T>): Promise<T> {
  const prev = (ipQueue.get(ip) ?? Promise.resolve()).catch(() => {})
  const next = prev.then(task)
  ipQueue.set(ip, next.catch(() => {}))
  return next
}

/** Retry a task once after a short gap — used for idempotent GETs only. */
async function retryOnce<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await task()
  } catch {
    await new Promise((r) => setTimeout(r, 300))
    return task()
  }
}

/**
 * Per-IP transport protocol, learned on first contact.
 * New GT-SIP-GW firmware serves REST over HTTPS only (http :80 → 301 to the
 * https ROOT, dropping the path → device HTML page instead of API JSON). Old
 * firmware is http-only (no :443 listener). We try https first, fall back to
 * http on a transport failure, and cache what worked so later calls skip the
 * dead attempt. A given IP never changes firmware, so the cache is stable.
 */
const protocolCache = new Map<string, 'https' | 'http'>()

/**
 * Create an Axios instance bound to a specific device IP.
 * - Auto-injects per-IP Bearer token from Pinia
 * - Decodes GBK responses and repairs the firmware's dirty JSON
 */
export function createDeviceApiClient(deviceIp: string): AxiosInstance {
  const api = axios.create({
    // baseURL is set per-request by the transport wrapper below (https-first
    // with http fallback). This default only applies if that wrapper is bypassed.
    baseURL: `https://${deviceIp}`,
    timeout: 1500, // lgw_web answers in <120ms; 1.5s leaves wide margin while still failing fast if a device is truly down
    responseType: 'arraybuffer', // take raw bytes; we GBK-decode ourselves
  })

  // ---- Request Interceptor: inject per-IP token ----
  api.interceptors.request.use((config) => {
    const authStore = useAuthStore()
    const token = authStore.getToken(deviceIp)
    if (token && config.url !== '/auth/login') {
      config.headers['Authorization'] = `Bearer ${token}`
    }
    config.headers['Content-Type'] = 'application/json'
    return config
  })

  // ---- Response: GBK decode + dirty-JSON repair (transformResponse) ----
  // Firmware (websetsip.c) emits GBK text, plus null bytes / control chars,
  // plus (on /get/device/status) a malformed key "broadcast_volume that is
  // missing its closing quote. Decode + repair all three before JSON.parse.
  api.defaults.transformResponse = [
    (data: ArrayBuffer | string | unknown) => {
      let text: string
      if (data instanceof ArrayBuffer) {
        text = gbkDecoder.decode(new Uint8Array(data))
      } else if (typeof data === 'string') {
        text = data
      } else {
        return data
      }
      try {
        let clean = text
          .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
          .replace(/"broadcast_volume:/g, '"broadcast_volume":')
          .trim()
        // Firmware bug: /get/device/status omits the outer closing brace.
        const opens = (clean.match(/{/g) || []).length
        const closes = (clean.match(/}/g) || []).length
        if (opens > closes) clean += '}'.repeat(opens - closes)
        return JSON.parse(clean)
      } catch {
        return text
      }
    },
  ]

  // ---- Transport: https-first with http fallback, cached per IP ----
  // Fallback (trying both protocols) happens ONLY on first contact — once an IP
  // is cached we use that protocol alone. This avoids timeout stacking and, for
  // writes, avoids re-sending a non-idempotent POST down the second protocol.
  const originalRequest = api.request.bind(api)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const runTransport = async (config: any): Promise<any> => {
    const cached = protocolCache.get(deviceIp)
    const order: Array<'https' | 'http'> = cached ? [cached] : ['https', 'http']
    let lastErr: unknown
    for (const proto of order) {
      config.baseURL = `${proto}://${deviceIp}`
      try {
        const res = await originalRequest(config)
        // Only trust (and cache) a response that is genuine API JSON. New
        // firmware's http→301 redirects to the https ROOT (dropping the path)
        // and returns the device HTML page as 200 — no throw — which our
        // transformResponse yields as a STRING. Caching that would permanently
        // pin the wrong protocol (reads return HTML, writes silently no-op).
        // Requiring a parsed object rejects it so we fall through to https.
        if (res && typeof res.data === 'object' && res.data !== null) {
          protocolCache.set(deviceIp, proto) // genuine API response — remember it
          return res
        }
        // Non-API body over the CACHED protocol means this IP changed firmware
        // (e.g. an http device swapped for an https one at the same IP). Drop
        // the stale cache so the next call re-probes both protocols.
        if (cached === proto) protocolCache.delete(deviceIp)
        lastErr = new Error(`Non-API response over ${proto}:// (wrong protocol?)`)
      } catch (err: unknown) {
        // A 401 means we REACHED the real API (correct protocol) but lack a
        // token. Cache the protocol and surface the 401 immediately — do NOT
        // fall back to the other protocol, or the fallback's generic failure
        // would mask the 401 and the caller's auth-retry would never fire.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((err as any)?.response?.status === 401) {
          protocolCache.set(deviceIp, proto)
          throw err
        }
        lastErr = err // genuine transport failure — try the other protocol
      }
    }
    throw lastErr
  }

  // ---- Serialize per-IP + retry idempotent GETs (single-threaded firmware) ----
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(api as any).request = async (config: any) => {
    const method = String(config?.method ?? 'get').toLowerCase()
    const enqueued = () =>
      enqueue(deviceIp, method === 'get' ? () => retryOnce(() => runTransport(config)) : () => runTransport(config))

    try {
      return await enqueued()
    } catch (err: unknown) {
      // ---- Transparent auth: new firmware requires a token even for GET reads.
      // A tokenless request comes back HTTP 401 {error_code:"A003"}, which axios
      // REJECTS — so we handle it here in the catch, not on a resolved response.
      // Log in once (default creds) and retry; the request interceptor then
      // injects the fresh token. Old firmware never 401s, so this is a no-op.
      // Login enqueues its own request, and we're OUTSIDE the queue task here,
      // so there's no per-IP self-deadlock.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const e = err as any
      const isAuthReject =
        e?.response?.status === 401 || e?.response?.data?.error_code === 'A003'
      if (isAuthReject && config.url !== '/auth/login' && !config.__authRetried) {
        config.__authRetried = true
        if (await loginToDevice(deviceIp)) return enqueued()
      }
      throw err
    }
  }

  return api
}

// ============================================
// [Module 1] Auth — login / verify / change password
// ============================================

/** 1.1 Login and obtain token (token is nested under data.token) */
export async function loginToDevice(
  ip: string,
  username: string = DEVICE_DEFAULT_USERNAME,
  password: string = DEVICE_DEFAULT_PASSWORD
): Promise<boolean> {
  const authStore = useAuthStore()
  const api = createDeviceApiClient(ip)
  // login is a POST; retry a few times as insurance (pre-fix, hbi_web 403'd ~half)
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await api.post('/auth/login', { username, password })
      // Firmware shape: { status, message, data: { token, expires_in, user_info } }
      const token =
        response.data?.data?.token ??
        response.data?.token ??
        response.data?.access_token
      if (token) {
        authStore.setToken(ip, String(token).trim()) // firmware token has a stray \n
        return true
      }
    } catch {
      // dropped POST — retry
    }
  }
  return false
}

/**
 * Retry an idempotent write (POST that sets config). The firmware ALWAYS returns
 * HTTP 200; a rejected request comes back as { status: "error", ... }, so we check
 * the JSON status, not just HTTP. Retry is insurance — pre-fix, the rogue hbi_web
 * server answered ~half of all requests with 403.
 */
async function postRetry(
  api: AxiosInstance, url: string, body: unknown, tries = 4
): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await api.post(url, body)
      const status = (res.data as { status?: string })?.status
      if (status === 'success') return true
      if (status === 'error') return false // deterministic reject (bad params) — retrying won't help
      // unparsed / unexpected → fall through and retry
    } catch {
      // dropped POST — retry
    }
  }
  return false
}

/** 1.2 Verify existing token validity */
export async function verifyToken(ip: string): Promise<boolean> {
  const api = createDeviceApiClient(ip)
  try {
    const res = await api.get('/auth/verify')
    return res.data?.status === 'success'
  } catch {
    return false
  }
}

/** 1.3 Change web password */
export async function changePassword(
  ip: string,
  oldPassword: string,
  newPassword: string
): Promise<boolean> {
  const api = createDeviceApiClient(ip)
  try {
    const res = await api.post('/auth/change_password', {
      old_password: oldPassword,
      new_password: newPassword,
    })
    return res.data?.status === 'success'
  } catch {
    return false
  }
}

// ============================================
// [Module 2] Status & Info — 2.1, 2.2, 2.3
// ============================================

/** 2.1 Get device comprehensive status (for polling) */
export async function getDeviceStatus(ip: string): Promise<DeviceStatus | null> {
  const api = createDeviceApiClient(ip)
  try {
    const res = await api.get('/get/device/status')
    return res.data
  } catch {
    return null
  }
}

/** 2.2 Get system version info */
export async function getSystemInfo(ip: string): Promise<Record<string, unknown> | null> {
  const api = createDeviceApiClient(ip)
  try {
    const res = await api.get('/system/info')
    return res.data
  } catch {
    return null
  }
}

/** 2.3 Restart device ⚠️ — triggers 45s reconnect overlay */
export async function restartDevice(ip: string): Promise<boolean> {
  const api = createDeviceApiClient(ip)
  try {
    await api.post('/system/restart', { confirm: true })
    return true
  } catch {
    return false
  }
}

// ============================================
// [Module 3] Audio — 3.1, 3.2
// ============================================

/** 3.1 Get volume settings */
export async function getDeviceVolume(ip: string): Promise<VolumeConfig | null> {
  const api = createDeviceApiClient(ip)
  try {
    const res = await api.get('/get/device/volume')
    return res.data
  } catch {
    return null
  }
}

/** 3.2 Set volume (broadcast_volume / microphone_volume: 0-100) */
export async function setDeviceVolume(
  ip: string,
  config: VolumeConfig
): Promise<boolean> {
  return postRetry(createDeviceApiClient(ip), '/set/device/volume', config)
}

// ============================================
// [Module 4] SIP & Multicast — 4.1~4.6
// ============================================

/** 4.1 Get all SIP configuration (nested response) */
export async function getSipConfig(ip: string): Promise<SipConfigResponse | null> {
  const api = createDeviceApiClient(ip)
  try {
    const res = await api.get('/get/sip/config')
    return res.data
  } catch {
    return null
  }
}

/** 4.2 Set primary SIP line */
export async function setSipPrimary(
  ip: string,
  config: SipConfig
): Promise<boolean> {
  return postRetry(createDeviceApiClient(ip), '/set/sip/primary', config)
}

/** 4.3 Set backup SIP line */
export async function setSipBackup(
  ip: string,
  config: SipConfig
): Promise<boolean> {
  return postRetry(createDeviceApiClient(ip), '/set/sip/backup', config)
}

/** 4.4 Set multicast receiver */
export async function setSipMulticast(
  ip: string,
  config: MulticastConfig
): Promise<boolean> {
  return postRetry(createDeviceApiClient(ip), '/set/sip/multicast', config)
}

/** 4.5 Set SIP advanced parameters */
export async function setSipParameters(
  ip: string,
  config: SipParameters
): Promise<boolean> {
  return postRetry(createDeviceApiClient(ip), '/set/sip/parameters', config)
}

/** 4.6 Set audio codecs */
export async function setSipCodecs(
  ip: string,
  config: SipCodecs
): Promise<boolean> {
  return postRetry(createDeviceApiClient(ip), '/set/sip/codecs', config)
}

// ============================================
// [Module 5] Call Control — 5.1, 5.2
// ============================================

/** 5.1 Get call status (for polling) */
export async function getCallStatus(ip: string): Promise<CallStatus | null> {
  const api = createDeviceApiClient(ip)
  try {
    const res = await api.get('/get/call/status')
    return res.data
  } catch {
    return null
  }
}

/** 5.2 Call control: dial / answer / hangup */
export async function callControl(
  ip: string,
  action: 'dial' | 'answer' | 'hangup',
  number?: string
): Promise<boolean> {
  const api = createDeviceApiClient(ip)
  try {
    await api.post('/call/control', { action, number })
    return true
  } catch {
    return false
  }
}

// ============================================
// [Module 6] Network — 6.1, 6.2
// ============================================

/** 6.1 Get network configuration */
export async function getNetworkConfig(ip: string): Promise<NetworkConfig | null> {
  const api = createDeviceApiClient(ip)
  try {
    const res = await api.get('/get/network/config')
    return res.data
  } catch {
    return null
  }
}

/**
 * 6.2 Set network configuration ⚠️ — device reboots after ~1s on success.
 *
 * Firmware (websetsip.c request_set_network_config) accepts network_mode
 * "static" ONLY; anything else is rejected with {status:"error",
 * message:"仅支持静态网络设置"}. The device exposes NO DBP SET channel
 * (UDP 58001 answers discovery only; no TCP DBP port is open), so DHCP simply
 * cannot be set on this firmware — callers must surface that, not fake success.
 *
 * Uses postRetry so the JSON status is actually checked (the firmware always
 * returns HTTP 200; a rejected write comes back as status:"error").
 */
export async function setNetworkConfig(
  ip: string,
  config: NetworkConfig
): Promise<boolean> {
  return postRetry(createDeviceApiClient(ip), '/set/network/config', config)
}

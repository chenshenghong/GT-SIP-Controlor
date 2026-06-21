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
 * Per-device-IP request queue. The firmware web server is single-threaded and
 * times out on concurrent / back-to-back requests, so we serialize all requests
 * to the same IP. Different IPs still run in parallel.
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
 * Create an Axios instance bound to a specific device IP.
 * - Auto-injects per-IP Bearer token from Pinia
 * - Decodes GBK responses and repairs the firmware's dirty JSON
 */
export function createDeviceApiClient(deviceIp: string): AxiosInstance {
  const api = axios.create({
    baseURL: `http://${deviceIp}`,
    timeout: 3000, // LAN device answers <1s; a longer wait just means a dropped packet → fail fast & retry
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

  // ---- Serialize per-IP + retry idempotent GETs (single-threaded firmware) ----
  const originalRequest = api.request.bind(api)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(api as any).request = (config: any) => {
    const method = String(config?.method ?? 'get').toLowerCase()
    const task = () => originalRequest(config)
    return enqueue(deviceIp, method === 'get' ? () => retryOnce(task) : task)
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
  // login is a POST and the device drops ~half of them — retry a few times
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

/** Retry an idempotent write (POST that sets config) — device drops ~half of POSTs. */
async function postRetry(
  api: AxiosInstance, url: string, body: unknown, tries = 4
): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      await api.post(url, body)
      return true
    } catch {
      // retry
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

/** 6.2 Set network configuration ⚠️ — static only; device reboots after ~1s */
export async function setNetworkConfig(
  ip: string,
  config: NetworkConfig
): Promise<boolean> {
  const api = createDeviceApiClient(ip)
  try {
    await api.post('/set/network/config', config)
    return true
  } catch {
    return false
  }
}

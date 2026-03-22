// ============================================
// SIP CMS — Device REST API Client
// Complete wrapper for all 14 endpoints per GT-SIP-REST_API.md
// ============================================
import axios, { type AxiosInstance } from 'axios'
import { useAuthStore } from '@/stores/auth'
import { DEVICE_DEFAULT_USERNAME, DEVICE_DEFAULT_PASSWORD } from '@shared/constants'
import type {
  DeviceStatus, VolumeConfig, SipConfig, MulticastConfig,
  SipParameters, SipCodecs, CallStatus, NetworkConfig,
} from '@shared/types'

/**
 * Create an Axios instance bound to a specific device IP.
 * - Auto-injects per-IP Bearer token from Pinia
 * - Dirty JSON interceptor strips \u0000 and control characters
 */
export function createDeviceApiClient(deviceIp: string): AxiosInstance {
  const api = axios.create({
    baseURL: `http://${deviceIp}`,
    timeout: 5000,
  })

  // ---- Request Interceptor: inject per-IP token ----
  api.interceptors.request.use((config) => {
    const authStore = useAuthStore()
    const token = authStore.getToken(deviceIp)
    if (token && config.url !== '/auth/login') {
      config.headers['Authorization'] = `Bearer ${token}`
    }
    config.headers['Content-Type'] = 'application/json'
    config.headers['Accept'] = 'application/json; charset=UTF-8'
    return config
  })

  // ---- Response: Dirty JSON cleaning (transformResponse) ----
  // C/C++ firmware often returns null bytes (\u0000) and control chars
  // that break JSON.parse → white screen crash
  api.defaults.transformResponse = [
    (data: string | unknown) => {
      if (typeof data === 'string') {
        try {
          const cleanData = data
            .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
            .trim()
          return JSON.parse(cleanData)
        } catch {
          return data
        }
      }
      return data
    },
  ]

  return api
}

// ============================================
// [Module 1] Auth — 1.1, 1.2
// ============================================

/** 1.1 Login and obtain JWT token */
export async function loginToDevice(
  ip: string,
  username: string = DEVICE_DEFAULT_USERNAME,
  password: string = DEVICE_DEFAULT_PASSWORD
): Promise<boolean> {
  const authStore = useAuthStore()
  const api = createDeviceApiClient(ip)

  try {
    const response = await api.post('/auth/login', { username, password })
    const token = response.data?.token || response.data?.access_token
    if (token) {
      authStore.setToken(ip, token)
      return true
    }
    return false
  } catch {
    return false
  }
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

/** 3.2 Set volume */
export async function setDeviceVolume(
  ip: string,
  config: VolumeConfig
): Promise<boolean> {
  const api = createDeviceApiClient(ip)
  try {
    await api.post('/set/device/volume', config)
    return true
  } catch {
    return false
  }
}

// ============================================
// [Module 4] SIP & Multicast — 4.1~4.5
// ============================================

/** 4.1 Get all SIP configuration */
export async function getSipConfig(ip: string): Promise<SipConfig | null> {
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
  const api = createDeviceApiClient(ip)
  try {
    await api.post('/set/sip/primary', config)
    return true
  } catch {
    return false
  }
}

/** 4.3 Set multicast receiver */
export async function setSipMulticast(
  ip: string,
  config: MulticastConfig
): Promise<boolean> {
  const api = createDeviceApiClient(ip)
  try {
    await api.post('/set/sip/multicast', config)
    return true
  } catch {
    return false
  }
}

/** 4.4 Set SIP advanced parameters */
export async function setSipParameters(
  ip: string,
  config: SipParameters
): Promise<boolean> {
  const api = createDeviceApiClient(ip)
  try {
    await api.post('/set/sip/parameters', config)
    return true
  } catch {
    return false
  }
}

/** 4.5 Set audio codecs */
export async function setSipCodecs(
  ip: string,
  config: SipCodecs
): Promise<boolean> {
  const api = createDeviceApiClient(ip)
  try {
    await api.post('/set/sip/codecs', config)
    return true
  } catch {
    return false
  }
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

/** 6.2 Set network configuration ⚠️ — may cause IP change + disconnect */
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

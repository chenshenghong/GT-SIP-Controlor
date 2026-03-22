// ============================================
// SIP CMS — Dynamic Axios Client Factory
// Phase 3: Per-device API client with Dirty JSON defense
// ============================================
import axios, { type AxiosInstance } from 'axios'
import { useAuthStore } from '@/stores/auth'

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
          // Strip \u0000-\u001F (control chars) and \u007F-\u009F (invisible chars)
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

/**
 * Login to a device and store the token
 */
export async function loginToDevice(
  ip: string,
  password: string
): Promise<boolean> {
  const authStore = useAuthStore()
  const api = createDeviceApiClient(ip)

  try {
    const response = await api.post('/auth/login', { password })
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

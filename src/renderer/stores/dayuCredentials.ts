// ============================================
// DAYU 設備憑證（IP-keyed，純記憶體 — 與 auth.ts 的 GT token 字典同模型）。
// 刻意不落盤：避免設備密碼明文寫 userData；重啟後回 fallback admin/admin，
// 使用者於新增設備或詳情頁重新輸入即可。若日後要持久化，用
// provisionRegistry.ts 的原子寫模式另開 dayu-credentials.json（需明確
// 接受 LAN admin 明文落盤的取捨）。
// ============================================
import { defineStore } from 'pinia'
import { ref } from 'vue'

export interface DayuCredentials {
  username: string
  password: string
}

/** DAYU 出廠預設帳密 */
export const DAYU_DEFAULT_CREDENTIALS: DayuCredentials = { username: 'admin', password: 'admin' }

export const useDayuCredentialStore = defineStore('dayuCredentials', () => {
  const creds = ref<Record<string, DayuCredentials>>({})

  function setCredentials(ip: string, username: string, password: string) {
    creds.value = { ...creds.value, [ip]: { username, password } }
  }

  /** 依 IP 取憑證；未設定過回出廠預設 */
  function getCredentials(ip: string): DayuCredentials {
    return creds.value[ip] ?? { ...DAYU_DEFAULT_CREDENTIALS }
  }

  return { creds, setCredentials, getCredentials }
})

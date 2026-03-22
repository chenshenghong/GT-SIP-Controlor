// ============================================
// SIP CMS — IPC Channel Constants
// Single source of truth for main ↔ renderer communication
// ============================================

export const IPC_CHANNELS = {
  // Scanner
  SCAN_START: 'scan:start',
  SCAN_PROGRESS: 'scan:progress',
  SCAN_COMPLETE: 'scan:complete',
  SCAN_ERROR: 'scan:error',

  // IP Configuration (DBP SET)
  CHANGE_IP: 'device:change-ip',
  CHANGE_IP_RESULT: 'device:change-ip-result',

  // System
  RESTART_DEVICE: 'device:restart',
  PING_DEVICE: 'device:ping',
  PING_RESULT: 'device:ping-result',
} as const

/** DBP/1.0 Protocol port — needs Wireshark capture to confirm */
export const DBP_PORT = 18888

/** TCP socket timeout for discovery scan (ms) */
export const SCAN_TIMEOUT_MS = 300

/** Maximum HTTP concurrent requests for batch sync */
export const MAX_CONCURRENT_SYNC = 5

/** Reconnect polling interval (ms) */
export const RECONNECT_POLL_INTERVAL_MS = 3000

/** Reconnect total timeout (seconds) */
export const RECONNECT_TIMEOUT_SEC = 45

/** Device REST API default port */
export const DEVICE_API_PORT = 80

/** Device default credentials */
export const DEVICE_DEFAULT_USERNAME = 'admin'
export const DEVICE_DEFAULT_PASSWORD = '123456'

/** Device status polling interval (ms) — per REST API spec */
export const STATUS_POLL_INTERVAL_MS = 3000

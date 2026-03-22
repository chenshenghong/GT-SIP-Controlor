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

  // Port Detection
  DETECT_PORT: 'device:detect-port',

  // TaskServer
  TASKSERVER_QUERY: 'taskserver:query',

  // System
  RESTART_DEVICE: 'device:restart',
  PING_DEVICE: 'device:ping',
  PING_RESULT: 'device:ping-result',
} as const

/**
 * DBP/1.0 Protocol port candidates list.
 *
 * ⚠️ The exe does NOT hardcode a port number. Through Wireshark capture
 * or runtime detection, the correct port must be determined.
 * These are tried in order during auto-detection.
 */
export const DBP_PORT_CANDIDATES = [
  18888,  // Original guess
  9988,   // Common Chinese SIP device port
  8899,   // Alternative
  8000,   // Common HTTP-adjacent
  10000,  // Round number
  10010,  // Another Chinese telecom port
  5060,   // SIP standard
  3000,   // Dev common
  80,     // HTTP fallback
] as const

/** The first candidate as default fallback */
export const DBP_PORT = DBP_PORT_CANDIDATES[0]

/** TCP socket timeout for discovery scan (ms) */
export const SCAN_TIMEOUT_MS = 500

/** TCP socket timeout for port detection (ms) — longer for reliability */
export const PORT_DETECT_TIMEOUT_MS = 1500

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

/** TaskServer defaults (from QueryTool config.ini) */
export const TASK_SERVER_DEFAULT_IP = '192.168.3.200'
export const TASK_SERVER_DEFAULT_PORT = 18888 // Guessed, needs Wireshark

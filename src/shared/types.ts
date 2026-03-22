// ============================================
// SIP CMS — Shared Type Definitions
// Replaces wt-shared-spec worktree
// ============================================

/** Device node discovered via DBP/1.0 TCP scan or REST status */
export interface DeviceNode {
  mac: string
  ip: string
  mask: string
  gateway: string
  autoIp: 0 | 1 // 0: static, 1: DHCP
  version: string
  mode: string
  status: 'ONLINE' | 'DISCONNECTED' | 'RECONNECTING'
}

/** Per-device Bearer token dictionary, keyed by IP address */
export interface TokenDictionary {
  [ipAddress: string]: string
}

/** Batch sync task model */
export interface BatchSyncTask {
  taskId: string
  targetIps: string[]
  payload: {
    volume?: number
    multicast_ip?: string
    multicast_port?: number
    primary_sip?: string
  }
  progress: number // 0 - 100
  status: 'PENDING' | 'RUNNING' | 'SUCCESS' | 'PARTIAL_FAILED'
  errorLogs: Record<string, string> // { [ip]: errorMessage }
}

/** Scan progress event sent from main → renderer via IPC */
export interface ScanProgress {
  currentIp: string
  currentIndex: number
  total: number
}

/** Scan result: complete list of discovered devices */
export interface ScanResult {
  devices: DeviceNode[]
  scannedCount: number
  elapsedMs: number
}

/** Device sync status for individual nodes in batch sync */
export type DeviceSyncStatus = 'PENDING' | 'SYNCING' | 'SUCCESS' | 'FAILED'

export interface DeviceSyncEntry {
  ip: string
  mac: string
  status: DeviceSyncStatus
  error?: string
}

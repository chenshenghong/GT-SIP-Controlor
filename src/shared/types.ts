// ============================================
// SIP CMS — Shared Type Definitions
// Aligned with DBP/1.0 protocol (33 fields)
// and GT-SIP REST API specification
// ============================================

/**
 * Device node discovered via DBP/1.0 TCP scan
 * Fields mapped from "Key: Value" response format
 */
export interface DeviceNode {
  // --- Core identity ---
  id: number
  type: string              // e.g. "SIP-Speaker", "SIP-Intercom"
  mac: string
  sn: string
  name: string
  hostName: string

  // --- Network ---
  ip: string
  mask: string
  gateway: string
  autoIp: 0 | 1             // 0: static, 1: DHCP
  dns1: string
  dns2: string
  useDns: number

  // --- SIP ---
  server: string             // "ip:port"
  server2: string            // backup SIP server
  mode: string               // intercom / broadcast / paging
  isBroadcast: number

  // --- Firmware ---
  version: string

  // --- Audio ---
  playVol: number            // Output volume (0-100, per firmware websetsip.c)
  captureVol: number         // Input volume (0-100, per firmware websetsip.c)
  treble: number
  bass: number
  tbAgc: number
  tbLinein: number

  // --- System ---
  group: number
  speed: number
  encrypt: number
  reboot: string             // "type,delay" format
  website: string
  svcConfig: string
  localSet: string           // "a,b,c,d" format

  // --- Runtime (added by CMS, not from DBP) ---
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
  payload: BatchSyncPayload
  progress: number // 0 - 100
  status: 'PENDING' | 'RUNNING' | 'SUCCESS' | 'PARTIAL_FAILED'
  errorLogs: Record<string, string> // { [ip]: errorMessage }
}

export interface BatchSyncPayload {
  broadcast_volume?: number
  microphone_volume?: number
  multicast_address?: string
  multicast_port?: number
  audio_codec?: string
  enabled?: boolean
  server_address?: string
  server_port?: number
  user_id?: string
  password?: string
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

// ============================================
// REST API Response Types
// Aligned with GT-SIP-REST_API.md
// ============================================

/** device_info block inside /get/device/status (firmware websetsip.c) */
export interface DeviceInfoBlock {
  model: string
  hardware_version: string
  software_version: string
  uptime: string
  broadcast_volume: number
  microphone_volume: number
}

/** network_info block inside /get/device/status (firmware websetsip.c) */
export interface NetworkInfoBlock {
  mac_address: string
  ip_allocation: string
  ip_address: string
  subnet_mask: string
  gateway: string
  dns: string
}

/**
 * GET /get/device/status — firmware nests everything under `sip_status`
 * (device_info / network_info are siblings of primary_line, inside sip_status).
 */
export interface DeviceStatus {
  sip_status: {
    primary_line?: Record<string, unknown>
    multicast_status?: Record<string, unknown>
    device_info: DeviceInfoBlock
    network_info: NetworkInfoBlock
  }
}

/** Volume values are 0-100 (firmware validates 0 <= v <= 100) */
export interface VolumeConfig {
  broadcast_volume: number   // 0-100
  microphone_volume: number  // 0-100
}

/** Flat shape used by POST /set/sip/primary and /set/sip/backup (one line) */
export interface SipConfig {
  server_address: string
  server_port: number
  user_id: string
  password: string
  auto_answer: boolean
  register_timeout: number
  transport_protocol: string
}

export interface MulticastConfig {
  multicast_address: string
  multicast_port: number
  enabled: boolean
  audio_codec: string
}

export interface SipParameters {
  local_port: number
  rtp_start_port: number
  rtp_end_port: number
  rtp_timeout: number
  echo_cancellation: boolean
}

export interface SipCodecs {
  g722: boolean
  opus: boolean
  g711_ulaw: boolean
  g711_alaw: boolean
}

/**
 * GET /get/sip/config — firmware returns a NESTED object, not the flat SipConfig.
 * Use this for reads; use SipConfig (flat) for /set/sip/primary & /set/sip/backup.
 */
export interface SipConfigResponse {
  primary_line: SipConfig
  multicast_config: MulticastConfig
  sip_parameters: SipParameters
  audio_codecs: SipCodecs
}

export interface CallStatus {
  state: string
  remote_number?: string
  duration?: number
}

export interface NetworkConfig {
  network_mode: 'static' | 'dhcp'
  ip_address: string
  subnet_mask: string
  gateway: string
  dns: string
}

/** IP change request via DBP SET command */
export interface IpChangeRequest {
  targetIp: string   // current IP to connect to
  newIp: string
  newMask: string
  newGateway: string
  autoIp: 0 | 1
  dns1?: string
  dns2?: string
}

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

  // --- DBP extended SIP settings (decoded from IFCFG-APP; discovery only) ---
  regUser?: string       // SIP 分機 / 帳號 (RegUser)
  regAddr?: string       // SIP 註冊伺服器位址 (RegAddr)
  regPort?: string       // SIP 註冊埠 (ServerPort)
  outVol?: number        // 輸出/播放音量設定 (OutVol)
  micVol?: number        // 麥克風音量設定 (MicVol)
  connectMode?: string   // 連線模式 (ConnectMode)
  // PTT/COR/ROLE — echoed verbatim into the DBP SET's IFCFG-APP on IP change so
  // the operation never wipes them (the factory tool does the same). Discovery
  // reports them via IFCFG-APP; default "0" (firmware default) when absent.
  ptt?: string           // PTT 觸發設定 (IFCFG-APP)
  cor?: string           // COR 設定 (IFCFG-APP)
  role?: string          // ROLE 設定 (IFCFG-APP)

  // --- Runtime (added by CMS, not from DBP) ---
  status: 'ONLINE' | 'DISCONNECTED' | 'RECONNECTING'
  sipRegStatus?: string  // SIP 註冊狀態 (REST /get/device/status，同網段才有)
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

/** REST discovery scan progress (main → renderer) */
export interface RestScanProgress {
  done: number
  total: number
  found: number
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
  // Full current device config from discovery. The DBP SET is a UDP BROADCAST
  // addressed by MAC (see ipChanger.ts), and it echoes the device's existing
  // fields so nothing but IP/Mask/Gateway/AutoIP changes — exactly like the
  // factory QueryTool. So we need the whole device, not just a target IP.
  device: DeviceNode
  newIp: string
  newMask: string
  newGateway: string
  autoIp: 0 | 1
  /** 供裝時順帶把設備名稱設為分機號（帶入 DBP SET 的 Name: 欄位）；省略則沿用 device.name */
  newName?: string
}

// ============================================
// Auto-Provisioning
// ============================================

/** 使用者填的供裝範本（持久化於 registry 檔） */
export interface ProvisionConfig {
  ipStart: string
  ipEnd: string
  mask: string
  gateway: string
  extStart: number
  extEnd: number
  sipPassword: string
  sipServer: string
  sipPort: number
  namePrefix: string
}

/** 登記表一筆記錄（MAC 為主鍵） */
export interface ProvisionRecord {
  mac: string
  assignedIp: string
  assignedExt: number
  status: 'pending' | 'provisioned' | 'failed'
  updatedAt: string // ISO 8601
  lastError?: string
}

/** registry 檔內容 */
export interface ProvisionRegistryFile {
  config: ProvisionConfig | null
  records: ProvisionRecord[]
}

/** 執行期任務狀態（只在記憶體，不落地） */
export type ProvisionTaskStatus =
  | 'discovered'
  | 'ip_assigning'
  | 'waiting_online'
  | 'sip_configuring'
  | 'done'
  | 'skipped'
  | 'failed'

export interface ProvisionTask {
  mac: string
  ip: string // 目前觀測到的 IP
  assignedIp: string
  assignedExt: number
  status: ProvisionTaskStatus
  deadline?: number // waiting_online 逾時的絕對時間戳 (ms)
  error?: string
}

/** 引擎對外事件（driver 綁到 store） */
export type ProvisionEvent =
  | { kind: 'task'; task: ProvisionTask }
  | { kind: 'log'; ts: number; message: string }
  | { kind: 'paused'; reason: string }
  | { kind: 'pool'; ipUsed: number; ipTotal: number; extUsed: number; extTotal: number }
  | { kind: 'round'; round: number }

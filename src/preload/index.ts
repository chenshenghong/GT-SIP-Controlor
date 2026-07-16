// ============================================
// SIP CMS — Preload Bridge (contextBridge)
// Safely exposes IPC methods to renderer
// ============================================
import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '@shared/constants'
import type { ScanProgress, ScanResult, RestScanProgress, DeviceNode, IpChangeRequest, ProvisionRegistryFile, SipConfig, SipConfigResponse, DeviceStatus } from '@shared/types'

export type ElectronAPI = {
  // Scanner (mode=0: subnet scan)
  startScan: (baseIp: string) => Promise<{ success: boolean; data?: ScanResult; error?: string }>
  // Scanner (mode=0+: multi-subnet scan with on-link routes)
  scanMultiSubnet: (additionalSubnets?: string[]) => Promise<{ success: boolean; data?: ScanResult; error?: string }>
  onScanProgress: (callback: (progress: ScanProgress) => void) => () => void
  // REST discovery scan (finds REST-only devices)
  restScan: (subnet: string) => Promise<{ success: boolean; devices?: DeviceNode[]; error?: string }>
  onRestScanProgress: (callback: (progress: RestScanProgress) => void) => () => void
  // DBP/1.0 UDP broadcast discovery (finds cross-subnet devices)
  dbpDiscover: () => Promise<{ success: boolean; devices?: DeviceNode[]; error?: string }>
  onDbpProgress: (callback: (found: number) => void) => () => void
  // Detected local /24 subnet prefix (e.g. "192.168.0"), or null
  getLocalSubnet: () => Promise<string | null>
  // TaskServer scan (mode=1)
  taskServerQuery: (serverIp: string, serverPort: number) => Promise<{ success: boolean; data?: ScanResult; error?: string }>
  // Port detection
  detectPort: (targetIp: string) => Promise<{ success: boolean; port: number; error?: string }>
  // IP Change (DBP SET)
  changeIp: (request: IpChangeRequest) => Promise<{ success: boolean; error?: string }>
  // Device operations
  pingDevice: (ip: string) => Promise<boolean>
  // Provisioning registry (persisted JSON in userData)
  readRegistry: () => Promise<{ success: boolean; data?: ProvisionRegistryFile; error?: string }>
  writeRegistry: (data: ProvisionRegistryFile) => Promise<{ success: boolean; error?: string }>
  ensureReachable: (ip: string) => Promise<{ success: boolean; error?: string }>
  // 設備 REST 走主行程（Node TLS 放寬 legacy renegotiation，供 fresh 韌體 https）
  deviceGetSipConfig: (ip: string) => Promise<SipConfigResponse | null>
  deviceSetSipPrimary: (ip: string, cfg: SipConfig) => Promise<boolean>
  deviceGetStatus: (ip: string) => Promise<DeviceStatus | null>
}

const electronAPI: ElectronAPI = {
  startScan: (baseIp: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.SCAN_START, baseIp)
  },

  scanMultiSubnet: (additionalSubnets: string[] = []) => {
    return ipcRenderer.invoke('scan:multi', additionalSubnets)
  },

  onScanProgress: (callback: (progress: ScanProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: ScanProgress) => {
      callback(progress)
    }
    ipcRenderer.on(IPC_CHANNELS.SCAN_PROGRESS, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.SCAN_PROGRESS, handler)
    }
  },

  restScan: (subnet: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.REST_SCAN, subnet)
  },

  getLocalSubnet: () => {
    return ipcRenderer.invoke('net:local-subnet')
  },

  dbpDiscover: () => {
    return ipcRenderer.invoke(IPC_CHANNELS.DBP_DISCOVER)
  },

  onDbpProgress: (callback: (found: number) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, found: number) => {
      callback(found)
    }
    ipcRenderer.on(IPC_CHANNELS.DBP_DISCOVER_PROGRESS, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.DBP_DISCOVER_PROGRESS, handler)
    }
  },

  onRestScanProgress: (callback: (progress: RestScanProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: RestScanProgress) => {
      callback(progress)
    }
    ipcRenderer.on(IPC_CHANNELS.REST_SCAN_PROGRESS, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.REST_SCAN_PROGRESS, handler)
    }
  },

  taskServerQuery: (serverIp: string, serverPort: number) => {
    return ipcRenderer.invoke(IPC_CHANNELS.TASKSERVER_QUERY, serverIp, serverPort)
  },

  detectPort: (targetIp: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.DETECT_PORT, targetIp)
  },

  changeIp: (request: IpChangeRequest) => {
    return ipcRenderer.invoke(IPC_CHANNELS.CHANGE_IP, request)
  },

  pingDevice: (ip: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.PING_DEVICE, ip)
  },

  readRegistry: () => {
    return ipcRenderer.invoke(IPC_CHANNELS.REGISTRY_READ)
  },

  writeRegistry: (data: ProvisionRegistryFile) => {
    return ipcRenderer.invoke(IPC_CHANNELS.REGISTRY_WRITE, data)
  },

  ensureReachable: (ip: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.PROVISION_ENSURE_REACHABLE, ip)
  },
  deviceGetSipConfig: (ip: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.DEVICE_GET_SIP_CONFIG, ip)
  },
  deviceSetSipPrimary: (ip: string, cfg: SipConfig) => {
    return ipcRenderer.invoke(IPC_CHANNELS.DEVICE_SET_SIP_PRIMARY, ip, cfg)
  },
  deviceGetStatus: (ip: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.DEVICE_GET_STATUS, ip)
  },
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

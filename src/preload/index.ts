// ============================================
// SIP CMS — Preload Bridge (contextBridge)
// Safely exposes IPC methods to renderer
// ============================================
import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '@shared/constants'
import type { ScanProgress, ScanResult } from '@shared/types'

export type ElectronAPI = {
  // Scanner
  startScan: (baseIp: string) => Promise<{ success: boolean; data?: ScanResult; error?: string }>
  onScanProgress: (callback: (progress: ScanProgress) => void) => () => void
  // Device operations
  pingDevice: (ip: string) => Promise<boolean>
}

const electronAPI: ElectronAPI = {
  startScan: (baseIp: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.SCAN_START, baseIp)
  },

  onScanProgress: (callback: (progress: ScanProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: ScanProgress) => {
      callback(progress)
    }
    ipcRenderer.on(IPC_CHANNELS.SCAN_PROGRESS, handler)
    // Return cleanup function
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.SCAN_PROGRESS, handler)
    }
  },

  pingDevice: (ip: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.PING_DEVICE, ip)
  },
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

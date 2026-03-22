// ============================================
// SIP CMS — Electron Main Process
// ============================================
import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { IPC_CHANNELS } from '@shared/constants'
import { scanSubnet } from './scanner'
import { changeDeviceIp } from './ipChanger'
import type { IpChangeRequest } from '@shared/types'

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    title: 'SIP COMMANDER',
    backgroundColor: '#0c1324',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer in dev
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

// ---- IPC Handlers ----
function registerIpcHandlers(mainWindow: BrowserWindow): void {
  // Start network scan
  ipcMain.handle(IPC_CHANNELS.SCAN_START, async (_event, baseIp: string) => {
    try {
      const result = await scanSubnet(baseIp, (progress) => {
        mainWindow.webContents.send(IPC_CHANNELS.SCAN_PROGRESS, progress)
      })
      return { success: true, data: result }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // Change device IP via DBP SET command
  ipcMain.handle(IPC_CHANNELS.CHANGE_IP, async (_event, request: IpChangeRequest) => {
    try {
      return await changeDeviceIp(request)
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // Ping device (for reconnect check)
  ipcMain.handle(IPC_CHANNELS.PING_DEVICE, async (_event, ip: string) => {
    const net = await import('net')
    return new Promise<boolean>((resolve) => {
      const socket = new net.Socket()
      socket.setTimeout(1000)
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('timeout', () => {
        socket.destroy()
        resolve(false)
      })
      socket.once('error', () => {
        socket.destroy()
        resolve(false)
      })
      socket.connect(80, ip)
    })
  })
}

// ---- App Lifecycle ----
app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.tcfnet.sip-cms')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  const mainWindow = createWindow()
  registerIpcHandlers(mainWindow)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const w = createWindow()
      registerIpcHandlers(w)
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// ============================================
// SIP CMS — Electron Main Process
// ============================================
import { app, shell, BrowserWindow, ipcMain, session } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { IPC_CHANNELS } from '@shared/constants'
import { scanSubnet, scanMultiSubnet, autoDetectPort, resetDetectedPort, getActivePort } from './scanner'
import { scanViaTaskServer } from './taskServerClient'
import { changeDeviceIp } from './ipChanger'
import { cleanupAllRoutes, cleanupAllAliases } from './routeManager'
import type { IpChangeRequest, SipConfig } from '@shared/types'

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
      // LAN device REST APIs send no CORS headers; the renderer talks to them
      // cross-origin via axios. Disable web security so those calls are not
      // blocked by CORS / preflight (internal tool, LAN-only targets).
      webSecurity: false,
    },
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

// ---- IPC Handlers ----
function registerIpcHandlers(mainWindow: BrowserWindow): void {
  // Start network scan (mode=0: subnet scan)
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

  // DBP/1.0 UDP broadcast discovery — finds devices on ALL subnets of the L2 segment
  ipcMain.handle(IPC_CHANNELS.DBP_DISCOVER, async () => {
    try {
      const { dbpDiscover } = await import('./dbpDiscover')
      const devices = await dbpDiscover(4000, (found) => {
        mainWindow.webContents.send(IPC_CHANNELS.DBP_DISCOVER_PROGRESS, found)
      })
      // Cross-subnet devices are FOUND via UDP broadcast but aren't reachable
      // over TCP/REST (their replies don't route back). Add a same-subnet
      // secondary IP for each non-local subnet so the list can read/control them.
      try {
        const { ensureReachableForIps } = await import('./routeManager')
        await ensureReachableForIps(devices.map((d) => d.ip).filter(Boolean))
      } catch (e) {
        console.log('[Alias] ensureReachableForIps failed (need admin?):', e)
      }
      return { success: true, devices }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // Local subnet detection (for defaulting the REST scan target)
  ipcMain.handle('net:local-subnet', async () => {
    try {
      const { detectLocalNetwork } = await import('./routeManager')
      return detectLocalNetwork()?.subnet ?? null
    } catch {
      return null
    }
  })

  // REST discovery scan (TCP :80 probe + REST confirm) — finds REST-only devices
  ipcMain.handle(IPC_CHANNELS.REST_SCAN, async (_event, subnet: string) => {
    try {
      const { restScanSubnet } = await import('./restScanner')
      const devices = await restScanSubnet(subnet, (progress) => {
        mainWindow.webContents.send(IPC_CHANNELS.REST_SCAN_PROGRESS, progress)
      })
      return { success: true, devices }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // Multi-subnet scan (mode=0+: scan local + factory default subnets)
  ipcMain.handle('scan:multi', async (_event, additionalSubnets: string[]) => {
    try {
      const result = await scanMultiSubnet(additionalSubnets, (progress) => {
        mainWindow.webContents.send(IPC_CHANNELS.SCAN_PROGRESS, progress)
      })
      return { success: true, data: result }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // TaskServer scan (mode=1)
  ipcMain.handle(IPC_CHANNELS.TASKSERVER_QUERY, async (_event, serverIp: string, serverPort: number) => {
    try {
      const result = await scanViaTaskServer(serverIp, serverPort, (progress) => {
        mainWindow.webContents.send(IPC_CHANNELS.SCAN_PROGRESS, progress)
      })
      return { success: true, data: result }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // Auto-detect DBP port
  ipcMain.handle(IPC_CHANNELS.DETECT_PORT, async (_event, targetIp: string) => {
    try {
      resetDetectedPort()
      const port = await autoDetectPort(targetIp)
      return { success: port !== null, port: port ?? getActivePort() }
    } catch (error) {
      return { success: false, port: getActivePort(), error: String(error) }
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

  ipcMain.handle(IPC_CHANNELS.REGISTRY_READ, async () => {
    const { loadRegistry } = await import('./provisionRegistry')
    const file = join(app.getPath('userData'), 'provision-registry.json')
    try {
      return { success: true, data: await loadRegistry(file) }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.REGISTRY_WRITE, async (_event, data) => {
    const { saveRegistry } = await import('./provisionRegistry')
    const file = join(app.getPath('userData'), 'provision-registry.json')
    try {
      await saveRegistry(file, data)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.PROVISION_ENSURE_REACHABLE, async (_event, ip: string) => {
    try {
      const { ensureReachableForIps } = await import('./routeManager')
      await ensureReachableForIps([ip])
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // 設備 REST 走主行程（Node OpenSSL 放寬 legacy renegotiation；Chromium 做不到）
  ipcMain.handle(IPC_CHANNELS.DEVICE_GET_SIP_CONFIG, async (_event, ip: string) => {
    const { restGetSipConfig } = await import('./deviceRest')
    return restGetSipConfig(ip)
  })
  ipcMain.handle(IPC_CHANNELS.DEVICE_SET_SIP_PRIMARY, async (_event, ip: string, cfg: SipConfig) => {
    const { restSetSipPrimary } = await import('./deviceRest')
    return restSetSipPrimary(ip, cfg)
  })
  ipcMain.handle(IPC_CHANNELS.DEVICE_GET_STATUS, async (_event, ip: string) => {
    const { restGetDeviceStatus } = await import('./deviceRest')
    return restGetDeviceStatus(ip)
  })

  // DAYU-OT300：掃描與唯讀操作（全部經 main process 的 per-IP 佇列）
  ipcMain.handle(IPC_CHANNELS.DAYU_SCAN, async (_event, subnet: string) => {
    try {
      const { dayuScanSubnet } = await import('./dayu/dayuScanner')
      const devices = await dayuScanSubnet(subnet, (progress) => {
        mainWindow.webContents.send(IPC_CHANNELS.DAYU_SCAN_PROGRESS, progress)
      })
      return { success: true, devices }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })
  ipcMain.handle(IPC_CHANNELS.DAYU_LOGIN_CHECK, async (_event, ip: string, username: string, password: string) => {
    try {
      const { dayuLoginCheck } = await import('./dayu/dayuClient')
      return await dayuLoginCheck(ip, username, password)
    } catch (error) {
      // 避免 invoke reject 導致 renderer 端 unhandled rejection；回傳符合 DayuResult 形狀的失敗
      return { ok: false, reason: 'unreachable', detail: String(error) }
    }
  })
  ipcMain.handle(IPC_CHANNELS.DAYU_GET_MEDIA, async (_event, ip: string, username: string, password: string) => {
    try {
      const { dayuGetMedia } = await import('./dayu/dayuClient')
      return await dayuGetMedia(ip, username, password)
    } catch (error) {
      return { ok: false, reason: 'unreachable', detail: String(error) }
    }
  })
}

// ---- GPU / sandbox hardening for headless / elevated Windows Server ----
// On a GPU-less, elevated (requireAdministrator) Windows Server like the .203
// test host, Electron's sandboxed GPU child process fails to launch
// (error_code=18 → fatal "GPU process isn't usable. Goodbye." → 0x80000003 crash
// on startup, app won't open). Disable HW accel, run GPU in-process (no GPU
// child), and drop the process sandbox so no child fails to spawn. Verified on
// .203: with these, the app launches; without them it crashes immediately.
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('in-process-gpu')
app.commandLine.appendSwitch('no-sandbox')

// ---- App Lifecycle ----
app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.tcfnet.sip-cms')

  // Devices ship a per-device self-signed cert (SEC-03 hardening — see
  // docs/SEC-03-HTTPS-自簽憑證實作說明.md); :80 redirects to :443 with it.
  // A browser tab lets you click through the "certificate authority invalid"
  // warning, but this app talks to devices via programmatic fetch/XHR (no
  // click-through UI exists for that) — without this, every REST call to a
  // SEC-03 device fails with net::ERR_CERT_AUTHORITY_INVALID. This is a
  // LAN-only device management tool; trust is scoped to that use case.
  session.defaultSession.setCertificateVerifyProc((_request, callback) => {
    callback(0)
  })

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

// Cleanup temporary routes AND secondary IP aliases on app quit
app.on('will-quit', async () => {
  await cleanupAllRoutes()
  await cleanupAllAliases()
})

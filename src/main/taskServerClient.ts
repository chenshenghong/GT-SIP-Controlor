// ============================================
// SIP CMS — TaskServer Client (Main Process)
// Implements QueryTool mode=1: query TaskServer for device list
//
// Flow:
// 1. TCP connect to TaskServer (e.g., 192.168.3.200)
// 2. Send GET DBP/1.0 to TaskServer
// 3. TaskServer returns list of registered device IPs
// 4. For each IP, send GET DBP/1.0 to get full device info
//
// ⚠️ TaskServer protocol details are NOT confirmed from exe
//    analysis. This implementation is a best-effort guess based
//    on the pattern that mode=1 connects to taskserver.ip first.
//    Needs Wireshark validation on-site.
// ============================================
import * as net from 'net'
import { TASK_SERVER_DEFAULT_IP, TASK_SERVER_DEFAULT_PORT, PORT_DETECT_TIMEOUT_MS } from '@shared/constants'
import { autoDetectPort, getActivePort } from './scanner'
import type { DeviceNode, ScanProgress, ScanResult } from '@shared/types'

/**
 * Query TaskServer to get list of registered device IPs.
 *
 * The TaskServer may respond with:
 * - A list of IP addresses (one per line)
 * - A DBP/1.0 response containing device registrations
 * - A JSON response with device inventory
 *
 * Since the exact format is unknown, we try to extract
 * any valid IPv4 addresses from the response.
 */
async function queryTaskServerForDeviceList(
  serverIp: string,
  serverPort: number
): Promise<string[]> {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let responseData = ''

    socket.setTimeout(PORT_DETECT_TIMEOUT_MS * 2)

    socket.once('connect', () => {
      console.log(`[TaskServer] Connected to ${serverIp}:${serverPort}`)
      socket.write('GET DBP/1.0\r\nCSeq: 1\r\n\r\n')
    })

    socket.on('data', (chunk) => {
      responseData += chunk.toString('utf-8')
    })

    socket.once('end', () => {
      socket.destroy()
      // Extract all valid IPv4 addresses from response
      const ipRegex = /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g
      const ips: string[] = []
      let match: RegExpExecArray | null
      while ((match = ipRegex.exec(responseData)) !== null) {
        const ip = match[1]
        // Filter out masks, gateways, etc — only keep unique device IPs
        if (!ip.endsWith('.0') && !ip.endsWith('.255') && !ips.includes(ip)) {
          ips.push(ip)
        }
      }
      console.log(`[TaskServer] Extracted ${ips.length} device IPs from response`)
      resolve(ips)
    })

    socket.once('timeout', () => {
      socket.destroy()
      console.log(`[TaskServer] Connection timeout`)
      resolve([])
    })

    socket.once('error', (err) => {
      socket.destroy()
      console.log(`[TaskServer] Error: ${err.message}`)
      resolve([])
    })

    socket.connect(serverPort, serverIp)
  })
}

/**
 * Probe a single device IP via DBP GET to retrieve full DeviceNode.
 * Reuses the same logic as scanner but with longer timeout.
 */
function probeDeviceIp(ip: string, port: number): Promise<DeviceNode | null> {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let responseData = ''

    socket.setTimeout(PORT_DETECT_TIMEOUT_MS)

    socket.once('connect', () => {
      socket.write('GET DBP/1.0\r\nCSeq: 1\r\n\r\n')
    })

    socket.on('data', (chunk) => {
      responseData += chunk.toString('utf-8')
    })

    socket.once('end', () => {
      socket.destroy()
      const device = parseTaskServerDeviceResponse(responseData)
      resolve(device)
    })

    socket.once('timeout', () => {
      socket.destroy()
      resolve(null)
    })

    socket.once('error', () => {
      socket.destroy()
      resolve(null)
    })

    socket.connect(port, ip)
  })
}

/** Minimal DBP response parser (reused from scanner logic) */
function parseTaskServerDeviceResponse(raw: string): DeviceNode | null {
  const device: Partial<DeviceNode> = { status: 'ONLINE' }
  const lines = raw.split(/[\r\n]+/).filter(Boolean)
  let hasMAC = false

  for (const line of lines) {
    if (line.startsWith('DBP/')) continue
    const colonIdx = line.indexOf(':')
    if (colonIdx <= 0) continue
    const key = line.substring(0, colonIdx).trim()
    const val = line.substring(colonIdx + 1).trim()

    switch (key) {
      case 'ID':         device.id = parseInt(val, 10) || 0; break
      case 'Type':       device.type = val; break
      case 'Ver':        device.version = val; break
      case 'MAC':        device.mac = val; hasMAC = true; break
      case 'IP':         device.ip = val; break
      case 'Mask':       device.mask = val; break
      case 'Gateway':    device.gateway = val; break
      case 'AutoIP':     device.autoIp = val === '1' ? 1 : 0; break
      case 'Server':     device.server = val; break
      case 'Server2':    device.server2 = val; break
      case 'DNS1':       device.dns1 = val; break
      case 'DNS2':       device.dns2 = val; break
      case 'SN':         device.sn = val; break
      case 'Name':       device.name = val; break
      case 'HostName':   device.hostName = val; break
      case 'Mode':       device.mode = val; break
      case 'PlayVol':    device.playVol = parseInt(val, 10) || 0; break
      case 'CaptureVol': device.captureVol = parseInt(val, 10) || 0; break
      case 'VOL':        device.playVol = parseInt(val, 10) || 0; break
      case 'CAP':        device.captureVol = parseInt(val, 10) || 0; break
    }
  }

  if (!hasMAC) return null
  return device as DeviceNode
}

/**
 * TaskServer-based scan (QueryTool mode=1).
 *
 * 1. Connect to TaskServer → get device IP list
 * 2. Auto-detect DBP port on first known device
 * 3. Query each device IP for full info
 */
export async function scanViaTaskServer(
  taskServerIp: string = TASK_SERVER_DEFAULT_IP,
  taskServerPort: number = TASK_SERVER_DEFAULT_PORT,
  onProgress?: (progress: ScanProgress) => void
): Promise<ScanResult> {
  const startTime = Date.now()

  // Step 1: Get device list from TaskServer
  const deviceIps = await queryTaskServerForDeviceList(taskServerIp, taskServerPort)

  if (deviceIps.length === 0) {
    return {
      devices: [],
      scannedCount: 0,
      elapsedMs: Date.now() - startTime,
    }
  }

  // Step 2: Auto-detect port on first device
  let port = getActivePort()
  const detected = await autoDetectPort(deviceIps[0])
  if (detected) port = detected

  // Step 3: Query each device
  const devices: DeviceNode[] = []

  for (let i = 0; i < deviceIps.length; i++) {
    const ip = deviceIps[i]
    onProgress?.({ currentIp: ip, currentIndex: i + 1, total: deviceIps.length })

    const device = await probeDeviceIp(ip, port)
    if (device) {
      devices.push(device)
    }
  }

  return {
    devices,
    scannedCount: deviceIps.length,
    elapsedMs: Date.now() - startTime,
  }
}

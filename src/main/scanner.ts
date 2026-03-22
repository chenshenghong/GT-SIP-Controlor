// ============================================
// SIP CMS — TCP Subnet Scanner (Main Process)
// Aligned with QueryTool v5.0.9.L DBP/1.0 protocol:
//   Command: "GET DBP/1.0\r\nCSeq: 1\r\n\r\n"
//   Response: "Key: Value" per line (colon separator)
//   Port: Auto-detected from DBP_PORT_CANDIDATES
// ============================================
import * as net from 'net'
import {
  DBP_PORT, DBP_PORT_CANDIDATES, SCAN_TIMEOUT_MS, PORT_DETECT_TIMEOUT_MS,
} from '@shared/constants'
import type { DeviceNode, ScanProgress, ScanResult } from '@shared/types'

/**
 * DBP/1.0 discovery command — with CSeq header per QueryTool format.
 * Original exe: "GET DBP/1.0" + "CSeq: %d"
 */
const DBP_DISCOVERY_CMD = 'GET DBP/1.0\r\nCSeq: 1\r\n\r\n'

/**
 * SETTING command — queries extended SIP/MQTT/PTT parameters via JSON.
 * From QueryTool exe: SETTING DBP/1.0 + JSON key_name array
 */
const DBP_SETTING_CMD = 'SETTING DBP/1.0\r\nCSeq: 2\r\n\r\n'
const DBP_SETTING_JSON = JSON.stringify({
  key_name: [
    'RegAddr', 'ServerPort', 'RegUser', 'RegPswd',
    'OutVol', 'MicVol', 'Key1A', 'Key1B',
    'ConnectMode', 'SWversion', 'PTT', 'COR',
    'MQTT_NAME', 'MQTT_URL', 'CLIENT_ID',
    'USER_NAME', 'USER_PASSWD',
    'CHECK', 'NTP', 'ROLE',
  ],
})

/** Cached detected port — survives across scans within same session */
let detectedPort: number | null = null

/**
 * Create a default DeviceNode with all fields initialized
 */
function createDefaultDevice(): DeviceNode {
  return {
    id: 0, type: '', mac: '', sn: '', name: '', hostName: '',
    ip: '', mask: '255.255.255.0', gateway: '', autoIp: 0,
    dns1: '', dns2: '', useDns: 0,
    server: '', server2: '', mode: '', isBroadcast: 0,
    version: '',
    playVol: 0, captureVol: 0, treble: 0, bass: 0, tbAgc: 0, tbLinein: 0,
    group: 0, speed: 0, encrypt: 0, reboot: '', website: '',
    svcConfig: '', localSet: '',
    status: 'ONLINE',
  }
}

/**
 * Parse multi-line DBP/1.0 response into a DeviceNode.
 * Separator is COLON `:` (verified from exe sscanf patterns)
 */
function parseDbpResponse(raw: string): DeviceNode | null {
  const device = createDefaultDevice()
  const lines = raw.split(/[\r\n]+/).filter(Boolean)
  let hasValidData = false

  for (const line of lines) {
    // Skip status line "DBP/1.0 200 OK"
    if (line.startsWith('DBP/')) continue

    const colonIdx = line.indexOf(':')
    if (colonIdx <= 0) continue

    const key = line.substring(0, colonIdx).trim()
    const val = line.substring(colonIdx + 1).trim()

    switch (key) {
      case 'ID':         device.id = parseInt(val, 10) || 0; break
      case 'Type':       device.type = val; break
      case 'Ver':        device.version = val; break
      case 'MAC':        device.mac = val; hasValidData = true; break
      case 'IP':         device.ip = val; hasValidData = true; break
      case 'Mask':       device.mask = val; break
      case 'Gateway':    device.gateway = val; break
      case 'AutoIP':     device.autoIp = val === '1' ? 1 : 0; break
      case 'Server':     device.server = val; break
      case 'Server2':    device.server2 = val; break
      case 'DNS1':       device.dns1 = val; break
      case 'DNS2':       device.dns2 = val; break
      case 'UseDNS':     device.useDns = parseInt(val, 10) || 0; break
      case 'Website':    device.website = val; break
      case 'SN':         device.sn = val; break
      case 'Mode':       device.mode = val; break
      case 'Name':       device.name = val; break
      case 'HostName':   device.hostName = val; break
      case 'IsBroadcast': device.isBroadcast = parseInt(val, 10) || 0; break
      case 'Speed':      device.speed = parseInt(val, 10) || 0; break
      case 'Treble':     device.treble = parseInt(val, 10) || 0; break
      case 'Bass':       device.bass = parseInt(val, 10) || 0; break
      case 'TbAgc':      device.tbAgc = parseInt(val, 10) || 0; break
      case 'TbLinein':   device.tbLinein = parseInt(val, 10) || 0; break
      case 'Encrypt':    device.encrypt = parseInt(val, 10) || 0; break
      case 'LocalSet':   device.localSet = val; break
      case 'PlayVol':    device.playVol = parseInt(val, 10) || 0; break
      case 'CaptureVol': device.captureVol = parseInt(val, 10) || 0; break
      case 'VOL':        device.playVol = parseInt(val, 10) || 0; break
      case 'CAP':        device.captureVol = parseInt(val, 10) || 0; break
      case 'Group':
      case 'GROUP':      device.group = parseInt(val, 10) || 0; break
      case 'Reboot':     device.reboot = val; break
      case 'SvcConfig':  device.svcConfig = val; break
    }
  }

  if (!hasValidData) return null
  return device
}

/**
 * Auto-detect DBP port by trying each candidate on a known device IP.
 * Returns the first port that responds with "DBP/1.0" protocol.
 *
 * Strategy: try candidates in parallel, first valid response wins.
 */
export async function autoDetectPort(targetIp: string): Promise<number | null> {
  // Return cached result if available
  if (detectedPort !== null) return detectedPort

  console.log(`[DBP] Auto-detecting port on ${targetIp}, trying ${DBP_PORT_CANDIDATES.length} candidates...`)

  const tryPort = (port: number): Promise<number | null> => {
    return new Promise((resolve) => {
      const socket = new net.Socket()
      socket.setTimeout(PORT_DETECT_TIMEOUT_MS)

      socket.once('connect', () => {
        socket.write(DBP_DISCOVERY_CMD)
      })

      let responseData = ''

      socket.on('data', (chunk) => {
        responseData += chunk.toString('utf-8')
      })

      socket.once('end', () => {
        socket.destroy()
        if (responseData.includes('DBP/1.0') || responseData.includes('MAC:') || responseData.includes('MAC :')) {
          console.log(`[DBP] ✅ Port ${port} responded with DBP protocol!`)
          resolve(port)
        } else {
          resolve(null)
        }
      })

      socket.once('timeout', () => {
        socket.destroy()
        resolve(null)
      })

      socket.once('error', () => {
        socket.destroy()
        resolve(null)
      })

      socket.connect(port, targetIp)
    })
  }

  // Try all candidates in parallel — first DBP response wins
  const results = await Promise.all(DBP_PORT_CANDIDATES.map(tryPort))
  const foundPort = results.find((p) => p !== null) ?? null

  if (foundPort) {
    detectedPort = foundPort
    console.log(`[DBP] Port detection complete: using port ${foundPort}`)
  } else {
    console.log(`[DBP] ⚠️ No port responded with DBP protocol on ${targetIp}`)
  }

  return foundPort
}

/** Reset cached port (e.g., when user changes network) */
export function resetDetectedPort(): void {
  detectedPort = null
}

/** Get currently detected port or fallback */
export function getActivePort(): number {
  return detectedPort ?? DBP_PORT
}

/**
 * Probe a single IP for DBP/1.0 protocol response
 * CRITICAL: socket.destroy() is ALWAYS called, regardless of outcome
 */
function probeSingleIp(ip: string, port: number): Promise<DeviceNode | null> {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let responseData = ''

    socket.setTimeout(SCAN_TIMEOUT_MS)

    socket.once('connect', () => {
      socket.write(DBP_DISCOVERY_CMD)
    })

    socket.on('data', (chunk) => {
      responseData += chunk.toString('utf-8')
    })

    socket.once('end', () => {
      socket.destroy() // IRON RULE: always destroy
      const device = parseDbpResponse(responseData)
      resolve(device)
    })

    socket.once('timeout', () => {
      socket.destroy() // IRON RULE: always destroy
      resolve(null)
    })

    socket.once('error', (_err) => {
      socket.destroy() // IRON RULE: always destroy
      resolve(null)
    })

    socket.once('close', () => {
      resolve(null)
    })

    socket.connect(port, ip)
  })
}

// ---- Mock Data for Development ----
const MOCK_DEVICES: DeviceNode[] = [
  {
    id: 1, type: 'SIP-Speaker', mac: '00:1A:2B:3C:4D:5E', sn: 'GSC2024001', name: '1F-大廳', hostName: 'sip-speaker-001',
    ip: '192.168.1.10', mask: '255.255.255.0', gateway: '192.168.1.1', autoIp: 0,
    dns1: '8.8.8.8', dns2: '8.8.4.4', useDns: 1,
    server: '192.168.1.11:8899', server2: '', mode: 'broadcast', isBroadcast: 1,
    version: 'v2.4.12', playVol: 7, captureVol: 8, treble: 5, bass: 5, tbAgc: 1, tbLinein: 0,
    group: 1, speed: 100, encrypt: 0, reboot: 'soft,0', website: '', svcConfig: '', localSet: '1,1,1,1',
    status: 'ONLINE',
  },
  {
    id: 2, type: 'SIP-Speaker', mac: '00:1A:2B:99:88:77', sn: 'GSC2024002', name: '2F-會議室', hostName: 'sip-speaker-002',
    ip: '192.168.1.10', mask: '255.255.255.0', gateway: '192.168.1.1', autoIp: 0,
    dns1: '8.8.8.8', dns2: '', useDns: 1,
    server: '192.168.1.11:8899', server2: '', mode: 'intercom', isBroadcast: 0,
    version: 'v2.4.08', playVol: 5, captureVol: 6, treble: 3, bass: 4, tbAgc: 1, tbLinein: 0,
    group: 2, speed: 100, encrypt: 0, reboot: 'soft,0', website: '', svcConfig: '', localSet: '1,1,1,1',
    status: 'ONLINE',
  },
  {
    id: 3, type: 'SIP-Intercom', mac: '00:1A:2B:A1:B2:C3', sn: 'GSC2024003', name: '3F-走廊', hostName: 'sip-intercom-001',
    ip: '192.168.1.112', mask: '255.255.255.0', gateway: '192.168.1.1', autoIp: 1,
    dns1: '8.8.8.8', dns2: '', useDns: 0,
    server: '192.168.1.11:8899', server2: '192.168.1.12:8899', mode: 'intercom', isBroadcast: 0,
    version: 'v2.5.01-RC', playVol: 10, captureVol: 10, treble: 5, bass: 5, tbAgc: 0, tbLinein: 1,
    group: 1, speed: 100, encrypt: 1, reboot: 'soft,0', website: '', svcConfig: '', localSet: '1,1,1,1',
    status: 'ONLINE',
  },
  {
    id: 4, type: 'SIP-Speaker', mac: '00:1A:2B:F4:E5:D6', sn: 'GSC2024004', name: '4F-辦公區', hostName: 'sip-speaker-003',
    ip: '192.168.1.115', mask: '255.255.255.0', gateway: '192.168.1.1', autoIp: 0,
    dns1: '8.8.8.8', dns2: '', useDns: 1,
    server: '192.168.1.11:8899', server2: '', mode: 'paging', isBroadcast: 1,
    version: 'v2.4.12', playVol: 8, captureVol: 7, treble: 5, bass: 6, tbAgc: 1, tbLinein: 0,
    group: 3, speed: 100, encrypt: 0, reboot: 'soft,0', website: '', svcConfig: '', localSet: '1,1,1,1',
    status: 'ONLINE',
  },
  {
    id: 5, type: 'SIP-Speaker', mac: '00:1A:2B:11:22:33', sn: 'GSC2024005', name: 'B1-停車場', hostName: 'sip-speaker-004',
    ip: '192.168.1.10', mask: '255.255.255.0', gateway: '192.168.1.1', autoIp: 0,
    dns1: '8.8.8.8', dns2: '', useDns: 1,
    server: '192.168.1.11:8899', server2: '', mode: 'broadcast', isBroadcast: 1,
    version: 'v2.4.10', playVol: 12, captureVol: 5, treble: 7, bass: 8, tbAgc: 0, tbLinein: 0,
    group: 4, speed: 100, encrypt: 0, reboot: 'soft,0', website: '', svcConfig: '', localSet: '1,1,1,1',
    status: 'ONLINE',
  },
  {
    id: 6, type: 'SIP-Speaker', mac: '00:1A:2B:44:55:66', sn: 'GSC2024006', name: 'RF-頂樓', hostName: 'sip-speaker-005',
    ip: '192.168.1.130', mask: '255.255.255.0', gateway: '192.168.1.1', autoIp: 1,
    dns1: '', dns2: '', useDns: 0,
    server: '192.168.1.11:8899', server2: '', mode: 'broadcast', isBroadcast: 1,
    version: 'v2.3.09', playVol: 6, captureVol: 6, treble: 5, bass: 5, tbAgc: 1, tbLinein: 0,
    group: 1, speed: 100, encrypt: 0, reboot: 'soft,0', website: '', svcConfig: '', localSet: '1,1,1,1',
    status: 'DISCONNECTED',
  },
]

const USE_MOCK = process.env.NODE_ENV === 'development' || process.env.MOCK_SCAN === '1'

/**
 * Scan entire subnet 192.168.x.1~254
 *
 * Flow (matching QueryTool):
 * 1. Auto-detect DBP port on known device IP (192.168.x.10)
 * 2. Scan 1~254 using detected port
 * 3. Parse GET DBP/1.0 responses
 */
export async function scanSubnet(
  baseIp: string,
  onProgress?: (progress: ScanProgress) => void
): Promise<ScanResult> {
  const startTime = Date.now()
  const parts = baseIp.split('.')
  const subnet = `${parts[0]}.${parts[1]}.${parts[2]}`

  if (USE_MOCK) {
    for (let i = 1; i <= 254; i++) {
      const ip = `${subnet}.${i}`
      onProgress?.({ currentIp: ip, currentIndex: i, total: 254 })
      await new Promise((r) => setTimeout(r, 15))
    }
    return {
      devices: MOCK_DEVICES,
      scannedCount: 254,
      elapsedMs: Date.now() - startTime,
    }
  }

  // Step 1: Auto-detect port (try on factory default IP first)
  const factoryIp = `${subnet}.10` // Factory default 192.168.x.10
  let port = getActivePort()

  const detected = await autoDetectPort(factoryIp)
  if (detected) {
    port = detected
  } else {
    console.log(`[DBP] Port detection failed on ${factoryIp}, using fallback: ${port}`)
  }

  // Step 2: Scan entire subnet
  const BATCH_SIZE = 50
  const devices: DeviceNode[] = []

  for (let batch = 0; batch < 254; batch += BATCH_SIZE) {
    const promises: Promise<DeviceNode | null>[] = []
    const end = Math.min(batch + BATCH_SIZE, 254)

    for (let i = batch + 1; i <= end; i++) {
      const ip = `${subnet}.${i}`
      onProgress?.({ currentIp: ip, currentIndex: i, total: 254 })
      promises.push(probeSingleIp(ip, port))
    }

    const results = await Promise.all(promises)
    for (const device of results) {
      if (device) devices.push(device)
    }
  }

  return {
    devices,
    scannedCount: 254,
    elapsedMs: Date.now() - startTime,
  }
}

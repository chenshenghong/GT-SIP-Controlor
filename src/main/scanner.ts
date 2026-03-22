// ============================================
// SIP CMS — TCP Subnet Scanner (Main Process)
// Phase 2 Implementation
// ============================================
import * as net from 'net'
import { DBP_PORT, SCAN_TIMEOUT_MS } from '@shared/constants'
import type { DeviceNode, ScanProgress, ScanResult } from '@shared/types'

/** DBP/1.0 discovery command */
const DBP_DISCOVERY_CMD = 'DBP/1.0\r\nAction:Search\r\n\r\n'

/**
 * Parse multi-line DBP response text into a DeviceNode
 * Response format (line-per-field):
 *   mac=AA:BB:CC:DD:EE:FF
 *   ip=192.168.1.200
 *   mask=255.255.255.0
 *   gateway=192.168.1.1
 *   autoip=0
 *   version=v2.4.12
 *   mode=intercom
 */
function parseDbpResponse(raw: string): DeviceNode | null {
  const fields: Record<string, string> = {}
  const lines = raw.split(/[\r\n]+/).filter(Boolean)

  for (const line of lines) {
    const eqIdx = line.indexOf('=')
    if (eqIdx > 0) {
      const key = line.substring(0, eqIdx).trim().toLowerCase()
      const val = line.substring(eqIdx + 1).trim()
      fields[key] = val
    }
  }

  if (!fields.mac || !fields.ip) return null

  return {
    mac: fields.mac,
    ip: fields.ip,
    mask: fields.mask || '255.255.255.0',
    gateway: fields.gateway || '',
    autoIp: fields.autoip === '1' ? 1 : 0,
    version: fields.version || 'unknown',
    mode: fields.mode || 'unknown',
    status: 'ONLINE',
  }
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
      // Suppress ECONNREFUSED / ECONNRESET — host alive but not SIP
      socket.destroy() // IRON RULE: always destroy
      resolve(null)
    })

    socket.once('close', () => {
      // Safety net: if somehow we get close without prior resolution
      resolve(null)
    })

    socket.connect(port, ip)
  })
}

// ---- Mock Data for Development ----
const MOCK_DEVICES: DeviceNode[] = [
  { mac: '00:1A:2B:3C:4D:5E', ip: '192.168.1.104', mask: '255.255.255.0', gateway: '192.168.1.1', autoIp: 0, version: 'v2.4.12-STABLE', mode: 'intercom', status: 'ONLINE' },
  { mac: '00:1A:2B:99:88:77', ip: '192.168.1.105', mask: '255.255.255.0', gateway: '192.168.1.1', autoIp: 0, version: 'v2.4.08-LEGACY', mode: 'broadcast', status: 'DISCONNECTED' },
  { mac: '00:1A:2B:A1:B2:C3', ip: '192.168.1.112', mask: '255.255.255.0', gateway: '192.168.1.1', autoIp: 1, version: 'v2.5.01-RC', mode: 'intercom', status: 'ONLINE' },
  { mac: '00:1A:2B:F4:E5:D6', ip: '192.168.1.115', mask: '255.255.255.0', gateway: '192.168.1.1', autoIp: 0, version: 'v2.4.12-STABLE', mode: 'paging', status: 'ONLINE' },
  { mac: '00:1A:2B:11:22:33', ip: '192.168.1.120', mask: '255.255.255.0', gateway: '192.168.1.1', autoIp: 0, version: 'v2.4.10', mode: 'intercom', status: 'ONLINE' },
  { mac: '00:1A:2B:44:55:66', ip: '192.168.1.130', mask: '255.255.255.0', gateway: '192.168.1.1', autoIp: 1, version: 'v2.3.09', mode: 'broadcast', status: 'ONLINE' },
]

const USE_MOCK = process.env.NODE_ENV === 'development' || process.env.MOCK_SCAN === '1'

/**
 * Scan entire subnet 192.168.x.1~254
 * Uses mock data in dev mode for UI development without real network
 */
export async function scanSubnet(
  baseIp: string,
  onProgress?: (progress: ScanProgress) => void
): Promise<ScanResult> {
  const startTime = Date.now()
  const parts = baseIp.split('.')
  const subnet = `${parts[0]}.${parts[1]}.${parts[2]}`

  if (USE_MOCK) {
    // Simulate scanning with delays for UI testing
    for (let i = 1; i <= 254; i++) {
      const ip = `${subnet}.${i}`
      onProgress?.({ currentIp: ip, currentIndex: i, total: 254 })
      await new Promise((r) => setTimeout(r, 15)) // ~4 seconds total
    }
    return {
      devices: MOCK_DEVICES,
      scannedCount: 254,
      elapsedMs: Date.now() - startTime,
    }
  }

  // Real scan: batch probe in groups of 50 to avoid fd exhaustion
  const BATCH_SIZE = 50
  const devices: DeviceNode[] = []

  for (let batch = 0; batch < 254; batch += BATCH_SIZE) {
    const promises: Promise<DeviceNode | null>[] = []
    const end = Math.min(batch + BATCH_SIZE, 254)

    for (let i = batch + 1; i <= end; i++) {
      const ip = `${subnet}.${i}`
      onProgress?.({ currentIp: ip, currentIndex: i, total: 254 })
      promises.push(probeSingleIp(ip, DBP_PORT))
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

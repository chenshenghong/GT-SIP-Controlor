// ============================================
// SIP CMS — DBP/1.0 UDP broadcast discovery (Main Process)
//
// Verified by capturing QueryTool v5.0.9.L:
//   Request : UDP -> 255.255.255.255:58001
//             "GET DBP/1.0\r\nCSeq: 1\r\nIFCFG-APP:<b64>\r\nIsBroadcast: 1\r\n\r\n"
//   Reply   : <device_ip>:58001 -> 255.255.255.255:<requester_src_port>
//             "DBP/1.0 200 OK\r\n<Key: Value>..."
//
// Replies are BROADCAST, so devices on OTHER subnets on the same L2 segment are
// found too (this is why it works cross-subnet where TCP/REST cannot).
// ============================================
import * as dgram from 'dgram'
import type { DeviceNode } from '@shared/types'

const DBP_PORT = 58001
const gbk = new TextDecoder('gbk')

// Extended-settings keys QueryTool asks for (mirrors its IFCFG-APP payload)
const KEY_NAMES = [
  'RegAddr', 'ServerPort', 'RegUser', 'RegPswd', 'OutVol', 'MicVol',
  'Key1A', 'Key1B', 'ConnectMode', 'SWversion', 'PTT', 'COR',
  'MQTT_NAME', 'MQTT_URL', 'CLIENT_ID', 'USER_NAME', 'USER_PASSWD',
  'CHECK', 'NTP', 'ROLE',
]
const IFCFG_B64 = Buffer.from(JSON.stringify({ key_name: KEY_NAMES })).toString('base64')
const REQUEST = Buffer.from(
  `GET DBP/1.0\r\nCSeq: 1\r\nIFCFG-APP:${IFCFG_B64}\r\nIsBroadcast: 1\r\n\r\n`,
  'ascii'
)

function createDefaultDevice(): DeviceNode {
  return {
    id: 0, type: '', mac: '', sn: '', name: '', hostName: '',
    ip: '', mask: '255.255.255.0', gateway: '', autoIp: 0, dns1: '', dns2: '', useDns: 0,
    server: '', server2: '', mode: '', isBroadcast: 0, version: '',
    playVol: 0, captureVol: 0, treble: 0, bass: 0, tbAgc: 0, tbLinein: 0,
    group: 0, speed: 0, encrypt: 0, reboot: '', website: '', svcConfig: '', localSet: '',
    status: 'ONLINE',
  }
}

/** Parse a "DBP/1.0 200 OK" reply (Key: Value per line) into a DeviceNode. */
function parseDbpReply(raw: string): DeviceNode | null {
  if (!raw.includes('DBP/')) return null
  const d = createDefaultDevice()
  let hasMac = false
  for (const line of raw.split(/[\r\n]+/)) {
    if (line.startsWith('DBP/')) continue
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    const val = line.slice(idx + 1).trim()
    switch (key) {
      case 'ID': d.id = parseInt(val, 10) || 0; break
      case 'Type': d.type = val; break
      case 'Ver': d.version = val; break
      case 'Name': d.name = val; break
      case 'MAC': d.mac = val; hasMac = true; break
      case 'IP': d.ip = val; break
      case 'Mask': d.mask = val; break
      case 'Gateway': d.gateway = val; break
      case 'Server': d.server = val; break
      case 'Server2': d.server2 = val; break
      case 'DNS1': d.dns1 = val; break
      case 'DNS2': d.dns2 = val; break
      case 'UseDNS': d.useDns = parseInt(val, 10) || 0; break
      case 'AutoIP': d.autoIp = val === '1' ? 1 : 0; break
      case 'GROUP':
      case 'Group': d.group = parseInt(val, 10) || 0; break
      case 'VOL': d.playVol = parseInt(val, 10) || 0; break
      case 'CAP': d.captureVol = parseInt(val, 10) || 0; break
      case 'AGC': d.tbAgc = parseInt(val, 10) || 0; break
      case 'Mode': d.mode = val; break
      case 'IFCFG-APP': {
        // base64 of {"key_name":[...], "RegAddr":..., "RegUser":..., "OutVol":...}
        try {
          const s = JSON.parse(Buffer.from(val, 'base64').toString('utf-8')) as Record<string, string>
          if (s.RegUser) d.regUser = s.RegUser
          if (s.RegAddr) d.regAddr = s.RegAddr
          if (s.ServerPort) d.regPort = s.ServerPort
          if (s.OutVol != null && s.OutVol !== '') d.outVol = parseInt(s.OutVol, 10)
          if (s.MicVol != null && s.MicVol !== '') d.micVol = parseInt(s.MicVol, 10)
          if (s.ConnectMode) d.connectMode = s.ConnectMode
        } catch { /* ignore malformed IFCFG-APP */ }
        break
      }
    }
  }
  if (!hasMac) return null
  if (!d.name) d.name = d.type || d.ip
  return d
}

/**
 * Broadcast a DBP discovery request and collect replies for `timeoutMs`.
 * Finds devices on ALL subnets of the local L2 segment.
 */
export function dbpDiscover(
  timeoutMs = 4000,
  onProgress?: (found: number) => void
): Promise<DeviceNode[]> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    const found = new Map<string, DeviceNode>()
    let settled = false

    const finish = () => {
      if (settled) return
      settled = true
      try { sock.close() } catch { /* ignore */ }
      resolve(Array.from(found.values()))
    }

    sock.on('message', (msg) => {
      const dev = parseDbpReply(gbk.decode(new Uint8Array(msg)))
      if (dev && dev.mac && !found.has(dev.mac)) {
        found.set(dev.mac, dev)
        onProgress?.(found.size)
      }
    })
    sock.on('error', finish)

    sock.bind(() => {
      try {
        sock.setBroadcast(true)
      } catch { /* ignore */ }
      const blast = () => {
        if (!settled) sock.send(REQUEST, DBP_PORT, '255.255.255.255', () => { /* ignore */ })
      }
      // Send a few times — UDP can drop, and devices may be busy
      blast()
      setTimeout(blast, 300)
      setTimeout(blast, 900)
      setTimeout(finish, timeoutMs)
    })
  })
}

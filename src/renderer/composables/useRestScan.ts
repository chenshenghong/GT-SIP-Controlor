// ============================================
// SIP CMS — REST-based device discovery
// Sweeps a /24 subnet's :80 and probes /get/network/config (no auth) to find
// REST-only SIP terminals that DBP scan cannot discover.
// ============================================
import axios from 'axios'
import type { DeviceNode } from '@shared/types'

const gbk = new TextDecoder('gbk')

/** GBK decode + firmware dirty-JSON repair (broadcast_volume quote + missing brace) */
function cleanParse(buf: ArrayBuffer): Record<string, unknown> | null {
  try {
    let t = gbk
      .decode(new Uint8Array(buf))
      .replace(/"broadcast_volume:/g, '"broadcast_volume":')
      .trim()
    const opens = (t.match(/{/g) || []).length
    const closes = (t.match(/}/g) || []).length
    if (opens > closes) t += '}'.repeat(opens - closes)
    return JSON.parse(t)
  } catch {
    return null
  }
}

async function probe(ip: string, path: string, timeout: number): Promise<Record<string, unknown> | null> {
  try {
    const res = await axios.get(`http://${ip}${path}`, { timeout, responseType: 'arraybuffer' })
    return cleanParse(res.data as ArrayBuffer)
  } catch {
    return null
  }
}

function makeNode(ip: string): DeviceNode {
  return {
    id: 0, type: 'SIP-Player', mac: '', sn: '', name: ip, hostName: '',
    ip, mask: '255.255.255.0', gateway: '', autoIp: 0, dns1: '', dns2: '', useDns: 0,
    server: '', server2: '', mode: '', isBroadcast: 0, version: '',
    playVol: 0, captureVol: 0, treble: 0, bass: 0, tbAgc: 0, tbLinein: 0,
    group: 0, speed: 0, encrypt: 0, reboot: '', website: '', svcConfig: '', localSet: '',
    status: 'ONLINE',
  }
}

/** Probe one IP; returns a DeviceNode if it answers like a SIP terminal. */
async function probeDevice(ip: string): Promise<DeviceNode | null> {
  // Fast discriminator: /get/network/config is auth-free and file-backed (quick)
  const net = await probe(ip, '/get/network/config', 2500)
  if (!net || typeof net.ip_address !== 'string' || typeof net.network_mode !== 'string') {
    return null
  }
  const node = makeNode((net.ip_address as string) || ip)
  node.mask = (net.subnet_mask as string) || node.mask
  node.gateway = (net.gateway as string) || ''
  node.dns1 = (net.dns as string) || ''

  // Enrich (mac / model / version / volume) from /get/device/status
  const st = await probe(ip, '/get/device/status', 3500)
  const sip = (st?.sip_status ?? {}) as Record<string, unknown>
  const di = sip.device_info as Record<string, unknown> | undefined
  const ni = sip.network_info as Record<string, unknown> | undefined
  if (di) {
    node.type = (di.model as string) || node.type
    node.version = (di.software_version as string) || ''
    node.playVol = Number(di.broadcast_volume ?? 0)
    node.captureVol = Number(di.microphone_volume ?? 0)
    node.name = (di.model as string) || ip
  }
  if (ni) node.mac = (ni.mac_address as string) || ''
  return node
}

export interface RestScanProgress {
  done: number
  total: number
  found: number
}

/**
 * Sweep `${subnetBase}.1`..`.254` for REST SIP terminals.
 * @param subnetBase e.g. "192.168.0"
 */
export async function restScanSubnet(
  subnetBase: string,
  onProgress?: (p: RestScanProgress) => void
): Promise<DeviceNode[]> {
  const found: DeviceNode[] = []
  const BATCH = 32
  let done = 0
  for (let start = 1; start <= 254; start += BATCH) {
    const end = Math.min(start + BATCH - 1, 254)
    const batch: Promise<DeviceNode | null>[] = []
    for (let i = start; i <= end; i++) batch.push(probeDevice(`${subnetBase}.${i}`))
    const results = await Promise.all(batch)
    for (const r of results) if (r) found.push(r)
    done = end
    onProgress?.({ done, total: 254, found: found.length })
  }
  return found
}

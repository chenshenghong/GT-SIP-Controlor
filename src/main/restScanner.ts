// ============================================
// SIP CMS — REST device discovery (Main Process)
//
// The DBP scan can't find REST-only devices (SIP-Player-2024). This sweeps a
// /24 for SIP terminals using a reliable two-stage probe:
//   1. TCP connect to :80  — fast, 100% reliable discriminator
//   2. HTTP GET /get/network/config (no auth) WITH RETRIES — the device web
//      server is single-threaded and times out ~60% of the time, so a single
//      shot misses it; retrying on the few :80-open hosts is cheap and robust.
// Runs in main (Node http) so there is no CORS / renderer flakiness.
// ============================================
import * as net from 'net'
import * as http from 'http'
import type { DeviceNode, RestScanProgress } from '@shared/types'

const gbk = new TextDecoder('gbk')

/** GBK decode + firmware dirty-JSON repair (broadcast_volume quote + missing brace) */
function cleanParse(buf: Buffer): Record<string, unknown> | null {
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

/** Fast, reliable "is there a web server here" check. */
function tcpOpen(ip: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = new net.Socket()
    s.setTimeout(timeoutMs)
    s.once('connect', () => { s.destroy(); resolve(true) })
    s.once('timeout', () => { s.destroy(); resolve(false) })
    s.once('error', () => { s.destroy(); resolve(false) })
    s.connect(port, ip)
  })
}

function httpGet(ip: string, path: string, timeoutMs: number): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const req = http.get({ host: ip, port: 80, path, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c) => chunks.push(c as Buffer))
      res.on('end', () => resolve(cleanParse(Buffer.concat(chunks))))
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
  })
}

/** Retry an HTTP GET — the device times out often, so try a few times. */
async function httpGetRetry(
  ip: string, path: string, timeoutMs: number, tries: number
): Promise<Record<string, unknown> | null> {
  for (let i = 0; i < tries; i++) {
    const r = await httpGet(ip, path, timeoutMs)
    if (r) return r
  }
  return null
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

async function probeRest(ip: string): Promise<DeviceNode | null> {
  // Stage 1 — reliable discriminator
  if (!(await tcpOpen(ip, 80, 600))) return null

  // Stage 2 — confirm it's a SIP terminal (retry the flaky web server)
  const netcfg = await httpGetRetry(ip, '/get/network/config', 3000, 6)
  if (!netcfg || typeof netcfg.ip_address !== 'string' || typeof netcfg.network_mode !== 'string') {
    return null
  }
  const node = makeNode((netcfg.ip_address as string) || ip)
  node.mask = (netcfg.subnet_mask as string) || node.mask
  node.gateway = (netcfg.gateway as string) || ''
  node.dns1 = (netcfg.dns as string) || ''

  // Stage 3 — best-effort enrichment (mac / model / version / volume)
  const st = await httpGetRetry(ip, '/get/device/status', 4000, 3)
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

/**
 * Sweep `${subnet}.1`..`.254` for REST SIP terminals.
 * @param subnet e.g. "192.168.0"
 */
export async function restScanSubnet(
  subnet: string,
  onProgress?: (p: RestScanProgress) => void
): Promise<DeviceNode[]> {
  const found: DeviceNode[] = []
  const BATCH = 40
  let done = 0
  for (let start = 1; start <= 254; start += BATCH) {
    const end = Math.min(start + BATCH - 1, 254)
    const batch: Promise<DeviceNode | null>[] = []
    for (let i = start; i <= end; i++) batch.push(probeRest(`${subnet}.${i}`))
    const results = await Promise.all(batch)
    for (const r of results) if (r) found.push(r)
    done = end
    onProgress?.({ done, total: 254, found: found.length })
  }
  // De-dupe by MAC (fallback IP)
  const seen = new Set<string>()
  const uniq: DeviceNode[] = []
  for (const d of found) {
    const k = d.mac || d.ip
    if (!seen.has(k)) { seen.add(k); uniq.push(d) }
  }
  return uniq
}

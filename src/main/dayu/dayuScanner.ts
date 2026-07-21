// ============================================
// DAYU-OT300 網段指紋掃描（比照 restScanner 的分批掃法）。
// 指紋＝兩段皆命中才收（Codex 審查：單靠 <title>Login</title> 太寬鬆，
// 且指紋階段絕不送出帳密）：
//   1. GET /  → `Server: Rapid Logic` header
//   2. GET /key==nonce → 200 且 body 非空短字串（DAYU 專屬登入端點）
// MAC 在不登入的情況下拿不到 → 留空，store 以 IP fallback 去重；
// 供裝身分問題留待 Phase 3（registry 需要穩定身分時）處理。
// ============================================
import * as net from 'net'
import { rawGet } from './dayuClient'
import type { DeviceNode, RestScanProgress } from '@shared/types'

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

function makeDayuNode(ip: string): DeviceNode {
  return {
    deviceKind: 'dayu-ot300',
    id: 0, type: 'DAYU-OT300', mac: '', sn: '', name: ip, hostName: '',
    ip, mask: '255.255.255.0', gateway: '', autoIp: 0, dns1: '', dns2: '', useDns: 0,
    server: '', server2: '', mode: '', isBroadcast: 0, version: '',
    playVol: 0, captureVol: 0, treble: 0, bass: 0, tbAgc: 0, tbLinein: 0,
    group: 0, speed: 0, encrypt: 0, reboot: '', website: '', svcConfig: '', localSet: '',
    status: 'ONLINE',
  }
}

export async function probeDayu(ip: string, port = 80): Promise<DeviceNode | null> {
  if (!(await tcpOpen(ip, port, 600))) return null
  try {
    // 指紋 1：Server header
    const index = await rawGet(ip, port, '/', undefined, 3000)
    const server = String(index.headers['server'] ?? '')
    if (!/rapid\s*logic/i.test(server)) return null
    // 指紋 2：nonce 端點（DAYU 專屬；不送任何帳密）
    const nonce = await rawGet(ip, port, `/key==nonce?now=${Date.now()}`, undefined, 3000)
    const body = nonce.body.trim()
    if (nonce.code !== 200 || !body || body.length > 64 || body.includes('<')) return null
    return makeDayuNode(ip)
  } catch {
    return null
  }
}

/** 掃 `${subnet}.1`..`.254`，分批 40 併發（不同 IP 互不影響）。 */
export async function dayuScanSubnet(
  subnet: string,
  onProgress?: (p: RestScanProgress) => void
): Promise<DeviceNode[]> {
  const found: DeviceNode[] = []
  const BATCH = 40
  for (let start = 1; start <= 254; start += BATCH) {
    const end = Math.min(start + BATCH - 1, 254)
    const batch: Promise<DeviceNode | null>[] = []
    for (let i = start; i <= end; i++) batch.push(probeDayu(`${subnet}.${i}`))
    const results = await Promise.all(batch)
    for (const r of results) if (r) found.push(r)
    onProgress?.({ done: end, total: 254, found: found.length })
  }
  return found
}

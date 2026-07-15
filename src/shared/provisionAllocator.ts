import type { ProvisionConfig, ProvisionRecord } from './types'

export function ipToLong(ip: string): number {
  const p = ip.split('.').map(Number)
  if (p.length !== 4 || p.some((o) => Number.isNaN(o) || o < 0 || o > 255)) {
    throw new Error(`無效 IP: ${ip}`)
  }
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]
}

export function longToIp(n: number): string {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.')
}

export function enumerateIps(start: string, end: string): string[] {
  const s = ipToLong(start)
  const e = ipToLong(end)
  const out: string[] = []
  for (let n = s; n <= e; n++) out.push(longToIp(n))
  return out
}

function enumerateExts(start: number, end: number): number[] {
  const out: number[] = []
  for (let n = start; n <= end; n++) out.push(n)
  return out
}

/**
 * 依序取第一個可用 IP 與第一個可用分機。佔用判斷以登記表為主（永久記錄）；
 * 本輪掃描 IP 清單僅作即時衝突預防的輔助（避免撞上尚未登記卻已在線的設備）。
 * IP 池與分機池序號各自獨立，兩者無對應關係。任一池用盡回傳 null。
 */
export function allocate(
  config: ProvisionConfig,
  records: ProvisionRecord[],
  scanIps: Set<string>
): { ip: string; ext: number } | null {
  const usedIps = new Set(records.map((r) => r.assignedIp))
  const usedExts = new Set(records.map((r) => r.assignedExt))
  const ip = enumerateIps(config.ipStart, config.ipEnd).find(
    (candidate) => !usedIps.has(candidate) && !scanIps.has(candidate)
  )
  const ext = enumerateExts(config.extStart, config.extEnd).find((candidate) => !usedExts.has(candidate))
  if (ip === undefined || ext === undefined) return null
  return { ip, ext }
}

export function poolUsage(config: ProvisionConfig, records: ProvisionRecord[]) {
  const ipTotal = enumerateIps(config.ipStart, config.ipEnd).length
  const extTotal = config.extEnd - config.extStart + 1
  const usedIps = new Set(records.map((r) => r.assignedIp))
  const usedExts = new Set(records.map((r) => r.assignedExt))
  return { ipUsed: usedIps.size, ipTotal, extUsed: usedExts.size, extTotal }
}

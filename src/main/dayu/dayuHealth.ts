// ============================================
// DAYU per-IP negative cache（指數退避 60s→5min）。
// 用途：wedge 後「只有完全零流量才會恢復」（真機實測靜置 ~20 分鐘自癒），
// 持續探測/重試會妨礙恢復。此 cache 讓「開頁自動讀」等入口在退避窗內
// 直接回 busy、零流量，防止把已 wedge 的設備反覆猛打。
// 只有 busy/unreachable（wedge 訊號）計失敗；auth-failed 是使用者帳密
// 問題（伺服器活著），不觸發退避。
// ============================================

interface HealthState {
  strikes: number
  blockedUntil: number
}

const BACKOFF_STEPS_MS = [60_000, 120_000, 240_000, 300_000]

const health = new Map<string, HealthState>()

export function checkDayuHealth(ip: string): { blocked: boolean; retryInMs: number } {
  const h = health.get(ip)
  if (!h || Date.now() >= h.blockedUntil) return { blocked: false, retryInMs: 0 }
  return { blocked: true, retryInMs: h.blockedUntil - Date.now() }
}

export function reportDayuFailure(ip: string): void {
  const h = health.get(ip) ?? { strikes: 0, blockedUntil: 0 }
  const step = BACKOFF_STEPS_MS[Math.min(h.strikes, BACKOFF_STEPS_MS.length - 1)]
  health.set(ip, { strikes: h.strikes + 1, blockedUntil: Date.now() + step })
}

export function reportDayuSuccess(ip: string): void {
  health.delete(ip)
}

export function backoffDetail(g: { retryInMs: number }): string {
  return `設備保護退避中，約 ${Math.ceil(g.retryInMs / 1000)} 秒後可重試`
}

export function __clearHealthForTesting(): void {
  health.clear()
}

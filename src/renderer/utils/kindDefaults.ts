// 切換設備型號時的預設帳密規則。只有在密碼「仍是前一型號的出廠預設」
// 或為空時才帶入新型號預設 — 絕不覆寫使用者已輸入的自訂密碼
// （Phase 1 最終審查 backlog：applyKindDefaults 無條件覆寫 bug）。
import type { DeviceKind } from '@shared/types'

export const KIND_DEFAULT_PASSWORDS: Record<DeviceKind, string> = {
  'gt-sip-gw': '123456',
  'dayu-ot300': 'admin',
}

export function nextPasswordForKind(
  current: string, prevKind: DeviceKind, nextKind: DeviceKind
): string {
  const untouched = current === '' || current === KIND_DEFAULT_PASSWORDS[prevKind]
  return untouched ? KIND_DEFAULT_PASSWORDS[nextKind] : current
}

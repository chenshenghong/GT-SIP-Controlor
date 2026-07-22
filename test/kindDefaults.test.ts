import { nextPasswordForKind, KIND_DEFAULT_PASSWORDS } from '../src/renderer/utils/kindDefaults'

describe('nextPasswordForKind（切換型號帶預設，但絕不覆寫使用者輸入）', () => {
  it('密碼仍是前一型號預設 → 帶入新型號預設', () => {
    expect(nextPasswordForKind('123456', 'gt-sip-gw', 'dayu-ot300')).toBe('admin')
    expect(nextPasswordForKind('admin', 'dayu-ot300', 'gt-sip-gw')).toBe('123456')
  })

  it('密碼為空 → 帶入新型號預設', () => {
    expect(nextPasswordForKind('', 'gt-sip-gw', 'dayu-ot300')).toBe('admin')
  })

  it('使用者已輸入自訂密碼 → 保留不動（Phase 1 bug 的回歸測試）', () => {
    expect(nextPasswordForKind('mySecret', 'gt-sip-gw', 'dayu-ot300')).toBe('mySecret')
  })

  it('預設表覆蓋兩個 kind', () => {
    expect(KIND_DEFAULT_PASSWORDS['gt-sip-gw']).toBe('123456')
    expect(KIND_DEFAULT_PASSWORDS['dayu-ot300']).toBe('admin')
  })
})

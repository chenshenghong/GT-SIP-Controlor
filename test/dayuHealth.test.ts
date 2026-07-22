import {
  checkDayuHealth, reportDayuFailure, reportDayuSuccess, backoffDetail, __clearHealthForTesting,
} from '../src/main/dayu/dayuHealth'

describe('dayuHealth negative cache', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(1_000_000_000)
    __clearHealthForTesting()
  })
  afterEach(() => jest.useRealTimers())

  it('無失敗紀錄 → 不阻擋', () => {
    expect(checkDayuHealth('10.0.0.1').blocked).toBe(false)
  })

  it('一次失敗 → 阻擋 60s，期滿自動解除', () => {
    reportDayuFailure('10.0.0.1')
    expect(checkDayuHealth('10.0.0.1').blocked).toBe(true)
    jest.setSystemTime(1_000_000_000 + 59_000)
    expect(checkDayuHealth('10.0.0.1').blocked).toBe(true)
    jest.setSystemTime(1_000_000_000 + 61_000)
    expect(checkDayuHealth('10.0.0.1').blocked).toBe(false)
  })

  it('連續失敗指數退避 60s→120s→240s→300s（封頂）', () => {
    reportDayuFailure('10.0.0.1') // 60s
    jest.setSystemTime(1_000_000_000 + 61_000)
    reportDayuFailure('10.0.0.1') // 120s
    jest.setSystemTime(1_000_000_000 + 61_000 + 119_000)
    expect(checkDayuHealth('10.0.0.1').blocked).toBe(true)
    jest.setSystemTime(1_000_000_000 + 61_000 + 121_000)
    expect(checkDayuHealth('10.0.0.1').blocked).toBe(false)
    reportDayuFailure('10.0.0.1') // 240s
    reportDayuFailure('10.0.0.1') // 300s（第 4 次起封頂）
    reportDayuFailure('10.0.0.1') // 仍 300s
    const g = checkDayuHealth('10.0.0.1')
    expect(g.retryInMs).toBeLessThanOrEqual(300_000)
    expect(g.retryInMs).toBeGreaterThan(240_000)
  })

  it('成功回報清除紀錄', () => {
    reportDayuFailure('10.0.0.1')
    reportDayuSuccess('10.0.0.1')
    expect(checkDayuHealth('10.0.0.1').blocked).toBe(false)
  })

  it('不同 IP 互不影響', () => {
    reportDayuFailure('10.0.0.1')
    expect(checkDayuHealth('10.0.0.2').blocked).toBe(false)
  })

  it('backoffDetail 回傳含正確進位秒數與繁中退避文案', () => {
    expect(backoffDetail({ retryInMs: 61_000 })).toBe('設備保護退避中，約 61 秒後可重試')
    expect(backoffDetail({ retryInMs: 500 })).toBe('設備保護退避中，約 1 秒後可重試')
    expect(backoffDetail({ retryInMs: 60_000 })).toContain('退避')
  })
})

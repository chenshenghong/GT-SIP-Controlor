import { enqueueDayu, __clearQueuesForTesting } from '../src/main/dayu/dayuQueue'

describe('enqueueDayu', () => {
  beforeEach(() => {
    __clearQueuesForTesting()
  })

  it('同 IP 任務嚴格序列化，且間隔 >= minIntervalMs', async () => {
    const marks: Array<{ label: string; at: number }> = []
    const job = (label: string) => async () => {
      marks.push({ label: `${label}:start`, at: Date.now() })
      await new Promise((r) => setTimeout(r, 20))
      marks.push({ label: `${label}:end`, at: Date.now() })
      return label
    }
    const [a, b] = await Promise.all([
      enqueueDayu('10.0.0.1', job('A'), 100),
      enqueueDayu('10.0.0.1', job('B'), 100),
    ])
    expect(a).toBe('A')
    expect(b).toBe('B')
    expect(marks.map((m) => m.label)).toEqual(['A:start', 'A:end', 'B:start', 'B:end'])
    const aEnd = marks.find((m) => m.label === 'A:end')!.at
    const bStart = marks.find((m) => m.label === 'B:start')!.at
    expect(bStart - aEnd).toBeGreaterThanOrEqual(95) // 容忍 timer 誤差
  })

  it('不同 IP 互不阻塞', async () => {
    const t0 = Date.now()
    await Promise.all([
      enqueueDayu('10.0.0.1', async () => new Promise((r) => setTimeout(r, 80)), 1000),
      enqueueDayu('10.0.0.2', async () => new Promise((r) => setTimeout(r, 80)), 1000),
    ])
    expect(Date.now() - t0).toBeLessThan(400) // 若被串行化會 >1080ms
  })

  it('前一個任務 throw 不會卡死佇列', async () => {
    await expect(
      enqueueDayu('10.0.0.3', async () => { throw new Error('boom') }, 10)
    ).rejects.toThrow('boom')
    const r = await enqueueDayu('10.0.0.3', async () => 'ok', 10)
    expect(r).toBe('ok')
  })
})

import { dayuGetMedia, __clearSessionsForTesting } from '../src/main/dayu/dayuClient'
import { __clearQueuesForTesting } from '../src/main/dayu/dayuQueue'
import { __clearHealthForTesting } from '../src/main/dayu/dayuHealth'
import { startFakeDayu, FakeDayu } from './helpers/fakeDayuServer'

describe('dayuGetMedia 邊界（busy 傳遞與 negative cache）', () => {
  let srv: FakeDayu
  beforeEach(() => {
    __clearSessionsForTesting()
    __clearQueuesForTesting()
    __clearHealthForTesting()
  })
  afterEach(async () => { if (srv) await srv.close() })

  it('nonce 連續回空 → busy，且下一次呼叫被 negative cache 短路（零流量）', async () => {
    srv = await startFakeDayu({ emptyNoncesBeforeReal: 99 })
    const r1 = await dayuGetMedia('127.0.0.1', 'admin', 'admin', srv.port)
    expect(r1.ok).toBe(false)
    if (!r1.ok) expect(r1.reason).toBe('busy')
    const hitsAfterFirst = srv.nonceHits
    __clearQueuesForTesting() // 只重置佇列間隔；health 保留
    const r2 = await dayuGetMedia('127.0.0.1', 'admin', 'admin', srv.port)
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.reason).toBe('busy')
    expect(srv.nonceHits).toBe(hitsAfterFirst) // 第二次完全沒碰網路
  }, 30000)

  it('連不上 → unreachable，之後同樣進入退避', async () => {
    const r1 = await dayuGetMedia('127.0.0.1', 'admin', 'admin', 1)
    expect(r1.ok).toBe(false)
    if (!r1.ok) expect(r1.reason).toBe('unreachable')
    __clearQueuesForTesting()
    const r2 = await dayuGetMedia('127.0.0.1', 'admin', 'admin', 1)
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.reason).toBe('busy') // negative cache 短路
  }, 30000)
})

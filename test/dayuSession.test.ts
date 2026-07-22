import {
  dayuGetMedia, __clearSessionsForTesting, __expireSessionsForTesting,
} from '../src/main/dayu/dayuClient'
import { __clearQueuesForTesting } from '../src/main/dayu/dayuQueue'
import { __clearHealthForTesting } from '../src/main/dayu/dayuHealth'
import { startFakeDayu, FakeDayu } from './helpers/fakeDayuServer'

describe('session 重用與惰性重登', () => {
  let srv: FakeDayu
  beforeEach(() => {
    __clearSessionsForTesting()
    __clearQueuesForTesting()
    __clearHealthForTesting()
  })
  afterEach(async () => { if (srv) await srv.close() })

  it('連兩次 dayuGetMedia 只登入一次（session 重用）', async () => {
    srv = await startFakeDayu({ volume: 6 })
    const r1 = await dayuGetMedia('127.0.0.1', 'admin', 'admin', srv.port)
    __clearQueuesForTesting() // 重置佇列間隔，避免測試等 4s
    const r2 = await dayuGetMedia('127.0.0.1', 'admin', 'admin', srv.port)
    expect(r1.ok && r2.ok).toBe(true)
    expect(srv.loginCount).toBe(1)
  }, 20000)

  it('session TTL 過期 → 下次操作自動重登', async () => {
    srv = await startFakeDayu({ volume: 6 })
    await dayuGetMedia('127.0.0.1', 'admin', 'admin', srv.port)
    __expireSessionsForTesting()
    __clearQueuesForTesting()
    const r = await dayuGetMedia('127.0.0.1', 'admin', 'admin', srv.port)
    expect(r.ok).toBe(true)
    expect(srv.loginCount).toBe(2)
  }, 20000)

  it('server 端 session 失效（回登入頁）→ 清快取重登一次後成功', async () => {
    srv = await startFakeDayu({ volume: 6 })
    await dayuGetMedia('127.0.0.1', 'admin', 'admin', srv.port)
    srv.invalidateSessions() // 夾具：清掉 server 端已認證 cookie
    __clearQueuesForTesting()
    const r = await dayuGetMedia('127.0.0.1', 'admin', 'admin', srv.port)
    expect(r.ok).toBe(true)
    expect(srv.loginCount).toBe(2) // 只重登一次
  }, 20000)
})

import { dayuLogin } from '../src/main/dayu/dayuClient'
import { startFakeDayu, FakeDayu } from './helpers/fakeDayuServer'

describe('dayuLogin', () => {
  let srv: FakeDayu
  afterEach(async () => { if (srv) await srv.close() })

  it('nonce → auth cookie → MD5 POST 登入成功', async () => {
    srv = await startFakeDayu()
    const r = await dayuLogin('127.0.0.1', 'admin', 'admin', srv.port)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.cookie).toContain('auth=')
    expect(srv.loginCount).toBe(1)
  })

  it('錯誤密碼 → auth-failed（伺服器回登入頁）', async () => {
    srv = await startFakeDayu()
    const r = await dayuLogin('127.0.0.1', 'admin', 'wrong', srv.port)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('auth-failed')
  })

  it('nonce 回空值時重試後成功（設備過載行為）', async () => {
    srv = await startFakeDayu({ emptyNoncesBeforeReal: 2 })
    const r = await dayuLogin('127.0.0.1', 'admin', 'admin', srv.port)
    expect(r.ok).toBe(true)
  }, 15000)

  it('連不上 → unreachable', async () => {
    const r = await dayuLogin('127.0.0.1', 'admin', 'admin', 1) // port 1 必拒
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('unreachable')
  })
})

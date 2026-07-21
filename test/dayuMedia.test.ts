import { dayuLogin, getMediaInfo } from '../src/main/dayu/dayuClient'
import { startFakeDayu, FakeDayu } from './helpers/fakeDayuServer'

describe('getMediaInfo', () => {
  let srv: FakeDayu
  afterEach(async () => { if (srv) await srv.close() })

  async function loginTo(s: FakeDayu) {
    const r = await dayuLogin('127.0.0.1', 'admin', 'admin', s.port)
    if (!r.ok) throw new Error('login failed in test setup')
    return r.value
  }

  it('讀取完整頁面 → speakerVolume 0-9 原始值與 codec 順序', async () => {
    srv = await startFakeDayu({ volume: 7 })
    const session = await loginTo(srv)
    const r = await getMediaInfo(session)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.speakerVolume).toBe(7)
      expect(r.value.codecOrder).toBe('G722,PCMU,PCMA,G729')
    }
  })

  it('前兩次回半頁（無音量欄位）→ 自動 retry 到完整頁', async () => {
    srv = await startFakeDayu({ volume: 5, halfPagesBeforeFull: 2 })
    const session = await loginTo(srv)
    const r = await getMediaInfo(session)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.speakerVolume).toBe(5)
  }, 15000)

  it('session 失效（回登入頁）→ auth-failed', async () => {
    srv = await startFakeDayu()
    const session = await loginTo(srv)
    const r = await getMediaInfo({ ...session, cookie: 'auth=stale' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('auth-failed')
  })

  it('retry 用盡仍是半頁 → parse-failed', async () => {
    srv = await startFakeDayu({ halfPagesBeforeFull: 99 })
    const session = await loginTo(srv)
    const r = await getMediaInfo(session, 2)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('parse-failed')
  }, 15000)
})

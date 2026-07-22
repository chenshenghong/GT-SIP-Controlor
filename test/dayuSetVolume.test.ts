import { dayuSetVolume } from '../src/main/dayu/dayuWrite'
import { __clearSessionsForTesting } from '../src/main/dayu/dayuClient'
import { __clearQueuesForTesting } from '../src/main/dayu/dayuQueue'
import { __clearHealthForTesting, reportDayuFailure } from '../src/main/dayu/dayuHealth'
import { startFakeDayu, FakeDayu } from './helpers/fakeDayuServer'

describe('dayuSetVolume（四態 outcome）', () => {
  let srv: FakeDayu
  beforeEach(() => {
    __clearSessionsForTesting()
    __clearQueuesForTesting()
    __clearHealthForTesting()
  })
  afterEach(async () => { if (srv) await srv.close() })

  it('全表單回帶寫入 → readback 一致 → applied-verified', async () => {
    srv = await startFakeDayu({ volume: 7 })
    const r = await dayuSetVolume('127.0.0.1', 3, 'admin', 'admin', srv.port)
    expect(r.state).toBe('applied-verified')
    expect(srv.currentVolume).toBe(3)
    // 表單保真：勾選 checkbox 與 hidden 欄位都被回帶、未勾選的不送
    const post = srv.posts.find((p) => p.path === '/media.htm')!
    expect(post.fields['MEDIA_EnableVad_RW']).toBe('ON')
    expect(post.fields['DSP_CodecSets_RW']).toBe('G722,PCMU,PCMA,G729')
    expect('MEDIA_EnableSidetone_RW' in post.fields).toBe(false)
    expect(post.fields['DefaultSubmit']).toBe('Apply')
    // GBK 真驗證：中文 hidden 欄位需完整往返（若 encoder 誤用 UTF-8 這裡會亂碼而 fail）
    expect(post.fields['MEDIA_DeviceName_RW']).toBe('大廳喇叭')
  }, 30000)

  it('POST 成功但後續 readback 一直半頁 → applied-unverified（寫入仍生效）', async () => {
    srv = await startFakeDayu({ volume: 7, halfPagesAfterPost: 99 })
    const r = await dayuSetVolume('127.0.0.1', 4, 'admin', 'admin', srv.port)
    expect(r.state).toBe('applied-unverified')
    expect(srv.currentVolume).toBe(4)
  }, 30000)

  it('前兩次 POST 回 503 → 重試後成功（applied-verified）', async () => {
    srv = await startFakeDayu({ volume: 7, post503Times: 2 })
    const r = await dayuSetVolume('127.0.0.1', 5, 'admin', 'admin', srv.port)
    expect(r.state).toBe('applied-verified')
    expect(srv.currentVolume).toBe(5)
  }, 30000)

  it('寫入不生效（readback 不符）→ failed / verify-mismatch', async () => {
    srv = await startFakeDayu({ volume: 7, ignoreVolumeWrites: true })
    const r = await dayuSetVolume('127.0.0.1', 2, 'admin', 'admin', srv.port)
    expect(r.state).toBe('failed')
    if (r.state === 'failed') expect(r.reason).toBe('verify-mismatch')
  }, 30000)

  it('帳密錯誤 → failed / auth-failed', async () => {
    srv = await startFakeDayu()
    const r = await dayuSetVolume('127.0.0.1', 5, 'admin', 'wrong', srv.port)
    expect(r.state).toBe('failed')
    if (r.state === 'failed') expect(r.reason).toBe('auth-failed')
  }, 30000)

  it('negative cache 命中 → busy 且零流量', async () => {
    srv = await startFakeDayu()
    reportDayuFailure('127.0.0.1') // 進入退避窗
    const r = await dayuSetVolume('127.0.0.1', 5, 'admin', 'admin', srv.port)
    expect(r.state).toBe('busy')
    expect(srv.nonceHits).toBe(0) // 完全沒碰網路
  })

  it('音量超界 → failed（不碰網路）', async () => {
    srv = await startFakeDayu()
    const r = await dayuSetVolume('127.0.0.1', 12, 'admin', 'admin', srv.port)
    expect(r.state).toBe('failed')
    expect(srv.nonceHits).toBe(0)
  })
})

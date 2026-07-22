import { dayuSetSip } from '../src/main/dayu/dayuWrite'
import { __clearSessionsForTesting } from '../src/main/dayu/dayuClient'
import { __clearQueuesForTesting } from '../src/main/dayu/dayuQueue'
import { __clearHealthForTesting } from '../src/main/dayu/dayuHealth'
import { startFakeDayu, FakeDayu } from './helpers/fakeDayuServer'
import type { DayuSipConfig } from '../src/shared/types'

const CFG: DayuSipConfig = {
  phoneNum: '155', regUser: '155', displayName: '155',
  regPasswd: 'tcfnetsip', regAddr: '192.168.1.1', regPort: '5060',
}

describe('dayuSetSip（恆 applied-unverified）', () => {
  let srv: FakeDayu
  beforeEach(() => {
    __clearSessionsForTesting()
    __clearQueuesForTesting()
    __clearHealthForTesting()
  })
  afterEach(async () => { if (srv) await srv.close() })

  it('POST 200 → applied-unverified（絕不宣稱 verified），必送 EnableSipReg=ON 與 TabIndex=0', async () => {
    srv = await startFakeDayu()
    const r = await dayuSetSip('127.0.0.1', CFG, 'admin', 'admin', srv.port)
    expect(r.state).toBe('applied-unverified')
    const post = srv.posts.find((p) => p.path === '/lines.htm')!
    // 最隱蔽陷阱：checkbox 漏送＝停用 SIP 註冊（真機破案）
    expect(post.fields['SIP_EnableSipReg_RW']).toBe('ON')
    expect(post.fields['SIP_PhoneLineTabIndex_R']).toBe('0')
    expect(post.fields['SIP_PhoneLineEntry']).toBe('1')
    expect(post.fields['SIP_PhoneNum_R']).toBe('155')
    expect(post.fields['SIP_RegPasswd_R']).toBe('tcfnetsip')
    expect(post.fields['SIP_RegAddr_R']).toBe('192.168.1.1')
    expect(post.fields['DefaultSubmit']).toBe('Apply')
    // 未改的表單欄位原值回帶（select）
    expect(post.fields['SIP_Transport_RW']).toBe('0')
  }, 30000)

  it('503 用盡 → busy（未確認是否寫入）', async () => {
    srv = await startFakeDayu({ post503Times: 99 })
    const r = await dayuSetSip('127.0.0.1', CFG, 'admin', 'admin', srv.port)
    expect(r.state).toBe('busy')
  }, 60000)

  it('連不上 → failed / unreachable', async () => {
    const r = await dayuSetSip('127.0.0.1', CFG, 'admin', 'admin', 1)
    expect(r.state).toBe('failed')
    if (r.state === 'failed') expect(r.reason).toBe('unreachable')
  })
})

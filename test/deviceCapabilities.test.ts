import { getDeviceCapabilities } from '@shared/deviceCapabilities'

describe('getDeviceCapabilities', () => {
  it('GT-SIP-GW 具備 DBP 改 IP / GT REST / 批次同步 / 通話控制，音量 0-100', () => {
    const c = getDeviceCapabilities('gt-sip-gw')
    expect(c.canChangeIpViaDbp).toBe(true)
    expect(c.canGtRest).toBe(true)
    expect(c.canBatchSyncRest).toBe(true)
    expect(c.canCallControl).toBe(true)
    expect(c.hasDayuWebForm).toBe(false)
    expect(c.volumeScaleMax).toBe(100)
  })

  it('DAYU-OT300 不具任何 GT 能力，只有 Web 表單，音量 0-9', () => {
    const c = getDeviceCapabilities('dayu-ot300')
    expect(c.canChangeIpViaDbp).toBe(false)
    expect(c.canGtRest).toBe(false)
    expect(c.canBatchSyncRest).toBe(false)
    expect(c.canCallControl).toBe(false)
    expect(c.hasDayuWebForm).toBe(true)
    expect(c.volumeScaleMax).toBe(9)
  })
})

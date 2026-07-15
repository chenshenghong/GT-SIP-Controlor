import { allocate, enumerateIps, ipToLong, poolUsage } from '@shared/provisionAllocator'
import type { ProvisionConfig, ProvisionRecord } from '@shared/types'

const cfg: ProvisionConfig = {
  ipStart: '192.168.1.101', ipEnd: '192.168.1.103',
  mask: '255.255.255.0', gateway: '192.168.1.1',
  extStart: 8001, extEnd: 8003,
  sipPassword: 'pw', sipServer: '192.168.1.10', sipPort: 5060, namePrefix: 'GT-',
}

describe('provisionAllocator', () => {
  it('ipToLong / enumerateIps 展開連續區間', () => {
    expect(ipToLong('192.168.1.101')).toBe(ipToLong('192.168.1.100') + 1)
    expect(enumerateIps('192.168.1.101', '192.168.1.103')).toEqual([
      '192.168.1.101', '192.168.1.102', '192.168.1.103',
    ])
  })

  it('空登記表：取第一個 IP 與分機', () => {
    expect(allocate(cfg, [], new Set())).toEqual({ ip: '192.168.1.101', ext: 8001 })
  })

  it('跳過登記表已佔用的號碼', () => {
    const recs: ProvisionRecord[] = [
      { mac: 'A', assignedIp: '192.168.1.101', assignedExt: 8001, status: 'provisioned', updatedAt: '' },
    ]
    expect(allocate(cfg, recs, new Set())).toEqual({ ip: '192.168.1.102', ext: 8002 })
  })

  it('跳過本輪掃描已存在的 IP（但分機不受掃描影響）', () => {
    expect(allocate(cfg, [], new Set(['192.168.1.101']))).toEqual({ ip: '192.168.1.102', ext: 8001 })
  })

  it('IP 池用盡 → null', () => {
    const recs: ProvisionRecord[] = ['192.168.1.101', '192.168.1.102', '192.168.1.103'].map((ip, i) => ({
      mac: `M${i}`, assignedIp: ip, assignedExt: 8001 + i, status: 'provisioned', updatedAt: '',
    }))
    expect(allocate(cfg, recs, new Set())).toBeNull()
  })

  it('poolUsage 計算已用/總量', () => {
    const recs: ProvisionRecord[] = [
      { mac: 'A', assignedIp: '192.168.1.101', assignedExt: 8001, status: 'provisioned', updatedAt: '' },
    ]
    expect(poolUsage(cfg, recs)).toEqual({ ipUsed: 1, ipTotal: 3, extUsed: 1, extTotal: 3 })
  })
})

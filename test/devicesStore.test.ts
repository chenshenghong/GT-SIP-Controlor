import { setActivePinia, createPinia } from 'pinia'
import { useDeviceStore } from '../src/renderer/stores/devices'
import type { DeviceNode } from '../src/shared/types'

function makeGtNode(overrides: Partial<DeviceNode> = {}): DeviceNode {
  return {
    deviceKind: 'gt-sip-gw',
    id: 1,
    type: 'SIP-Player',
    mac: 'AA:BB:CC:DD:EE:01',
    sn: 'SN001',
    name: 'GT-1',
    hostName: 'gt-1',
    ip: '192.168.0.147',
    mask: '255.255.255.0',
    gateway: '192.168.0.1',
    autoIp: 0,
    dns1: '',
    dns2: '',
    useDns: 0,
    server: '',
    server2: '',
    mode: '',
    isBroadcast: 0,
    version: '1.0.0',
    playVol: 50,
    captureVol: 50,
    treble: 0,
    bass: 0,
    tbAgc: 0,
    tbLinein: 0,
    group: 0,
    speed: 0,
    encrypt: 0,
    reboot: '',
    website: '',
    svcConfig: '',
    localSet: '',
    status: 'ONLINE',
    ...overrides,
  }
}

function makeDayuNode(overrides: Partial<DeviceNode> = {}): DeviceNode {
  return {
    deviceKind: 'dayu-ot300',
    id: 0,
    type: 'DAYU-OT300',
    mac: '',
    sn: '',
    name: 'DAYU-1',
    hostName: '',
    ip: '192.168.0.147',
    mask: '255.255.255.0',
    gateway: '',
    autoIp: 0,
    dns1: '',
    dns2: '',
    useDns: 0,
    server: '',
    server2: '',
    mode: '',
    isBroadcast: 0,
    version: '',
    playVol: 0,
    captureVol: 0,
    treble: 0,
    bass: 0,
    tbAgc: 0,
    tbLinein: 0,
    group: 0,
    speed: 0,
    encrypt: 0,
    reboot: '',
    website: '',
    svcConfig: '',
    localSet: '',
    status: 'DISCONNECTED',
    ...overrides,
  }
}

describe('useDeviceStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('addDevice：同 IP 的 DAYU 節點不會合併/覆蓋既有 GT 節點', () => {
    const store = useDeviceStore()
    const gt = makeGtNode()
    store.addDevice(gt)

    const dayu = makeDayuNode({ ip: gt.ip }) // 同 IP，mac=''
    store.addDevice(dayu)

    expect(store.devices.length).toBe(2)
    const keptGt = store.devices.find((d) => d.deviceKind === 'gt-sip-gw')
    const keptDayu = store.devices.find((d) => d.deviceKind === 'dayu-ot300')
    expect(keptGt).toBeDefined()
    expect(keptDayu).toBeDefined()
    // GT 節點的 mac / deviceKind 未被翻轉或清空
    expect(keptGt?.mac).toBe(gt.mac)
    expect(keptGt?.deviceKind).toBe('gt-sip-gw')
  })

  it('addDevice：同 kind 同 mac 仍正常合併（既有行為不回歸）', () => {
    const store = useDeviceStore()
    const gt = makeGtNode({ name: 'GT-Old', status: 'DISCONNECTED' })
    store.addDevice(gt)

    const updated = makeGtNode({ name: 'GT-New', status: 'ONLINE' })
    store.addDevice(updated)

    expect(store.devices.length).toBe(1)
    expect(store.devices[0].name).toBe('GT-New')
    expect(store.devices[0].status).toBe('ONLINE')
    expect(store.devices[0].mac).toBe(gt.mac)
  })

  it('setDevices：DBP 掃描結果（全 GT）套用後，既有 DAYU 節點仍在列表', () => {
    const store = useDeviceStore()
    const dayu = makeDayuNode({ ip: '192.168.0.200' })
    store.addDevice(dayu)

    const scanned = [makeGtNode({ ip: '192.168.0.147' })]
    store.setDevices(scanned)

    expect(store.devices.some((d) => d.deviceKind === 'dayu-ot300' && d.ip === dayu.ip)).toBe(true)
    expect(store.devices.some((d) => d.deviceKind === 'gt-sip-gw' && d.ip === scanned[0].ip)).toBe(true)
    expect(store.devices.length).toBe(2)
  })
})

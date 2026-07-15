// 驗證 directed-broadcast 計算與 target 清單組裝（純函式，複製自 routeManager.ts）。
// 專案無 jest，此腳本即算法的可執行規格。實作後兩邊算法必須一致。
import assert from 'node:assert/strict'

function directedBroadcast(ip, netmask) {
  const ipParts = ip.split('.').map(Number)
  const maskParts = netmask.split('.').map(Number)
  if (ipParts.length !== 4 || maskParts.length !== 4) return null
  if (ipParts.some(Number.isNaN) || maskParts.some(Number.isNaN)) return null
  return ipParts.map((o, i) => (o | (~maskParts[i] & 0xff))).join('.')
}

function broadcastTargetsFrom(addrs, aliasIps = new Set()) {
  const targets = new Set(['255.255.255.255'])
  for (const a of addrs) {
    if (a.family !== 'IPv4' || a.internal) continue
    if (aliasIps.has(a.address)) continue
    if (!a.netmask) continue
    const b = directedBroadcast(a.address, a.netmask)
    if (b) targets.add(b)
  }
  return Array.from(targets)
}

// --- directedBroadcast ---
assert.equal(directedBroadcast('192.168.0.184', '255.255.255.0'), '192.168.0.255')
assert.equal(directedBroadcast('192.168.1.203', '255.255.255.0'), '192.168.1.255')
assert.equal(directedBroadcast('10.0.5.7', '255.255.0.0'), '10.0.255.255')
assert.equal(directedBroadcast('172.16.4.9', '255.255.255.240'), '172.16.4.15')
assert.equal(directedBroadcast('bad', '255.255.255.0'), null)

// --- broadcastTargetsFrom: .184 兩張實體網卡（不同網段）---
const ifaces184 = [
  { address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true },
  { address: '192.168.0.184', netmask: '255.255.255.0', family: 'IPv4', internal: false },
  { address: '192.168.1.203', netmask: '255.255.255.0', family: 'IPv4', internal: false },
  { address: 'fe80::1', netmask: 'ffff::', family: 'IPv6', internal: false },
]
assert.deepEqual(
  broadcastTargetsFrom(ifaces184).sort(),
  ['192.168.0.255', '192.168.1.255', '255.255.255.255'].sort()
)

// --- 排除自加別名 IP ---
assert.deepEqual(
  broadcastTargetsFrom(ifaces184, new Set(['192.168.1.203'])).sort(),
  ['192.168.0.255', '255.255.255.255'].sort()
)

// --- 保底：無外部網卡至少回 limited broadcast ---
assert.deepEqual(
  broadcastTargetsFrom([{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true }]),
  ['255.255.255.255']
)

// --- 去重：兩張同網段網卡只算一個 directed broadcast ---
const dup = [
  { address: '192.168.1.10', netmask: '255.255.255.0', family: 'IPv4', internal: false },
  { address: '192.168.1.20', netmask: '255.255.255.0', family: 'IPv4', internal: false },
]
assert.deepEqual(broadcastTargetsFrom(dup).sort(), ['192.168.1.255', '255.255.255.255'].sort())

console.log('✅ all broadcast-target assertions passed')

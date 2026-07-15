# 多網卡自動廣播 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 DBP 設備發現與改 IP 在多網卡主機上自動涵蓋所有網卡的網段（送 per-NIC directed broadcast），使用者零設定。

**Architecture:** 新增純函式 helper 算出「limited broadcast + 每張非內部網卡的 subnet-directed broadcast」清單；`dbpDiscover.ts` 與 `ipChanger.ts` 的 `blast()` 改為對清單每個位址各送一次。路由表自動把每個 directed broadcast 導到正確網卡。收包 socket 維持綁 `0.0.0.0` 不動。

**Tech Stack:** TypeScript、Electron main process、Node `dgram`/`os`、electron-vite。

## Global Constraints

- 專案**無測試框架**（package.json 無 `test` script）。純計算驗證用**獨立 node 腳本 assert**（`scripts/` 下，`.mjs`），整合正確性用 `npm run typecheck`，端到端行為用真機 `.184` tcpdump。
- 目標平台 Node 20（測試機）；`os.networkInterfaces()` 的 `family` 以字串 `'IPv4'` 判斷（沿用 `routeManager.ts` 既有慣例）。
- 不新增 UI、不新增設定 store、不改 `detectLocalNetwork()`、不清 `scanner.ts`/`taskServerClient` 死碼（另開一輪）。
- 改碼/rename/PR 前先 `bash scripts/gitnexus-fresh.sh`（CLAUDE.md 規範）。
- commit 訊息結尾加 `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。

---

### Task 1: routeManager.ts 新增 getBroadcastTargets() + 純 helper

**Files:**
- Modify: `src/main/routeManager.ts`（在檔尾 389 行後、`cleanupAllAliases` 之後新增）
- Test: `scripts/verify-broadcast-targets.mjs`（新增，node assert）

**Interfaces:**
- Produces:
  - `directedBroadcast(ip: string, netmask: string): string | null`
  - `broadcastTargetsFrom(addrs: Array<{ address: string; netmask: string; family: string; internal: boolean }>, aliasIps?: Set<string>): string[]`
  - `getBroadcastTargets(): string[]`

- [ ] **Step 1: 寫驗證腳本（先驗算法，故意用尚未存在的預期值）**

Create `scripts/verify-broadcast-targets.mjs`:

```js
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
```

- [ ] **Step 2: 跑腳本確認算法正確**

Run: `node scripts/verify-broadcast-targets.mjs`
Expected: `✅ all broadcast-target assertions passed`（exit 0）

- [ ] **Step 3: 在 routeManager.ts 檔尾新增相同算法的實作**

Append to `src/main/routeManager.ts`（`cleanupAllAliases` 之後）:

```ts

// ============================================
// Multi-NIC broadcast targets
//
// A limited broadcast (255.255.255.255) is sent out only ONE interface on a
// multi-homed host (the default-route NIC), so devices on other NICs' segments
// are missed. Sending each NIC's subnet-directed broadcast (e.g. 192.168.1.255)
// instead lets the routing table deliver to the correct NIC per subnet — thus
// covering every NIC with no interface binding and no user configuration.
// ============================================

/** Subnet-directed broadcast for an IPv4 addr + netmask (or null if malformed). */
function directedBroadcast(ip: string, netmask: string): string | null {
  const ipParts = ip.split('.').map(Number)
  const maskParts = netmask.split('.').map(Number)
  if (ipParts.length !== 4 || maskParts.length !== 4) return null
  if (ipParts.some(Number.isNaN) || maskParts.some(Number.isNaN)) return null
  return ipParts.map((o, i) => o | (~maskParts[i] & 0xff)).join('.')
}

/**
 * Pure: build the DBP broadcast target list from an interface list. Always
 * includes 255.255.255.255; adds each non-internal IPv4 interface's directed
 * broadcast. Excludes our own alias IPs. Deduped.
 *
 * Known limitation: two NICs on the IDENTICAL subnet share one directed
 * broadcast, and Node dgram can't pin a broadcast to an egress interface, so
 * only the routed NIC is reached. Vanishingly rare in production.
 */
export function broadcastTargetsFrom(
  addrs: Array<{ address: string; netmask: string; family: string; internal: boolean }>,
  aliasIps: Set<string> = new Set()
): string[] {
  const targets = new Set<string>(['255.255.255.255'])
  for (const a of addrs) {
    if (a.family !== 'IPv4' || a.internal) continue
    if (aliasIps.has(a.address)) continue
    if (!a.netmask) continue
    const b = directedBroadcast(a.address, a.netmask)
    if (b) targets.add(b)
  }
  return Array.from(targets)
}

/** DBP broadcast targets for THIS host (limited + per-NIC directed broadcast). */
export function getBroadcastTargets(): string[] {
  const aliasIps = new Set(Array.from(addedAliases.values()).map((a) => a.aliasIp))
  const addrs: Array<{ address: string; netmask: string; family: string; internal: boolean }> = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      addrs.push({ address: a.address, netmask: a.netmask, family: a.family as string, internal: a.internal })
    }
  }
  return broadcastTargetsFrom(addrs, aliasIps)
}
```

- [ ] **Step 4: typecheck 通過**

Run: `npm run typecheck`
Expected: 無錯誤輸出（exit 0）

- [ ] **Step 5: Commit**

```bash
git add src/main/routeManager.ts scripts/verify-broadcast-targets.mjs
git commit -m "feat(routeManager): 新增 getBroadcastTargets 多網卡 directed broadcast

$(printf 'Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 2: dbpDiscover.ts 對所有 target 廣播

**Files:**
- Modify: `src/main/dbpDiscover.ts:13`（新增 import）、`:128-138`（bind/blast 區塊）

**Interfaces:**
- Consumes: `getBroadcastTargets()` from Task 1.

- [ ] **Step 1: 加入 import**

At `src/main/dbpDiscover.ts` top（第 13 行 `import * as dgram` 之後）新增：

```ts
import { getBroadcastTargets } from './routeManager'
```

- [ ] **Step 2: 改寫 blast() 迴圈送出**

Replace 現有 `sock.bind(() => { ... })` 內的 blast 定義（第 132-133 行）：

```ts
      const blast = () => {
        if (!settled) sock.send(REQUEST, DBP_PORT, '255.255.255.255', () => { /* ignore */ })
      }
```

改為：

```ts
      const targets = getBroadcastTargets()
      const blast = () => {
        if (settled) return
        for (const t of targets) sock.send(REQUEST, DBP_PORT, t, () => { /* ignore */ })
      }
```

（其後 `blast()` / `setTimeout(blast, 300)` / `setTimeout(blast, 900)` / `setTimeout(finish, timeoutMs)` 不變。）

- [ ] **Step 3: typecheck 通過**

Run: `npm run typecheck`
Expected: 無錯誤輸出（exit 0）

- [ ] **Step 4: Commit**

```bash
git add src/main/dbpDiscover.ts
git commit -m "fix(dbpDiscover): 對所有網卡 directed broadcast 送出探測

$(printf 'Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 3: ipChanger.ts 對所有 target 廣播

**Files:**
- Modify: `src/main/ipChanger.ts:29`（import 併入既有那行）、`:126-134`（bind/blast 區塊）

**Interfaces:**
- Consumes: `getBroadcastTargets()` from Task 1.

- [ ] **Step 1: 加入 import**

`src/main/ipChanger.ts` 現有 import（第 29 行）：

```ts
import type { DeviceNode, IpChangeRequest } from '@shared/types'
```

其下新增一行：

```ts
import { getBroadcastTargets } from './routeManager'
```

- [ ] **Step 2: 改寫 SET 的 blast() 迴圈送出**

Replace 現有 blast 定義（第 129-130 行）：

```ts
      const blast = () => {
        if (!settled) sock.send(packet, DBP_PORT, '255.255.255.255', () => { /* ignore */ })
      }
```

改為：

```ts
      const targets = getBroadcastTargets()
      const blast = () => {
        if (settled) return
        for (const t of targets) sock.send(packet, DBP_PORT, t, () => { /* ignore */ })
      }
```

（其後 `blast()` / `setTimeout(blast, 300)` / timeout 不變。）

- [ ] **Step 3: typecheck 通過**

Run: `npm run typecheck`
Expected: 無錯誤輸出（exit 0）

- [ ] **Step 4: Commit**

```bash
git add src/main/ipChanger.ts
git commit -m "fix(ipChanger): 對所有網卡 directed broadcast 送出 SET

$(printf 'Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 4: 真機 .184 端到端驗證 + 文件註記

**Files:**
- Modify: `docs/DBP協定-發現與修改IP.md`（一、傳輸層 段落補「多網卡送出策略 + 已知限制」）

**Interfaces:** 無（驗證與文件）。

- [ ] **Step 1: build + 佈署到 .184**

```bash
npm run build:linux
rsync -a --progress dist/linux-unpacked/resources/ tcfnet@192.168.0.184:~/Desktop/SIP-COMMANDER/linux-unpacked/resources/
```
Expected: build 成功、rsync app.asar 傳輸完成。

- [ ] **Step 2: .184 起 tcpdump（抓 enp4s0，即設備 192.168.1.101 所在網段，非主機預設路由網段）+ 啟動 app（debug port）**

```bash
ssh tcfnet@192.168.0.184 'sudo -n rm -f /tmp/dbp-multinic.pcap; sudo -n nohup tcpdump -i enp4s0 -w /tmp/dbp-multinic.pcap "udp port 58001" >/tmp/td.log 2>&1 & sleep 1; sudo -n pgrep -x tcpdump && echo capturing'
ssh tcfnet@192.168.0.184 'pkill -9 -x sip-cms; sleep 1; env DISPLAY=:0 WAYLAND_DISPLAY=wayland-0 XAUTHORITY=/run/user/1000/.mutter-Xwaylandauth.TICOS3 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus /home/tcfnet/Desktop/SIP-COMMANDER/linux-unpacked/sip-cms --no-sandbox --remote-debugging-port=9222 --remote-allow-origins=* >/tmp/sip-cms.log 2>&1 & sleep 4; pgrep -x sip-cms && echo running'
```
Expected: `capturing`、`running`。

- [ ] **Step 3: 經 CDP 觸發 discovery，確認設備被找到**

透過 SSH tunnel + `scratchpad/cdp-eval.mjs` 呼叫 `window.electronAPI.dbpDiscover()`，斷言回傳含 `20:23:5A:A1:FD:F9 @ 192.168.1.101`。
Expected: discovery 結果包含該設備。

- [ ] **Step 4: 停 tcpdump、拉回 pcap、確認有送到 192.168.1.255 且走 enp4s0**

```bash
ssh tcfnet@192.168.0.184 'sudo -n pkill -x tcpdump; sudo -n chmod 644 /tmp/dbp-multinic.pcap'
scp tcfnet@192.168.0.184:/tmp/dbp-multinic.pcap "$SCRATCH/dbp-multinic.pcap"
tcpdump -r "$SCRATCH/dbp-multinic.pcap" -nn 'dst host 192.168.1.255 and udp port 58001'
```
Expected: 有本機送往 `192.168.1.255:58001` 的封包（即舊版只送 255.255.255.255 走 enp5s0 時**不會出現**在 enp4s0 的封包）；且設備 `192.168.1.101` 有廣播回覆。

- [ ] **Step 5: 迴歸 — 0.x 網段設備仍正常**

CDP discovery 結果同時仍含 `192.168.0.148`（HK-WSDK）。
Expected: 兩網段設備都在。

- [ ] **Step 6: 更新協定文件的傳輸層段落**

在 `docs/DBP協定-發現與修改IP.md` 的「## 一、傳輸層」表格後補一段：

```markdown
> **多網卡送出策略（v2.1）**：CMS 不只送 limited broadcast `255.255.255.255`
> （多網卡主機上 OS 只從預設路由網卡送出），而是列舉每張非內部網卡、對各自的
> subnet-directed broadcast（如 `192.168.0.255`、`192.168.1.255`）逐一送出，
> 由路由表導到正確網卡，涵蓋所有網卡網段（`routeManager.getBroadcastTargets()`）。
>
> ⚠️ **已知限制**：兩張網卡在**完全相同**網段時，Node `dgram` 無法對廣播指定
> 出口介面，只會走路由挑中的那一張。生產環境極罕見。
```

- [ ] **Step 7: 收尾 — 乾淨重啟 app、關 tunnel、清遠端暫存、commit 文件**

```bash
ssh tcfnet@192.168.0.184 'pkill -9 -x sip-cms; sleep 1; env DISPLAY=:0 WAYLAND_DISPLAY=wayland-0 XAUTHORITY=/run/user/1000/.mutter-Xwaylandauth.TICOS3 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus /home/tcfnet/Desktop/SIP-COMMANDER/linux-unpacked/sip-cms --no-sandbox >/tmp/sip-cms.log 2>&1 & sleep 3; pgrep -x sip-cms && echo clean-running'
ssh tcfnet@192.168.0.184 'sudo -n rm -f /tmp/dbp-multinic.pcap /tmp/td.log'
git add "docs/DBP協定-發現與修改IP.md"
git commit -m "docs(DBP): 記錄多網卡 directed broadcast 送出策略與已知限制

$(printf 'Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Self-Review

**Spec coverage:**
- getBroadcastTargets helper（directed broadcast + 255.255.255.255 + 去重 + 排除別名 + 保底）→ Task 1 ✅
- dbpDiscover blast 迴圈 → Task 2 ✅
- ipChanger blast 迴圈 → Task 3 ✅
- 收包 socket 綁 0.0.0.0 不動 → 未列為改動（正確，維持原樣）✅
- 真機 .184 tcpdump 驗證 → Task 4 ✅
- 已知限制寫入文件 → Task 4 Step 6 ✅
- 無 UI/設定/detectLocalNetwork/死碼 → 皆未觸及 ✅

**Placeholder scan:** 無 TBD/TODO；每個 code step 均含完整程式碼。✅

**Type consistency:** `getBroadcastTargets(): string[]`、`broadcastTargetsFrom(addrs, aliasIps?)`、`directedBroadcast(ip, netmask)` 在 Task 1 定義，Task 2/3 只 import 呼叫 `getBroadcastTargets()`，簽章一致。✅

**已知限制**：Task 4 的 `$SCRATCH` 需執行時設為本機 scratchpad 路徑（本 session 既有）。

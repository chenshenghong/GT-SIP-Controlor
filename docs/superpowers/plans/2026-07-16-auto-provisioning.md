# 自動供裝（Auto-Provisioning）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓使用者填一組供裝範本（IP 範圍、分機範圍、SIP 密碼、SIP Server、名稱前綴），啟動後每 ≥5 秒掃描一次，對新設備依發現順序自動分配 IP＋分機，DBP 改 IP（順帶設名稱）→ 等上線 → REST 下發 SIP，全程持久化避免重複供裝。

**Architecture:** 供裝引擎核心是一支**純 TypeScript**模組（`provisionEngine.ts`，零 Vue/Pinia/Electron import），透過注入的 deps 做網路呼叫，因此可被 jest 完整單元測試。Vue 層（composable + store + view）只做反應式接線與 UI。登記表持久化在 main process 以原子寫入落地 JSON。

**Tech Stack:** Electron 41 + Vue 3 Composition API + Pinia + TypeScript + Tailwind；測試 jest + ts-jest（本計畫 Task 0 首次為本 repo 建置）。

## Global Constraints

- 全部 UI 顯示文字一律**繁體中文**，禁止夾雜日文/簡體。
- 併發網路操作上限沿用既有 `MAX_CONCURRENT_SYNC = 5`（`src/shared/constants.ts:66`）。
- 設備預設帳密 `admin` / `123456`（`DEVICE_DEFAULT_USERNAME` / `DEVICE_DEFAULT_PASSWORD`）；SIP 寫入 401 由 `deviceApi` 既有攔截器自動重登，**不需手動 login**。
- IPC 新增一律走四步慣例：`IPC_CHANNELS` 常數 → `ipcMain.handle` → `preload/index.ts` 包裝 → renderer 呼叫。
- DBP SET 會觸發設備**整機重開**；`setSipPrimary` 只重啟 SIP 行程、**不整機重開**。
- 韌體永遠回 HTTP 200，寫入成敗看 body `status` 欄位；`setSipPrimary`/`postRetry` 已處理判讀。
- 成功定義：`setSipPrimary` 回 `true`（body status=success）即完成，**不驗 SIP 註冊**。
- MAC 為設備主鍵（去重、登記表主鍵、判定依據）。

## Deviations from spec（第一性原理裁決，已回補 spec）

1. **不用 `usePromiseQueue`，改用小型 `createLimiter`**：`usePromiseQueue` 是批次型（`runQueue(tasks[])` 跑完即返回），不適合長駐、跨掃描輪的串流狀態機。改用一支 submit-one-at-a-time 的併發閘（Task 5），上限同為 5。
2. **供裝「停止」時不清 IP 別名**：`ensureReachableForIps` 加的次要 IP 別名與探測功能共用模組級 `addedAliases`，`cleanupAllAliases` 會清全部。探測本來就把別名留到 app 退出（`will-quit`）才清。供裝比照——停止時不碰別名，避免誤清探測加的別名（比原 spec「只清自己加的」更簡單且無 bug）。

---

## Task 0: 建置 jest 測試基礎設施

本 repo 目前**零測試框架**（`package.json` 的 `jest: {}` 是空的、devDeps 無 jest、無測試檔）。本任務首次建置，讓後續純 TS 模組可被單元測試。

**Files:**
- Modify: `package.json`（devDependencies + scripts + 移除空的 `jest: {}`）
- Create: `jest.config.cjs`
- Create: `test/smoke.test.ts`

**Interfaces:**
- Produces: `npm test` 可執行；ts-jest 能解析 `@shared/*` 與 `@/*` 路徑別名。

- [ ] **Step 1: 安裝 jest 相依**

Run:
```bash
npm i -D jest@^29 ts-jest@^29 @types/jest@^29
```
Expected: 三個套件加入 devDependencies，無 peer error。

- [ ] **Step 2: 建 `jest.config.cjs`**

`@shared` → `src/shared`、`@` → `src/renderer`（對齊 electron-vite 別名）。只測純 TS（`test/` 下），不碰 `.vue`。

```js
/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  moduleNameMapper: {
    '^@shared/(.*)$': '<rootDir>/src/shared/$1',
    '^@/(.*)$': '<rootDir>/src/renderer/$1',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: { esModuleInterop: true, module: 'commonjs' } }],
  },
}
```

- [ ] **Step 3: 加 test script、移除空 jest key**

`package.json` scripts 加 `"test": "jest --runInBand"`；刪除頂層 `"jest": {}`。

- [ ] **Step 4: 冒煙測試**

`test/smoke.test.ts`:
```ts
describe('jest 基礎設施', () => {
  it('會跑並通過', () => {
    expect(1 + 1).toBe(2)
  })
})
```

- [ ] **Step 5: 跑測試確認綠燈**

Run: `npm test`
Expected: PASS，1 passed。

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json jest.config.cjs test/smoke.test.ts
git commit -m "test: 建置 jest + ts-jest 測試基礎設施（本 repo 首次）"
```

---

## Task 1: 供裝共用型別 + IpChangeRequest.newName

**Files:**
- Modify: `src/shared/types.ts`（append 型別；`IpChangeRequest` 加 `newName?`）

**Interfaces:**
- Produces: `ProvisionConfig`、`ProvisionRecord`、`ProvisionRegistryFile`、`ProvisionTaskStatus`、`ProvisionTask`、`ProvisionEvent`。`IpChangeRequest.newName?: string`。

- [ ] **Step 1: `IpChangeRequest` 加 optional `newName`**

在 `src/shared/types.ts` 的 `IpChangeRequest` 介面內，`autoIp: 0 | 1` 後加一行：
```ts
  /** 供裝時順帶把設備名稱設為分機號（帶入 DBP SET 的 Name: 欄位）；省略則沿用 device.name */
  newName?: string
```

- [ ] **Step 2: append 供裝型別**

在 `src/shared/types.ts` 檔尾加：
```ts
// ============================================
// Auto-Provisioning
// ============================================

/** 使用者填的供裝範本（持久化於 registry 檔） */
export interface ProvisionConfig {
  ipStart: string
  ipEnd: string
  mask: string
  gateway: string
  extStart: number
  extEnd: number
  sipPassword: string
  sipServer: string
  sipPort: number
  namePrefix: string
}

/** 登記表一筆記錄（MAC 為主鍵） */
export interface ProvisionRecord {
  mac: string
  assignedIp: string
  assignedExt: number
  status: 'pending' | 'provisioned' | 'failed'
  updatedAt: string // ISO 8601
  lastError?: string
}

/** registry 檔內容 */
export interface ProvisionRegistryFile {
  config: ProvisionConfig | null
  records: ProvisionRecord[]
}

/** 執行期任務狀態（只在記憶體，不落地） */
export type ProvisionTaskStatus =
  | 'discovered'
  | 'ip_assigning'
  | 'waiting_online'
  | 'sip_configuring'
  | 'done'
  | 'skipped'
  | 'failed'

export interface ProvisionTask {
  mac: string
  ip: string // 目前觀測到的 IP
  assignedIp: string
  assignedExt: number
  status: ProvisionTaskStatus
  deadline?: number // waiting_online 逾時的絕對時間戳 (ms)
  error?: string
}

/** 引擎對外事件（driver 綁到 store） */
export type ProvisionEvent =
  | { kind: 'task'; task: ProvisionTask }
  | { kind: 'log'; ts: number; message: string }
  | { kind: 'paused'; reason: string }
  | { kind: 'pool'; ipUsed: number; ipTotal: number; extUsed: number; extTotal: number }
  | { kind: 'round'; round: number }
```

- [ ] **Step 3: typecheck**

Run: `npm run typecheck`
Expected: PASS（無新錯誤）。

- [ ] **Step 4: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(types): 自動供裝型別 + IpChangeRequest.newName（optional）"
```

---

## Task 2: ipChanger 帶入 newName

**Files:**
- Modify: `src/main/ipChanger.ts:77`（`buildSetPacket` 的 `Name:` 行）

**Interfaces:**
- Consumes: `IpChangeRequest.newName?`（Task 1）。
- Produces: DBP SET 封包 `Name:` 用 `req.newName ?? d.name`。

- [ ] **Step 1: 改 `buildSetPacket` 的 Name 行**

`src/main/ipChanger.ts` 的 `buildSetPacket(req, cseq)`，把
```ts
    `Name: ${d.name}`,
```
改為
```ts
    `Name: ${req.newName ?? d.name}`,
```

- [ ] **Step 2: typecheck**

Run: `npm run typecheck`
Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add src/main/ipChanger.ts
git commit -m "feat(ipChanger): DBP SET 支援供裝時順帶改設備名稱"
```

---

## Task 3: 號碼池取號器（純 TS）

**Files:**
- Create: `src/shared/provisionAllocator.ts`
- Test: `test/provisionAllocator.test.ts`

**Interfaces:**
- Consumes: `ProvisionConfig`、`ProvisionRecord`（Task 1）。
- Produces:
  - `ipToLong(ip: string): number`、`longToIp(n: number): string`
  - `enumerateIps(start: string, end: string): string[]`
  - `allocate(config: ProvisionConfig, records: ProvisionRecord[], scanIps: Set<string>): { ip: string; ext: number } | null`
  - `poolUsage(config, records): { ipUsed; ipTotal; extUsed; extTotal }`

- [ ] **Step 1: 寫失敗測試**

`test/provisionAllocator.test.ts`:
```ts
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
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm test -- provisionAllocator`
Expected: FAIL（模組不存在）。

- [ ] **Step 3: 實作**

`src/shared/provisionAllocator.ts`:
```ts
import type { ProvisionConfig, ProvisionRecord } from './types'

export function ipToLong(ip: string): number {
  const p = ip.split('.').map(Number)
  if (p.length !== 4 || p.some((o) => Number.isNaN(o) || o < 0 || o > 255)) {
    throw new Error(`無效 IP: ${ip}`)
  }
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]
}

export function longToIp(n: number): string {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.')
}

export function enumerateIps(start: string, end: string): string[] {
  const s = ipToLong(start)
  const e = ipToLong(end)
  const out: string[] = []
  for (let n = s; n <= e; n++) out.push(longToIp(n))
  return out
}

function enumerateExts(start: number, end: number): number[] {
  const out: number[] = []
  for (let n = start; n <= end; n++) out.push(n)
  return out
}

/**
 * 依序取第一個可用 IP 與第一個可用分機。佔用判斷以登記表為主（永久記錄）；
 * 本輪掃描 IP 清單僅作即時衝突預防的輔助（避免撞上尚未登記卻已在線的設備）。
 * IP 池與分機池序號各自獨立，兩者無對應關係。任一池用盡回傳 null。
 */
export function allocate(
  config: ProvisionConfig,
  records: ProvisionRecord[],
  scanIps: Set<string>
): { ip: string; ext: number } | null {
  const usedIps = new Set(records.map((r) => r.assignedIp))
  const usedExts = new Set(records.map((r) => r.assignedExt))
  const ip = enumerateIps(config.ipStart, config.ipEnd).find(
    (candidate) => !usedIps.has(candidate) && !scanIps.has(candidate)
  )
  const ext = enumerateExts(config.extStart, config.extEnd).find((candidate) => !usedExts.has(candidate))
  if (ip === undefined || ext === undefined) return null
  return { ip, ext }
}

export function poolUsage(config: ProvisionConfig, records: ProvisionRecord[]) {
  const ipTotal = enumerateIps(config.ipStart, config.ipEnd).length
  const extTotal = config.extEnd - config.extStart + 1
  const usedIps = new Set(records.map((r) => r.assignedIp))
  const usedExts = new Set(records.map((r) => r.assignedExt))
  return { ipUsed: usedIps.size, ipTotal, extUsed: usedExts.size, extTotal }
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npm test -- provisionAllocator`
Expected: PASS（6 tests）。

- [ ] **Step 5: Commit**

```bash
git add src/shared/provisionAllocator.ts test/provisionAllocator.test.ts
git commit -m "feat(provision): 號碼池取號器 + 單元測試"
```

---

## Task 4: 登記表持久化（main + IPC）

**Files:**
- Create: `src/main/provisionRegistry.ts`
- Test: `test/provisionRegistry.test.ts`
- Modify: `src/shared/constants.ts`（IPC 常數）
- Modify: `src/main/index.ts`（handlers）
- Modify: `src/preload/index.ts`（包裝 + ElectronAPI 型別）

**Interfaces:**
- Consumes: `ProvisionRegistryFile`（Task 1）。
- Produces:
  - `loadRegistry(filePath: string): Promise<ProvisionRegistryFile>`（壞檔→備份+空表）
  - `saveRegistry(filePath: string, data: ProvisionRegistryFile): Promise<void>`（原子寫入；失敗 throw）
  - `registryPath(): string`（= `app.getPath('userData')/provision-registry.json`）
  - IPC：`REGISTRY_READ`、`REGISTRY_WRITE`
  - `window.electronAPI.readRegistry()` / `.writeRegistry(data)`

- [ ] **Step 1: 寫失敗測試（路徑注入，用 tmp 目錄跑真實 fs）**

`test/provisionRegistry.test.ts`:
```ts
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { loadRegistry, saveRegistry } from '../src/main/provisionRegistry'
import type { ProvisionRegistryFile } from '@shared/types'

async function tmpFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prov-reg-'))
  return path.join(dir, 'provision-registry.json')
}

const sample: ProvisionRegistryFile = {
  config: null,
  records: [{ mac: 'AA', assignedIp: '10.0.0.1', assignedExt: 8001, status: 'provisioned', updatedAt: '2026-01-01T00:00:00Z' }],
}

describe('provisionRegistry', () => {
  it('save 後 load 得回原資料', async () => {
    const f = await tmpFile()
    await saveRegistry(f, sample)
    expect(await loadRegistry(f)).toEqual(sample)
  })

  it('檔案不存在 → 空表', async () => {
    const f = await tmpFile()
    expect(await loadRegistry(f)).toEqual({ config: null, records: [] })
  })

  it('壞檔 → 空表且原檔被改名備份', async () => {
    const f = await tmpFile()
    await fs.writeFile(f, '{ this is not json', 'utf-8')
    expect(await loadRegistry(f)).toEqual({ config: null, records: [] })
    const dir = path.dirname(f)
    const files = await fs.readdir(dir)
    expect(files.some((n) => n.includes('.corrupt-'))).toBe(true)
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm test -- provisionRegistry`
Expected: FAIL（模組不存在）。

- [ ] **Step 3: 實作 `src/main/provisionRegistry.ts`**

```ts
import { promises as fs } from 'fs'
import * as path from 'path'
import type { ProvisionRegistryFile } from '@shared/types'

const EMPTY: ProvisionRegistryFile = { config: null, records: [] }

/** ISO 時間戳的 compact 形式（無 Date.now 以外相依），供備份檔命名。 */
function stamp(now: number): string {
  return new Date(now).toISOString().replace(/[-:]/g, '').replace(/\..+/, '')
}

/**
 * 讀登記表。檔案不存在或內容壞掉都回空表；壞檔會先改名備份（.corrupt-<ts>）
 * 以免下次 save 覆蓋掉可能可搶救的資料。
 */
export async function loadRegistry(filePath: string): Promise<ProvisionRegistryFile> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf-8')
  } catch {
    return { ...EMPTY }
  }
  try {
    const parsed = JSON.parse(raw) as ProvisionRegistryFile
    if (!parsed || !Array.isArray(parsed.records)) throw new Error('shape')
    return parsed
  } catch {
    try {
      await fs.rename(filePath, `${filePath}.corrupt-${stamp(Date.now())}`)
    } catch {
      /* 備份失敗不阻斷 */
    }
    return { ...EMPTY }
  }
}

/**
 * 原子寫入：先寫同目錄的 temp 檔再 rename（同 volume 才保證原子）。
 * 失敗會 throw，讓呼叫端進入降級模式。
 */
export async function saveRegistry(filePath: string, data: ProvisionRegistryFile): Promise<void> {
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp-${process.pid}`)
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8')
  await fs.rename(tmp, filePath)
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npm test -- provisionRegistry`
Expected: PASS（3 tests）。

- [ ] **Step 5: 加 IPC 常數**

`src/shared/constants.ts` 的 `IPC_CHANNELS` 內（`RESTART_DEVICE` 上方 System 區塊前）加：
```ts
  // Provisioning registry (persisted JSON in userData)
  REGISTRY_READ: 'provision:registry-read',
  REGISTRY_WRITE: 'provision:registry-write',
  PROVISION_ENSURE_REACHABLE: 'provision:ensure-reachable',
```

- [ ] **Step 6: 加 main handlers**

`src/main/index.ts` 頂部 import 加：
```ts
import { app } from 'electron' // 已 import，確認在列
import { join } from 'path'    // 已 import
```
在 `registerIpcHandlers` 內加三個 handler：
```ts
  ipcMain.handle(IPC_CHANNELS.REGISTRY_READ, async () => {
    const { loadRegistry } = await import('./provisionRegistry')
    const file = join(app.getPath('userData'), 'provision-registry.json')
    try {
      return { success: true, data: await loadRegistry(file) }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.REGISTRY_WRITE, async (_event, data) => {
    const { saveRegistry } = await import('./provisionRegistry')
    const file = join(app.getPath('userData'), 'provision-registry.json')
    try {
      await saveRegistry(file, data)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.PROVISION_ENSURE_REACHABLE, async (_event, ip: string) => {
    try {
      const { ensureReachableForIps } = await import('./routeManager')
      await ensureReachableForIps([ip])
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })
```

- [ ] **Step 7: preload 包裝 + 型別**

`src/preload/index.ts` 的 `import type` 加 `ProvisionRegistryFile`；`ElectronAPI` type 加：
```ts
  readRegistry: () => Promise<{ success: boolean; data?: ProvisionRegistryFile; error?: string }>
  writeRegistry: (data: ProvisionRegistryFile) => Promise<{ success: boolean; error?: string }>
  ensureReachable: (ip: string) => Promise<{ success: boolean; error?: string }>
```
`electronAPI` 物件加：
```ts
  readRegistry: () => ipcRenderer.invoke(IPC_CHANNELS.REGISTRY_READ),
  writeRegistry: (data: ProvisionRegistryFile) => ipcRenderer.invoke(IPC_CHANNELS.REGISTRY_WRITE, data),
  ensureReachable: (ip: string) => ipcRenderer.invoke(IPC_CHANNELS.PROVISION_ENSURE_REACHABLE, ip),
```

- [ ] **Step 8: typecheck**

Run: `npm run typecheck`
Expected: PASS。

- [ ] **Step 9: Commit**

```bash
git add src/main/provisionRegistry.ts test/provisionRegistry.test.ts src/shared/constants.ts src/main/index.ts src/preload/index.ts
git commit -m "feat(provision): 登記表持久化（原子寫入+壞檔容錯）+ IPC + 可達性 IPC"
```

---

## Task 5: 供裝引擎核心（純 TS 狀態機）

引擎不 import Vue/Pinia/Electron，全靠注入 deps；`runRound()` 可被單元測試逐輪驅動。

**Files:**
- Create: `src/shared/provisionEngine.ts`
- Test: `test/provisionEngine.test.ts`

**Interfaces:**
- Consumes: Task 1 型別、Task 3 `allocate`/`poolUsage`。
- Produces:
  - `createLimiter(max: number): { submit<T>(fn: () => Promise<T>): Promise<T> }`
  - `interface ProvisionDeps { discover; changeIp; ensureReachable; getSipConfig; setSipPrimary; loadRegistry; saveRegistry; now; emit }`（精確簽名見實作）
  - `createProvisionEngine(config: ProvisionConfig, deps: ProvisionDeps): { runRound(): Promise<void>; start(): Promise<void>; stop(): void; getTasks(): ProvisionTask[]; isPaused(): boolean }`
  - 常數 `ONLINE_TIMEOUT_MS = 120_000`、`ROUND_MIN_MS = 5_000`

- [ ] **Step 1: 寫失敗測試（逐輪驅動 + 假時鐘）**

`test/provisionEngine.test.ts`:
```ts
import { createProvisionEngine, createLimiter, type ProvisionDeps } from '@shared/provisionEngine'
import type { DeviceNode, ProvisionConfig, ProvisionRegistryFile, SipConfigResponse } from '@shared/types'

const cfg: ProvisionConfig = {
  ipStart: '192.168.1.101', ipEnd: '192.168.1.110',
  mask: '255.255.255.0', gateway: '192.168.1.1',
  extStart: 8001, extEnd: 8010,
  sipPassword: 'pw', sipServer: '192.168.1.10', sipPort: 5060, namePrefix: 'GT-',
}

function dev(mac: string, ip: string, regUser = ''): DeviceNode {
  return { id: 1, type: 'SIP', mac, sn: '', name: '', hostName: '', ip, mask: '', gateway: '',
    autoIp: 0, dns1: '', dns2: '', useDns: 0, server: '', server2: '', mode: '', isBroadcast: 1,
    version: '', playVol: 50, captureVol: 50, treble: 0, bass: 0, tbAgc: 4, tbLinein: 0, group: 9999,
    speed: 0, encrypt: 0, reboot: '', website: '', svcConfig: '', localSet: '', regUser,
    status: 'ONLINE' } as DeviceNode
}

const sipResp: SipConfigResponse = {
  primary_line: { server_address: '', server_port: 5060, user_id: '', password: '',
    auto_answer: false, register_timeout: 3600, transport_protocol: 'UDP' },
  multicast_config: { multicast_address: '', multicast_port: 0, enabled: false, audio_codec: '' },
  sip_parameters: { local_port: 5060, rtp_start_port: 0, rtp_end_port: 0, rtp_timeout: 0, echo_cancellation: false },
  audio_codecs: { g722: true, opus: false, g711_ulaw: true, g711_alaw: true },
}

function makeDeps(over: Partial<ProvisionDeps> & { clock?: { t: number } }): ProvisionDeps {
  const store: ProvisionRegistryFile = { config: null, records: [] }
  const clock = over.clock ?? { t: 1_000_000 }
  return {
    discover: over.discover ?? (async () => []),
    changeIp: over.changeIp ?? (async () => ({ success: true })),
    ensureReachable: over.ensureReachable ?? (async () => {}),
    getSipConfig: over.getSipConfig ?? (async () => sipResp),
    setSipPrimary: over.setSipPrimary ?? (async () => true),
    loadRegistry: over.loadRegistry ?? (async () => store),
    saveRegistry: over.saveRegistry ?? (async (d) => { store.records = d.records }),
    now: over.now ?? (() => clock.t),
    emit: over.emit ?? (() => {}),
  }
}

describe('createLimiter', () => {
  it('併發不超過上限', async () => {
    const limiter = createLimiter(2)
    let active = 0, peak = 0
    const task = () => limiter.submit(async () => {
      active++; peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 5)); active--
    })
    await Promise.all([task(), task(), task(), task()])
    expect(peak).toBeLessThanOrEqual(2)
  })
})

describe('provisionEngine', () => {
  it('新設備：改 IP → 下一輪認回 → 設 SIP → done', async () => {
    const changeIp = jest.fn(async () => ({ success: true }))
    const setSip = jest.fn(async () => true)
    const seq = [[dev('AA', '192.168.0.50')], [dev('AA', '192.168.1.101')]]
    let round = 0
    const deps = makeDeps({ discover: async () => seq[round++] ?? [], changeIp, setSipPrimary: setSip })
    const eng = createProvisionEngine(cfg, deps)
    await eng.runRound() // 發現 AA → changeIp(→.101, name GT-8001) → waiting_online
    expect(changeIp).toHaveBeenCalledTimes(1)
    expect(changeIp.mock.calls[0][0]).toMatchObject({ newIp: '192.168.1.101', newName: 'GT-8001' })
    await eng.runRound() // AA 以 .101 回來 → 設 SIP → done
    expect(setSip).toHaveBeenCalledTimes(1)
    expect(setSip.mock.calls[0][1]).toMatchObject({ user_id: '8001', password: 'pw', server_address: '192.168.1.10', server_port: 5060 })
    expect(eng.getTasks().find((t) => t.mac === 'AA')?.status).toBe('done')
  })

  it('登記表已 provisioned 且 regUser 相符 → 跳過', async () => {
    const store: ProvisionRegistryFile = { config: null, records: [
      { mac: 'BB', assignedIp: '192.168.1.101', assignedExt: 8001, status: 'provisioned', updatedAt: '' }] }
    const changeIp = jest.fn(async () => ({ success: true }))
    const deps = makeDeps({ discover: async () => [dev('BB', '192.168.1.101', '8001')],
      loadRegistry: async () => store, changeIp })
    const eng = createProvisionEngine(cfg, deps)
    await eng.runRound()
    expect(changeIp).not.toHaveBeenCalled()
    expect(eng.getTasks().find((t) => t.mac === 'BB')?.status).toBe('skipped')
  })

  it('crash 真空：status=pending 但 regUser 已相符 → 補標 provisioned、跳過', async () => {
    const store: ProvisionRegistryFile = { config: null, records: [
      { mac: 'CC', assignedIp: '192.168.1.101', assignedExt: 8001, status: 'pending', updatedAt: '' }] }
    const setSip = jest.fn(async () => true)
    const deps = makeDeps({ discover: async () => [dev('CC', '192.168.1.101', '8001')],
      loadRegistry: async () => store, setSipPrimary: setSip })
    const eng = createProvisionEngine(cfg, deps)
    await eng.runRound()
    expect(setSip).not.toHaveBeenCalled()
    expect(store.records[0].status).toBe('provisioned')
    expect(eng.getTasks().find((t) => t.mac === 'CC')?.status).toBe('skipped')
  })

  it('恢復出廠：登記表有但 regUser 不符 → 沿用原分配重供裝、不取新號', async () => {
    const store: ProvisionRegistryFile = { config: null, records: [
      { mac: 'DD', assignedIp: '192.168.1.105', assignedExt: 8005, status: 'provisioned', updatedAt: '' }] }
    const changeIp = jest.fn(async () => ({ success: true }))
    // DD 現在 IP 就是原分配 .105（已在正確 IP），regUser 空 → 跳過改 IP、直接設 SIP
    const setSip = jest.fn(async () => true)
    const deps = makeDeps({ discover: async () => [dev('DD', '192.168.1.105', '')],
      loadRegistry: async () => store, changeIp, setSipPrimary: setSip })
    const eng = createProvisionEngine(cfg, deps)
    await eng.runRound()
    expect(changeIp).not.toHaveBeenCalled() // 已在分配 IP → 免改 IP
    expect(setSip.mock.calls[0][1]).toMatchObject({ user_id: '8005' }) // 沿用原分機
  })

  it('waiting_online 逾時：改 IP 後設備不再出現、超過 120s → failed', async () => {
    const clock = { t: 1_000_000 }
    const changeIp = jest.fn(async () => ({ success: true }))
    let round = 0
    const deps = makeDeps({ clock,
      discover: async () => (round++ === 0 ? [dev('EE', '192.168.0.50')] : []), changeIp })
    const eng = createProvisionEngine(cfg, deps)
    await eng.runRound() // → waiting_online, deadline = t + 120000
    clock.t += 121_000
    await eng.runRound() // 設備缺席且逾時 → failed
    expect(eng.getTasks().find((t) => t.mac === 'EE')?.status).toBe('failed')
  })

  it('IP 池用盡 → 暫停並發 paused 事件', async () => {
    const smallCfg: ProvisionConfig = { ...cfg, ipStart: '192.168.1.101', ipEnd: '192.168.1.101', extStart: 8001, extEnd: 8001 }
    const store: ProvisionRegistryFile = { config: null, records: [
      { mac: 'X', assignedIp: '192.168.1.101', assignedExt: 8001, status: 'provisioned', updatedAt: '' }] }
    const events: string[] = []
    const deps = makeDeps({ discover: async () => [dev('YY', '192.168.0.60')],
      loadRegistry: async () => store, emit: (e) => { if (e.kind === 'paused') events.push(e.reason) } })
    const eng = createProvisionEngine(smallCfg, deps)
    await eng.runRound()
    expect(eng.isPaused()).toBe(true)
    expect(events.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm test -- provisionEngine`
Expected: FAIL（模組不存在）。

- [ ] **Step 3: 實作 `src/shared/provisionEngine.ts`**

（完整實作，含 limiter、runRound 四分支判定、狀態機、逾時、暫停）
```ts
import type {
  DeviceNode, IpChangeRequest, ProvisionConfig, ProvisionEvent,
  ProvisionRegistryFile, ProvisionTask, SipConfig, SipConfigResponse,
} from './types'
import { allocate, poolUsage } from './provisionAllocator'

export const ONLINE_TIMEOUT_MS = 120_000
export const ROUND_MIN_MS = 5_000
const MAX_CONCURRENT = 5

/** 小型併發閘：submit 個別 thunk，最多 max 個同時執行，其餘排隊。 */
export function createLimiter(max: number) {
  let active = 0
  const queue: Array<() => void> = []
  const pump = () => {
    if (active >= max || queue.length === 0) return
    active++
    const run = queue.shift()!
    run()
  }
  function submit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        fn().then(resolve, reject).finally(() => { active--; pump() })
      })
      pump()
    })
  }
  return { submit }
}

export interface ProvisionDeps {
  discover: () => Promise<DeviceNode[]>
  changeIp: (req: IpChangeRequest) => Promise<{ success: boolean; error?: string }>
  ensureReachable: (ip: string) => Promise<void>
  getSipConfig: (ip: string) => Promise<SipConfigResponse | null>
  setSipPrimary: (ip: string, cfg: SipConfig) => Promise<boolean>
  loadRegistry: () => Promise<ProvisionRegistryFile>
  saveRegistry: (data: ProvisionRegistryFile) => Promise<void>
  now: () => number
  emit: (e: ProvisionEvent) => void
}

const DEFAULT_SIP: Omit<SipConfig, 'server_address' | 'server_port' | 'user_id' | 'password'> = {
  auto_answer: false, register_timeout: 3600, transport_protocol: 'UDP',
}

export function createProvisionEngine(config: ProvisionConfig, deps: ProvisionDeps) {
  const tasks = new Map<string, ProvisionTask>()
  const limiter = createLimiter(MAX_CONCURRENT)
  let registry: ProvisionRegistryFile = { config, records: [] }
  let loaded = false
  let paused = false
  let stopped = false
  let round = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  const iso = () => new Date(deps.now()).toISOString()
  const log = (message: string) => deps.emit({ kind: 'log', ts: deps.now(), message })
  const pushTask = (t: ProvisionTask) => { tasks.set(t.mac, t); deps.emit({ kind: 'task', task: { ...t } }) }
  const emitPool = () => {
    const u = poolUsage(config, registry.records)
    deps.emit({ kind: 'pool', ipUsed: u.ipUsed, ipTotal: u.ipTotal, extUsed: u.extUsed, extTotal: u.extTotal })
  }

  async function persist() {
    try {
      await deps.saveRegistry(registry)
    } catch (e) {
      log(`⚠️ 登記表寫入失敗，進入降級模式（進度可能無法保存）：${String(e)}`)
    }
  }

  function recordFor(mac: string) {
    return registry.records.find((r) => r.mac === mac)
  }

  async function setRecord(mac: string, patch: Partial<ProvisionRegistryFile['records'][number]>) {
    const rec = recordFor(mac)
    if (rec) Object.assign(rec, patch, { updatedAt: iso() })
    await persist()
  }

  function failTask(mac: string, error: string) {
    const t = tasks.get(mac)
    if (t) { t.status = 'failed'; t.error = error; pushTask(t) }
    log(`❌ ${mac} 供裝失敗：${error}`)
  }

  /** 對某分配 IP，是否被「其他 MAC」的在線設備佔用（本輪掃描）。 */
  function ipTakenByOther(ip: string, selfMac: string, devices: DeviceNode[]): boolean {
    return devices.some((d) => d.ip === ip && d.mac !== selfMac)
  }

  async function configureSip(mac: string, ip: string, ext: number) {
    await deps.ensureReachable(ip)
    const cur = await deps.getSipConfig(ip)
    const base = cur?.primary_line
    const merged: SipConfig = {
      auto_answer: base?.auto_answer ?? DEFAULT_SIP.auto_answer,
      register_timeout: base?.register_timeout ?? DEFAULT_SIP.register_timeout,
      transport_protocol: base?.transport_protocol ?? DEFAULT_SIP.transport_protocol,
      server_address: config.sipServer,
      server_port: config.sipPort,
      user_id: String(ext),
      password: config.sipPassword,
    }
    const ok = await deps.setSipPrimary(ip, merged)
    if (ok) {
      const t = tasks.get(mac)
      if (t) { t.status = 'done'; pushTask(t) }
      await setRecord(mac, { status: 'provisioned', lastError: undefined })
      log(`✅ ${mac} 供裝完成（IP ${ip}、分機 ${ext}）`)
    } else {
      failTask(mac, 'SIP 設定回報失敗')
      await setRecord(mac, { status: 'failed', lastError: 'SIP 設定回報失敗' })
    }
  }

  /** 開始一台的供裝（回傳要交給 limiter 的 thunk）。 */
  function beginProvision(d: DeviceNode, ip: string, ext: number): () => Promise<void> {
    pushTask({ mac: d.mac, ip: d.ip, assignedIp: ip, assignedExt: ext, status: 'ip_assigning' })
    return async () => {
      if (stopped) return
      // 已在分配 IP（重供裝場景）→ 免改 IP，直接設 SIP
      if (d.ip === ip) {
        const t = tasks.get(d.mac); if (t) { t.status = 'sip_configuring'; pushTask(t) }
        await configureSip(d.mac, ip, ext)
        return
      }
      const newName = config.namePrefix + ext
      log(`→ ${d.mac} 改 IP ${d.ip} → ${ip}（名稱 ${newName}），設備將重開機`)
      const res = await deps.changeIp({ device: d, newIp: ip, newMask: config.mask, newGateway: config.gateway, autoIp: 0, newName })
      if (stopped) return
      if (res.success) {
        const t = tasks.get(d.mac)
        if (t) { t.status = 'waiting_online'; t.deadline = deps.now() + ONLINE_TIMEOUT_MS; pushTask(t) }
      } else {
        failTask(d.mac, `IP 設定失敗：${res.error ?? '未知'}`)
        await setRecord(d.mac, { status: 'failed', lastError: res.error })
      }
    }
  }

  /** 對單台設備做判定，回傳要執行的 thunk 或 null（判定本身同步取號、避免競態）。 */
  async function decide(d: DeviceNode, devices: DeviceNode[]): Promise<(() => Promise<void>) | null> {
    if (!d.mac) return null
    const existing = tasks.get(d.mac)
    if (existing) {
      if (existing.status === 'ip_assigning' || existing.status === 'sip_configuring') return null // 忙碌中
      if (existing.status === 'waiting_online') {
        if (d.ip === existing.assignedIp) { // 以新 IP 認回
          existing.status = 'sip_configuring'; existing.ip = d.ip; pushTask(existing)
          return () => configureSip(d.mac, existing.assignedIp, existing.assignedExt)
        }
        return null // 仍在等待
      }
      if (existing.status === 'done' || existing.status === 'skipped') return null
      // failed → 允許本輪不自動重試（交由手動重試）；避免無限重跑
      if (existing.status === 'failed') return null
    }

    const rec = recordFor(d.mac)
    // 規則 2：現況已相符 → 跳過（不看 status，補標 provisioned，堵 crash 真空）
    if (rec && d.regUser && d.regUser === String(rec.assignedExt)) {
      if (rec.status !== 'provisioned') await setRecord(d.mac, { status: 'provisioned', lastError: undefined })
      pushTask({ mac: d.mac, ip: d.ip, assignedIp: rec.assignedIp, assignedExt: rec.assignedExt, status: 'skipped' })
      return null
    }
    // 規則 3：登記表有但現況不符 → 沿用原分配重供裝
    if (rec) {
      if (d.ip !== rec.assignedIp && ipTakenByOther(rec.assignedIp, d.mac, devices)) {
        pushTask({ mac: d.mac, ip: d.ip, assignedIp: rec.assignedIp, assignedExt: rec.assignedExt, status: 'ip_assigning' })
        failTask(d.mac, `分配 IP ${rec.assignedIp} 已被其他設備佔用`)
        return null
      }
      return beginProvision(d, rec.assignedIp, rec.assignedExt)
    }
    // 規則 4：新設備 → 取號 + 佔位
    const alloc = allocate(config, registry.records, new Set(devices.map((x) => x.ip).filter(Boolean)))
    if (!alloc) {
      if (!paused) { paused = true; deps.emit({ kind: 'paused', reason: '號碼池已用盡，供裝暫停' }); log('⏸ 號碼池已用盡，暫停對新設備派工') }
      return null
    }
    registry.records.push({ mac: d.mac, assignedIp: alloc.ip, assignedExt: alloc.ext, status: 'pending', updatedAt: iso() })
    await persist()
    emitPool()
    log(`＋ 發現新設備 ${d.mac} → 分配 IP ${alloc.ip}、分機 ${alloc.ext}`)
    return beginProvision(d, alloc.ip, alloc.ext)
  }

  async function runRound(): Promise<void> {
    if (!loaded) {
      const persisted = await deps.loadRegistry()
      registry = { config, records: persisted.records ?? [] }
      loaded = true
      emitPool()
    }
    round++
    deps.emit({ kind: 'round', round })
    const devices = await deps.discover()
    const now = deps.now()

    // 1. 逾時檢查：waiting_online 且設備本輪缺席或未認回，超過 deadline → failed
    for (const t of tasks.values()) {
      if (t.status === 'waiting_online' && t.deadline !== undefined && now > t.deadline) {
        failTask(t.mac, '改 IP 後未在時限內上線')
        await setRecord(t.mac, { status: 'failed', lastError: '改 IP 後未在時限內上線' })
      }
    }

    // 2. 逐台判定（同步取號避免競態），收集要執行的網路動作
    const actions: Array<() => Promise<void>> = []
    for (const d of devices) {
      const action = await decide(d, devices)
      if (action) actions.push(action)
    }

    // 3. 併發閘執行網路動作（上限 5）；等本輪動作全部落定
    await Promise.all(actions.map((a) => limiter.submit(a)))
  }

  async function loop(): Promise<void> {
    if (stopped) return
    const started = deps.now()
    try {
      await runRound()
    } catch (e) {
      log(`⚠️ 掃描輪發生例外：${String(e)}`)
    }
    if (stopped) return
    const elapsed = deps.now() - started
    const wait = Math.max(0, ROUND_MIN_MS - elapsed)
    timer = setTimeout(() => { void loop() }, wait)
  }

  async function start(): Promise<void> {
    stopped = false
    void loop()
  }

  function stop(): void {
    stopped = true
    if (timer) { clearTimeout(timer); timer = null }
    // 進行中的 waiting_online 任務視為中止（保留登記表 pending，重啟後由判定接手）
    for (const t of tasks.values()) {
      if (t.status === 'waiting_online' || t.status === 'ip_assigning') {
        t.status = 'failed'; t.error = '供裝已停止'; pushTask(t)
      }
    }
    log('⏹ 供裝已停止')
  }

  return {
    runRound,
    start,
    stop,
    getTasks: () => Array.from(tasks.values()).map((t) => ({ ...t })),
    isPaused: () => paused,
  }
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npm test -- provisionEngine`
Expected: PASS（limiter 1 + engine 6 = 7 tests）。

- [ ] **Step 5: typecheck**

Run: `npm run typecheck`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src/shared/provisionEngine.ts test/provisionEngine.test.ts
git commit -m "feat(provision): 供裝引擎核心（純TS狀態機+併發閘）+ 單元測試"
```

---

## Task 6: 供裝 Pinia store

**Files:**
- Create: `src/renderer/stores/provisioning.ts`

**Interfaces:**
- Consumes: `ProvisionConfig`、`ProvisionTask`、`ProvisionEvent`。
- Produces: `useProvisioningStore` with state `{ config, tasks, logs, running, paused, round, pool }` 與 actions `applyEvent(e)`、`setRunning(b)`、`reset()`、`upsertTask(t)`。

- [ ] **Step 1: 實作 store**

`src/renderer/stores/provisioning.ts`:
```ts
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ProvisionConfig, ProvisionEvent, ProvisionTask } from '@shared/types'

export interface LogLine { ts: number; message: string }

export const useProvisioningStore = defineStore('provisioning', () => {
  const config = ref<ProvisionConfig | null>(null)
  const tasks = ref<ProvisionTask[]>([])
  const logs = ref<LogLine[]>([])
  const running = ref(false)
  const paused = ref(false)
  const round = ref(0)
  const pool = ref({ ipUsed: 0, ipTotal: 0, extUsed: 0, extTotal: 0 })

  function upsertTask(t: ProvisionTask) {
    const i = tasks.value.findIndex((x) => x.mac === t.mac)
    if (i >= 0) tasks.value[i] = t
    else tasks.value.push(t)
  }

  function applyEvent(e: ProvisionEvent) {
    if (e.kind === 'task') upsertTask(e.task)
    else if (e.kind === 'log') {
      logs.value.push({ ts: e.ts, message: e.message })
      if (logs.value.length > 500) logs.value.splice(0, logs.value.length - 500)
    } else if (e.kind === 'paused') paused.value = true
    else if (e.kind === 'pool') pool.value = { ipUsed: e.ipUsed, ipTotal: e.ipTotal, extUsed: e.extUsed, extTotal: e.extTotal }
    else if (e.kind === 'round') round.value = e.round
  }

  function setRunning(b: boolean) { running.value = b; if (b) paused.value = false }
  function reset() { tasks.value = []; logs.value = []; round.value = 0; paused.value = false }

  return { config, tasks, logs, running, paused, round, pool, applyEvent, upsertTask, setRunning, reset }
})
```

- [ ] **Step 2: typecheck**

Run: `npm run typecheck`
Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add src/renderer/stores/provisioning.ts
git commit -m "feat(provision): 供裝 Pinia store"
```

---

## Task 7: useAutoProvisioning composable（Vue 接線）

把引擎的注入 deps 接到真實 IPC / deviceApi，並把引擎事件導進 store。

**Files:**
- Create: `src/renderer/composables/useAutoProvisioning.ts`

**Interfaces:**
- Consumes: `createProvisionEngine`（Task 5）、`useProvisioningStore`（Task 6）、`deviceApi` 的 `getSipConfig`/`setSipPrimary`。
- Produces: `useAutoProvisioning(): { start(config): Promise<void>; stop(): void }`

- [ ] **Step 1: 實作**

`src/renderer/composables/useAutoProvisioning.ts`:
```ts
import { createProvisionEngine, type ProvisionDeps } from '@shared/provisionEngine'
import type { ProvisionConfig, ProvisionRegistryFile } from '@shared/types'
import { getSipConfig, setSipPrimary } from '@/composables/deviceApi'
import { useProvisioningStore } from '@/stores/provisioning'

export function useAutoProvisioning() {
  const store = useProvisioningStore()
  let engine: ReturnType<typeof createProvisionEngine> | null = null

  async function start(config: ProvisionConfig): Promise<void> {
    store.reset()
    store.config = config
    // 啟動時把 config 併入登記表持久化（保留既有 records）
    const read = await window.electronAPI.readRegistry()
    const existing: ProvisionRegistryFile = read.success && read.data ? read.data : { config: null, records: [] }
    await window.electronAPI.writeRegistry({ config, records: existing.records })

    const deps: ProvisionDeps = {
      discover: async () => {
        const r = await window.electronAPI.dbpDiscover()
        return r.success && r.devices ? r.devices : []
      },
      changeIp: (req) => window.electronAPI.changeIp(req),
      ensureReachable: async (ip) => { await window.electronAPI.ensureReachable(ip) },
      getSipConfig: (ip) => getSipConfig(ip),
      setSipPrimary: (ip, cfg) => setSipPrimary(ip, cfg),
      loadRegistry: async () => {
        const res = await window.electronAPI.readRegistry()
        return res.success && res.data ? res.data : { config, records: [] }
      },
      saveRegistry: async (data) => {
        const res = await window.electronAPI.writeRegistry(data)
        if (!res.success) throw new Error(res.error ?? 'registry write failed')
      },
      now: () => Date.now(),
      emit: (e) => store.applyEvent(e),
    }
    engine = createProvisionEngine(config, deps)
    store.setRunning(true)
    await engine.start()
  }

  function stop(): void {
    engine?.stop()
    engine = null
    store.setRunning(false)
  }

  return { start, stop }
}
```

- [ ] **Step 2: typecheck**

Run: `npm run typecheck`
Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add src/renderer/composables/useAutoProvisioning.ts
git commit -m "feat(provision): useAutoProvisioning composable（引擎↔IPC/deviceApi 接線）"
```

---

## Task 8: AutoProvisionView.vue

**Files:**
- Create: `src/renderer/components/AutoProvisionView.vue`

**Interfaces:**
- Consumes: `useAutoProvisioning`（Task 7）、`useProvisioningStore`（Task 6）。
- Produces: 具名匯出的 SFC，供 `App.vue` 在 `currentView === 'provision'` 時掛載。

- [ ] **Step 1: 實作（表單 + 啟停 + 任務表 + 日誌；沿用專案 Tailwind 樣式）**

`src/renderer/components/AutoProvisionView.vue`:
```vue
<script setup lang="ts">
import { reactive, computed } from 'vue'
import type { ProvisionConfig } from '@shared/types'
import { useProvisioningStore } from '@/stores/provisioning'
import { useAutoProvisioning } from '@/composables/useAutoProvisioning'

const store = useProvisioningStore()
const { start, stop } = useAutoProvisioning()

const form = reactive<ProvisionConfig>({
  ipStart: '', ipEnd: '', mask: '255.255.255.0', gateway: '',
  extStart: 8001, extEnd: 8100, sipPassword: '', sipServer: '', sipPort: 5060, namePrefix: '',
})

const error = computed<string | null>(() => {
  if (!store.running) {
    if (!form.ipStart || !form.ipEnd) return '請填 IP 範圍'
    if (!form.gateway) return '請填閘道'
    if (form.extStart > form.extEnd) return '分機起始不可大於結束'
    if (!form.sipServer) return '請填 SIP Server'
    if (!form.sipPassword) return '請填 SIP 密碼'
  }
  return null
})

function statusLabel(s: string): string {
  return { discovered: '已發現', ip_assigning: '改 IP 中', waiting_online: '等待上線',
    sip_configuring: '設定 SIP 中', done: '完成', skipped: '已跳過', failed: '失敗' }[s] ?? s
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString('zh-TW', { hour12: false })
}

async function onStart() { if (!error.value) await start({ ...form }) }
function onStop() { stop() }
</script>

<template>
  <div class="p-6 space-y-6 text-on-surface">
    <h2 class="text-lg font-bold text-primary uppercase tracking-wider">自動供裝</h2>

    <!-- 設定表單 -->
    <div class="grid grid-cols-2 md:grid-cols-3 gap-4 bg-surface-container p-4 rounded-lg border border-outline-variant/20">
      <label class="flex flex-col gap-1 text-xs">IP 起<input v-model="form.ipStart" :disabled="store.running" class="input" placeholder="192.168.1.101" /></label>
      <label class="flex flex-col gap-1 text-xs">IP 訖<input v-model="form.ipEnd" :disabled="store.running" class="input" placeholder="192.168.1.200" /></label>
      <label class="flex flex-col gap-1 text-xs">遮罩<input v-model="form.mask" :disabled="store.running" class="input" /></label>
      <label class="flex flex-col gap-1 text-xs">閘道<input v-model="form.gateway" :disabled="store.running" class="input" placeholder="192.168.1.1" /></label>
      <label class="flex flex-col gap-1 text-xs">分機起<input v-model.number="form.extStart" :disabled="store.running" type="number" class="input" /></label>
      <label class="flex flex-col gap-1 text-xs">分機訖<input v-model.number="form.extEnd" :disabled="store.running" type="number" class="input" /></label>
      <label class="flex flex-col gap-1 text-xs">SIP Server<input v-model="form.sipServer" :disabled="store.running" class="input" /></label>
      <label class="flex flex-col gap-1 text-xs">SIP Port<input v-model.number="form.sipPort" :disabled="store.running" type="number" class="input" /></label>
      <label class="flex flex-col gap-1 text-xs">SIP 密碼<input v-model="form.sipPassword" :disabled="store.running" type="password" class="input" /></label>
      <label class="flex flex-col gap-1 text-xs">名稱前綴<input v-model="form.namePrefix" :disabled="store.running" class="input" placeholder="GT-" /></label>
    </div>

    <!-- 啟停 + 狀態列 -->
    <div class="flex items-center gap-4">
      <button v-if="!store.running" class="btn-primary" :disabled="!!error" @click="onStart">▶ 啟動供裝</button>
      <button v-else class="btn-danger" @click="onStop">⏹ 停止</button>
      <span v-if="error" class="text-error text-xs">{{ error }}</span>
      <span v-if="store.running" class="text-xs text-on-surface-variant">
        第 {{ store.round }} 輪 · IP {{ store.pool.ipUsed }}/{{ store.pool.ipTotal }} · 分機 {{ store.pool.extUsed }}/{{ store.pool.extTotal }}
      </span>
      <span v-if="store.paused" class="text-error text-xs font-bold">⚠️ 號碼池用盡，已暫停</span>
    </div>

    <!-- 任務表 -->
    <div class="bg-surface-container rounded-lg border border-outline-variant/20 overflow-hidden">
      <table class="w-full text-xs">
        <thead class="bg-surface-container-high text-on-surface-variant uppercase tracking-wider">
          <tr><th class="p-2 text-left">MAC</th><th class="p-2 text-left">狀態</th><th class="p-2 text-left">分配 IP</th><th class="p-2 text-left">分機</th><th class="p-2 text-left">錯誤</th></tr>
        </thead>
        <tbody>
          <tr v-for="t in store.tasks" :key="t.mac" class="border-t border-outline-variant/10">
            <td class="p-2 font-mono">{{ t.mac }}</td>
            <td class="p-2">{{ statusLabel(t.status) }}</td>
            <td class="p-2 font-mono">{{ t.assignedIp }}</td>
            <td class="p-2">{{ t.assignedExt }}</td>
            <td class="p-2 text-error">{{ t.error ?? '' }}</td>
          </tr>
          <tr v-if="store.tasks.length === 0"><td colspan="5" class="p-4 text-center text-on-surface-variant">尚無設備</td></tr>
        </tbody>
      </table>
    </div>

    <!-- 活動日誌 -->
    <div class="bg-black/40 rounded-lg p-3 h-48 overflow-y-auto font-mono text-[11px] text-on-surface-variant space-y-0.5">
      <div v-for="(l, i) in store.logs" :key="i"><span class="text-primary/60">{{ fmtTime(l.ts) }}</span> {{ l.message }}</div>
    </div>
  </div>
</template>

<style scoped>
.input { @apply bg-surface border border-outline-variant/30 rounded px-2 py-1 text-on-surface focus:border-primary outline-none; }
.btn-primary { @apply px-4 py-2 bg-primary/20 text-primary border border-primary/40 rounded uppercase text-xs tracking-wider hover:bg-primary/30 disabled:opacity-40 disabled:cursor-not-allowed; }
.btn-danger { @apply px-4 py-2 bg-error/20 text-error border border-error/40 rounded uppercase text-xs tracking-wider hover:bg-error/30; }
</style>
```

- [ ] **Step 2: typecheck**

Run: `npm run typecheck`
Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/AutoProvisionView.vue
git commit -m "feat(provision): 自動供裝 UI（表單+啟停+任務表+日誌）"
```

---

## Task 9: 導覽整合

**Files:**
- Modify: `src/renderer/components/AppLayout.vue:5-9`（navItems）
- Modify: `src/renderer/App.vue`（currentView 型別 + view 掛載 + handleNavigate）

**Interfaces:**
- Consumes: `AutoProvisionView`（Task 8）。

- [ ] **Step 1: navItems 加一筆**

`src/renderer/components/AppLayout.vue` 的 `navItems`（在 `batch` 後）加：
```ts
  { id: 'provision', label: '自動供裝', icon: 'auto_mode' },
```

- [ ] **Step 2: App.vue 掛載 view**

`src/renderer/App.vue`：
1. import 加 `import AutoProvisionView from '@/components/AutoProvisionView.vue'`
2. `currentView` 型別擴充：`const currentView = ref<'radar' | 'devices' | 'provision'>('radar')`
3. 在 `</AppLayout>` 前（devices template 後）加：
```vue
      <!-- Auto Provisioning View -->
      <template v-if="currentView === 'provision'">
        <AutoProvisionView />
      </template>
```
4. `handleNavigate` 的 `if (view === 'radar' || view === 'devices')` 改為 `if (view === 'radar' || view === 'devices' || view === 'provision')`

- [ ] **Step 3: typecheck**

Run: `npm run typecheck`
Expected: PASS。

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/AppLayout.vue src/renderer/App.vue
git commit -m "feat(provision): 導覽列與 App view 掛載自動供裝頁"
```

---

## Task 10: 全量測試 + app 實跑驗證

**Files:** 無新增。

- [ ] **Step 1: 全量單元測試綠燈**

Run: `npm test`
Expected: 所有測試 PASS（allocator 6 + registry 3 + engine/limiter 7 + smoke 1）。

- [ ] **Step 2: typecheck 全綠**

Run: `npm run typecheck`
Expected: PASS。

- [ ] **Step 3: app 實跑冒煙（verify skill / dev server）**

啟動 dev server，進「自動供裝」頁，確認：表單可填、驗證擋錯、啟動後狀態列跳動、無 console error。（真機 E2E 走 .147 環境另行。）

- [ ] **Step 4: detect_changes 核對影響範圍**

Run: `bash scripts/gitnexus-fresh.sh && ` 然後用 GitNexus `detect_changes({scope:"compare", base_ref:"main"})` 確認只動到預期符號。

- [ ] **Step 5: 交 adversarial-reviewer 對抗審查後才收尾**

---

## Self-Review

- **Spec coverage**：§1 目標→T7/T8；§5 資料結構→T1；§6.1 掃描循環→T5 loop；§6.2 四分支判定→T5 decide（測試涵蓋規則2/3/4+crash真空）；§6.3 狀態機→T5 beginProvision/configureSip；§6.4 取號器→T3；§6.5 可達性→T4 IPC + T5 ensureReachable（偏離2：停止不清別名）；§7 UI→T8；§8 錯誤表→T5（逾時/池盡/寫入降級/停止）+T4（壞檔）；§9 測試→T3/T4/T5；§10 前置→已於規劃階段完成（gitnexus-fresh + impact）。
- **Placeholder scan**：無 TBD；每個 code step 附完整碼。
- **Type consistency**：`ProvisionDeps`/`ProvisionTask`/`ProvisionEvent` 於 T1/T5 定義並於 T6/T7 一致引用；`SipConfig` 七欄與既有 `types.ts` 對齊；`allocate`/`poolUsage` 簽名 T3↔T5 一致。

# CMS 16 區組播監聽區 UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 CMS 對支援多監聽區的 gt-sip-gw 設備提供完整 16 區組播監聽區可編輯表，取代危險的單槽組播卡；舊韌體維持單槽卡。

**Architecture:** 純函式模組（`src/shared/multicastZones.ts`）承載全部驗證/正規化/判別邏輯（jest 覆蓋）；`deviceApi` 加兩支 REST 函式；`useMulticastZonesCapability` composable 掛載時探測能力回四態；`MulticastZones.vue` 渲染 16 區表；`DeviceDetail.vue` 依能力 gate 分頁與單槽卡。

**Tech Stack:** Electron + Vue 3（`<script setup lang="ts">`）、axios（deviceApi）、jest + ts-jest（`test/`）、TypeScript strict。

## Global Constraints

- 型別/API 契約與 `docs/superpowers/specs/2026-07-23-cms-16zone-multicast-ui-design.md` 一致。
- 測試放 `test/`（jest `roots: ['<rootDir>/test']`），import 用 `@shared/*`、`@/*` 別名（moduleNameMapper 已設）。TypeScript **strict**。
- 16 區規則對齊設備 device-web `renderMulticastZones` 與 mzrelay3.c 伺服器驗證：位址 224–239、埠 1024–65535、優先權 1–16（啟用區全域唯一）、codec ∈ {`G.711U`,`G.722`}。
- E001 回應：`{"status":"error","error_code":"E001","message":"zone_id N: <原因>"}`（zone id 在 `message` 欄，`.70` 實測確認）。
- 回饋沿用 CMS `alert()`（無 toast 系統）。DRY / YAGNI / TDD / 頻繁 commit。
- 不夾帶工作樹既有未提交改動（`AGENTS.md`/`CLAUDE.md`/待辦1 的 mzweb 檔）：每次 `git add` 只加該 task 明列檔案。

---

### Task 1: 純函式模組 + 型別（核心邏輯，全 jest 覆蓋）

**Files:**
- Modify: `src/shared/types.ts`（加 `MulticastZone`、`ZonesProbe`）
- Create: `src/shared/multicastZones.ts`
- Test: `test/multicastZones.test.ts`

**Interfaces:**
- Produces:
  - `interface MulticastZone { zone_id:number; multicast_address:string; multicast_port:number; priority:number; enabled:boolean; audio_codec:string }`
  - `type ZonesProbe = { status:'zones'; zones:MulticastZone[] } | { status:'unsupported' } | { status:'error' }`
  - `MZ_COUNT:16`、`MZ_CODEC_PAIRS:readonly [string,string][]`
  - `normalizeZones(raw: MulticastZone[] | null): MulticastZone[]`
  - `validateZones(zones: MulticastZone[]): { zone_id:number; message:string }[]`
  - `serializeZones(zones: MulticastZone[]): MulticastZone[]`
  - `classifyZonesProbe(r: { ok?:boolean; zones?:unknown; httpStatus?:number }): 'zones'|'unsupported'|'error'`
  - `parseZoneIdFromMessage(message: string): number | undefined`

- [ ] **Step 1: 加型別到 `src/shared/types.ts`**（接在既有 `MulticastConfig` 之後）

```ts
export interface MulticastZone {
  zone_id: number
  multicast_address: string
  multicast_port: number
  priority: number
  enabled: boolean
  audio_codec: string
}

export type ZonesProbe =
  | { status: 'zones'; zones: MulticastZone[] }
  | { status: 'unsupported' }
  | { status: 'error' }
```

- [ ] **Step 2: 寫失敗測試 `test/multicastZones.test.ts`**

```ts
import {
  MZ_COUNT, MZ_CODEC_PAIRS, normalizeZones, validateZones,
  serializeZones, classifyZonesProbe, parseZoneIdFromMessage,
} from '@shared/multicastZones'
import type { MulticastZone } from '@shared/types'

const z = (p: Partial<MulticastZone>): MulticastZone => ({
  zone_id: 1, multicast_address: '', multicast_port: 0, priority: 0,
  enabled: false, audio_codec: '', ...p,
})

describe('常數', () => {
  it('MZ_COUNT=16、codec 為 G.711U/G.722', () => {
    expect(MZ_COUNT).toBe(16)
    expect(MZ_CODEC_PAIRS.map(([v]) => v)).toEqual(['G.711U', 'G.722'])
  })
})

describe('normalizeZones', () => {
  it('null → 16 筆停用佔位列（zone_id 1..16）', () => {
    const out = normalizeZones(null)
    expect(out).toHaveLength(16)
    expect(out[0]).toEqual(z({ zone_id: 1 }))
    expect(out[15].zone_id).toBe(16)
    expect(out.every((r) => !r.enabled)).toBe(true)
  })
  it('少於 16 筆 + 亂序 → 依 zone_id 補位到 16', () => {
    const out = normalizeZones([z({ zone_id: 3, enabled: true, priority: 2 })])
    expect(out).toHaveLength(16)
    expect(out[2]).toMatchObject({ zone_id: 3, enabled: true, priority: 2 })
    expect(out[0]).toEqual(z({ zone_id: 1 }))
  })
  it('過濾髒資料：null entry / zone_id==null / 超界 zone_id 不汙染', () => {
    const raw = [null, z({ zone_id: 2, enabled: true }), { zone_id: null } as unknown as MulticastZone,
                 z({ zone_id: 99 })] as (MulticastZone | null)[]
    const out = normalizeZones(raw as MulticastZone[])
    expect(out).toHaveLength(16)
    expect(out[1]).toMatchObject({ zone_id: 2, enabled: true })
    expect(out[0]).toEqual(z({ zone_id: 1 })) // 未被 null/99 汙染
  })
  it('port/priority 字串化輸入 → 強制成 number（型別維持 number）', () => {
    const raw = [{ zone_id: 1, multicast_address: '239.1.1.1', multicast_port: '2000',
                   priority: '3', enabled: true, audio_codec: 'G.722' }] as unknown as MulticastZone[]
    expect(normalizeZones(raw)[0]).toMatchObject({ multicast_port: 2000, priority: 3 })
  })
})

describe('validateZones', () => {
  const good = z({ zone_id: 1, multicast_address: '239.1.1.1', multicast_port: 2000, priority: 1, enabled: true, audio_codec: 'G.722' })
  it('合法啟用列 → 無錯', () => {
    expect(validateZones([good, ...Array.from({ length: 15 }, (_, i) => z({ zone_id: i + 2 }))])).toEqual([])
  })
  it('佔位列（全空停用）→ 略過驗證', () => {
    expect(validateZones([z({ zone_id: 1 })])).toEqual([])
  })
  it('位址邊界：223/240 擋、224/239 過', () => {
    expect(validateZones([z({ ...good, multicast_address: '223.1.1.1' })])).toHaveLength(1)
    expect(validateZones([z({ ...good, multicast_address: '240.1.1.1' })])).toHaveLength(1)
    expect(validateZones([z({ ...good, multicast_address: '224.1.1.1' })])).toEqual([])
    expect(validateZones([z({ ...good, multicast_address: '239.255.255.255' })])).toEqual([])
  })
  it('非法 dotted-quad 擋（超 255 / 少段 / 非數字）', () => {
    for (const a of ['224.500.1.1', '224.256.1.1', '224.1.1', '224.1.1.1.1', 'abc', '239']) {
      expect(validateZones([z({ ...good, multicast_address: a })])).toHaveLength(1)
    }
  })
  it('埠邊界 1023/65536 擋、1024/65535 過', () => {
    expect(validateZones([z({ ...good, multicast_port: 1023 })])).toHaveLength(1)
    expect(validateZones([z({ ...good, multicast_port: 65536 })])).toHaveLength(1)
    expect(validateZones([z({ ...good, multicast_port: 1024 })])).toEqual([])
  })
  it('優先權邊界 0/17 擋、1/16 過、非整數擋', () => {
    expect(validateZones([z({ ...good, priority: 0 })])).toHaveLength(1)
    expect(validateZones([z({ ...good, priority: 17 })])).toHaveLength(1)
    expect(validateZones([z({ ...good, priority: 1.5 })])).toHaveLength(1)
    expect(validateZones([z({ ...good, priority: 16 })])).toEqual([])
  })
  it('touched 但停用（有值）仍完整驗證', () => {
    expect(validateZones([z({ zone_id: 1, multicast_address: '1.2.3.4', enabled: false })])).toHaveLength(1)
  })
  it('codec 必選：touched 列缺 codec → 擋', () => {
    expect(validateZones([z({ ...good, audio_codec: '' })])).toHaveLength(1)
  })
  it('啟用區優先權全域唯一：重複 → 擋（停用區不計）', () => {
    const a = z({ zone_id: 1, multicast_address: '239.1.1.1', multicast_port: 2000, priority: 5, enabled: true, audio_codec: 'G.722' })
    const b = z({ zone_id: 2, multicast_address: '239.1.1.2', multicast_port: 2001, priority: 5, enabled: true, audio_codec: 'G.722' })
    const c = z({ zone_id: 3, multicast_address: '239.1.1.3', multicast_port: 2002, priority: 5, enabled: false, audio_codec: 'G.722' })
    const errs = validateZones([a, b, c])
    expect(errs.some((e) => e.zone_id === 2)).toBe(true)
    expect(errs.some((e) => e.zone_id === 3)).toBe(false)
  })
})

describe('serializeZones', () => {
  it('套預設值：空 codec→G.722、空 port/prio→0', () => {
    expect(serializeZones([z({ zone_id: 1 })])[0]).toMatchObject({ multicast_port: 0, priority: 0, audio_codec: 'G.722' })
  })
})

describe('classifyZonesProbe', () => {
  it('成功含非空 zones → zones', () => {
    expect(classifyZonesProbe({ ok: true, zones: [{ zone_id: 1 }] })).toBe('zones')
  })
  it('成功但 zones 空/缺 → unsupported', () => {
    expect(classifyZonesProbe({ ok: true, zones: [] })).toBe('unsupported')
    expect(classifyZonesProbe({ ok: true, zones: undefined })).toBe('unsupported')
  })
  it('錯誤帶 http status（設備有回應）→ unsupported', () => {
    expect(classifyZonesProbe({ ok: false, httpStatus: 404 })).toBe('unsupported')
    expect(classifyZonesProbe({ ok: false, httpStatus: 500 })).toBe('unsupported')
  })
  it('錯誤無回應（逾時/傳輸）→ error', () => {
    expect(classifyZonesProbe({ ok: false })).toBe('error')
  })
})

describe('parseZoneIdFromMessage', () => {
  it('從 E001 message 萃取 zone id', () => {
    expect(parseZoneIdFromMessage('zone_id 7: multicast_address invalid (224-239 required)')).toBe(7)
  })
  it('無法萃取 → undefined', () => {
    expect(parseZoneIdFromMessage('unexpected error')).toBeUndefined()
    expect(parseZoneIdFromMessage('')).toBeUndefined()
  })
})
```

- [ ] **Step 3: 執行測試確認失敗**

Run: `npx jest --runInBand multicastZones`
Expected: FAIL —「Cannot find module '@shared/multicastZones'」

- [ ] **Step 4: 實作 `src/shared/multicastZones.ts`**

```ts
import type { MulticastZone } from './types'

export const MZ_COUNT = 16
export const MZ_CODEC_PAIRS: readonly [string, string][] = [
  ['G.711U', 'G.711 µ-law'],
  ['G.722', 'G.722'],
]
const MZ_CODECS: readonly string[] = MZ_CODEC_PAIRS.map(([v]) => v)

function emptyZone(id: number): MulticastZone {
  return { zone_id: id, multicast_address: '', multicast_port: 0, priority: 0, enabled: false, audio_codec: '' }
}

/** 補滿至 16 筆；先過濾髒資料（null / zone_id 缺或超界），缺漏 zone_id 補停用佔位列。 */
export function normalizeZones(raw: MulticastZone[] | null): MulticastZone[] {
  const byId = new Map<number, MulticastZone>()
  if (Array.isArray(raw)) {
    for (const z of raw) {
      const id = z == null ? null : Number(z.zone_id)
      if (id == null || !Number.isInteger(id) || id < 1 || id > MZ_COUNT) continue
      byId.set(id, {
        zone_id: id,
        multicast_address: z.multicast_address ?? '',
        multicast_port: Number(z.multicast_port) || 0,
        priority: Number(z.priority) || 0,
        enabled: !!z.enabled,
        audio_codec: z.audio_codec ?? '',
      })
    }
  }
  const out: MulticastZone[] = []
  for (let i = 1; i <= MZ_COUNT; i++) out.push(byId.get(i) ?? emptyZone(i))
  return out
}

function isValidMulticastAddr(addr: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr)
  if (!m) return false
  const octs = [m[1], m[2], m[3], m[4]].map((s) => Number(s))
  if (octs.some((o) => o < 0 || o > 255)) return false
  return octs[0] >= 224 && octs[0] <= 239
}

function isTouched(z: MulticastZone): boolean {
  return z.enabled || !!z.multicast_address || !!z.multicast_port || !!z.priority || !!z.audio_codec
}

/** 回全部錯誤（每列至多一則）；空陣列＝通過。 */
export function validateZones(zones: MulticastZone[]): { zone_id: number; message: string }[] {
  const errors: { zone_id: number; message: string }[] = []
  for (const z of zones) {
    if (!isTouched(z)) continue
    if (!isValidMulticastAddr(z.multicast_address)) {
      errors.push({ zone_id: z.zone_id, message: `Zone ${z.zone_id} 組播位址錯誤：須為 224.x.x.x – 239.x.x.x` })
      continue
    }
    if (!(Number.isInteger(z.multicast_port) && z.multicast_port >= 1024 && z.multicast_port <= 65535)) {
      errors.push({ zone_id: z.zone_id, message: `Zone ${z.zone_id} 埠錯誤：須介於 1024 – 65535` })
      continue
    }
    if (!(Number.isInteger(z.priority) && z.priority >= 1 && z.priority <= MZ_COUNT)) {
      errors.push({ zone_id: z.zone_id, message: `Zone ${z.zone_id} 優先權錯誤：須介於 1 – ${MZ_COUNT} 的整數` })
      continue
    }
    if (!MZ_CODECS.includes(z.audio_codec)) {
      errors.push({ zone_id: z.zone_id, message: `Zone ${z.zone_id} 未選音頻編碼` })
      continue
    }
  }
  // 啟用區優先權全域唯一（已有其他錯誤的列不再疊加）
  const seen = new Map<number, number>()
  for (const z of zones) {
    if (!z.enabled) continue
    if (errors.some((e) => e.zone_id === z.zone_id)) continue
    const prev = seen.get(z.priority)
    if (prev != null) {
      errors.push({ zone_id: z.zone_id, message: `Zone ${z.zone_id} 優先權 ${z.priority} 與 Zone ${prev} 重複（啟用區須全域唯一）` })
    } else {
      seen.set(z.priority, z.zone_id)
    }
  }
  return errors
}

/** 套送出預設值（對齊 device-web）：port||0、priority||0、codec||"G.722"。 */
export function serializeZones(zones: MulticastZone[]): MulticastZone[] {
  return zones.map((z) => ({
    zone_id: z.zone_id,
    multicast_address: z.multicast_address,
    multicast_port: z.multicast_port || 0,
    priority: z.priority || 0,
    enabled: z.enabled,
    audio_codec: z.audio_codec || 'G.722',
  }))
}

/** 能力偵測判別：成功含非空 zones=zones；設備有回應但無 zones/http 錯=unsupported；無回應=error。 */
export function classifyZonesProbe(r: { ok?: boolean; zones?: unknown; httpStatus?: number }): 'zones' | 'unsupported' | 'error' {
  if (r.ok) return Array.isArray(r.zones) && r.zones.length > 0 ? 'zones' : 'unsupported'
  if (r.httpStatus != null) return 'unsupported'
  return 'error'
}

/** 從 E001 message（"zone_id N: ..."）萃取 zone id；失敗回 undefined。 */
export function parseZoneIdFromMessage(message: string): number | undefined {
  const m = /zone_id\s+(\d+)/i.exec(message || '')
  return m ? Number(m[1]) : undefined
}
```

- [ ] **Step 5: 執行測試確認通過**

Run: `npx jest --runInBand multicastZones`
Expected: PASS（全部 describe 綠燈）

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/shared/multicastZones.ts test/multicastZones.test.ts
git commit -m "feat(cms): 16 區組播純函式模組（normalize/validate/serialize/classify）+ jest

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: deviceApi 兩支 REST 函式

**Files:**
- Modify: `src/renderer/composables/deviceApi.ts`（新增函式 + import）

**Interfaces:**
- Consumes（Task 1）：`classifyZonesProbe`、`parseZoneIdFromMessage`、`MulticastZone`、`ZonesProbe`；既有 `createDeviceApiClient(ip)`。
- Produces:
  - `probeSipMulticastZones(ip: string): Promise<ZonesProbe>`
  - `setSipMulticastZones(ip: string, zones: MulticastZone[]): Promise<{ ok: boolean; errorZoneId?: number; message?: string }>`

- [ ] **Step 1: 加 import**（`deviceApi.ts` 頂部 type import 區）

```ts
import type {
  DeviceStatus, VolumeConfig, SipConfig, SipConfigResponse, MulticastConfig,
  SipParameters, SipCodecs, CallStatus, NetworkConfig, MulticastZone, ZonesProbe,
} from '@shared/types'
import { classifyZonesProbe, parseZoneIdFromMessage } from '@shared/multicastZones'
```

- [ ] **Step 2: 加 `probeSipMulticastZones`**（接在既有 Module 4 SIP & Multicast 區塊末、`setSipMulticast` 之後）

```ts
/**
 * 4.7 探測設備是否支援 16 區多監聽區（能力偵測）。
 * 區分「舊韌體/未支援」與「逾時/傳輸失敗」——後者不可回退顯示危險單槽卡（斷鏈防護）。
 * error（無回應）時重試一次；仍失敗才回 {status:'error'}。
 */
export async function probeSipMulticastZones(ip: string): Promise<ZonesProbe> {
  const api = createDeviceApiClient(ip)
  const attempt = async (): Promise<ZonesProbe> => {
    try {
      const res = await api.get('/get/sip/multicast/zones')
      const data = res.data as { zones?: unknown } | null
      const kind = classifyZonesProbe({ ok: true, zones: data?.zones })
      if (kind === 'zones') return { status: 'zones', zones: (data as { zones: MulticastZone[] }).zones }
      return { status: 'unsupported' }
    } catch (err: unknown) {
      const httpStatus = (err as { response?: { status?: number } })?.response?.status
      const kind = classifyZonesProbe({ ok: false, httpStatus })
      return kind === 'error' ? { status: 'error' } : { status: 'unsupported' }
    }
  }
  let r = await attempt()
  if (r.status === 'error') {
    await new Promise((res) => setTimeout(res, 800))
    r = await attempt()
  }
  return r
}
```

- [ ] **Step 3: 加 `setSipMulticastZones`**（接續其後）

```ts
/**
 * 4.8 整表 16 筆一次送。不走 postRetry（其只回 boolean、丟棄 body），改用專用呼叫取
 * 完整解析 body 以顯示 E001 指名的 zone。伺服器恆 HTTP 200，status:"error"+E001 為業務拒絕。
 */
export async function setSipMulticastZones(
  ip: string, zones: MulticastZone[]
): Promise<{ ok: boolean; errorZoneId?: number; message?: string }> {
  const api = createDeviceApiClient(ip)
  try {
    const res = await api.post('/set/sip/multicast/zones', { zones })
    const data = res.data as { status?: string; message?: string } | null
    if (data?.status === 'success') return { ok: true }
    const message = data?.message ?? '設備拒絕儲存'
    return { ok: false, message, errorZoneId: parseZoneIdFromMessage(message) }
  } catch {
    return { ok: false, message: '設備無回應或連線失敗' }
  }
}
```

- [ ] **Step 4: 型別檢查**

Run: `npx tsc -p tsconfig.web.json --noEmit`
Expected: 無新錯誤（既有專案若已綠，維持綠）

- [ ] **Step 5: Commit**

```bash
git add src/renderer/composables/deviceApi.ts
git commit -m "feat(cms): deviceApi 加 probeSipMulticastZones/setSipMulticastZones（能力偵測+E001 解析）

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: 能力偵測 composable

**Files:**
- Create: `src/renderer/composables/useMulticastZonesCapability.ts`

**Interfaces:**
- Consumes（Task 2）：`probeSipMulticastZones`；（Task 1）`MulticastZone`。
- Produces:
  - `type ZonesCapability = 'unknown' | 'zones' | 'unsupported' | 'error'`
  - `useMulticastZonesCapability(ip: Ref<string> | string): { capable: Ref<ZonesCapability>; zones: Ref<MulticastZone[] | null>; reprobe: () => Promise<void> }`

- [ ] **Step 1: 實作 composable**

```ts
import { ref, onMounted, watch, unref, type Ref } from 'vue'
import { probeSipMulticastZones } from '@/composables/deviceApi'
import type { MulticastZone } from '@shared/types'

export type ZonesCapability = 'unknown' | 'zones' | 'unsupported' | 'error'

export function useMulticastZonesCapability(ip: Ref<string> | string) {
  const capable = ref<ZonesCapability>('unknown')
  const zones = ref<MulticastZone[] | null>(null)

  async function reprobe(): Promise<void> {
    const targetIp = unref(ip)
    if (!targetIp) return
    capable.value = 'unknown'
    zones.value = null
    const r = await probeSipMulticastZones(targetIp)
    capable.value = r.status
    zones.value = r.status === 'zones' ? r.zones : null
  }

  onMounted(reprobe)
  // DeviceDetail 未 keyed（App.vue 切設備時複用實例）→ 監看 ip 變化重探，避免能力/zones 過期
  watch(() => unref(ip), () => { void reprobe() })
  return { capable, zones, reprobe }
}
```
> `MulticastZones.vue` 的 `rows` 由 `props.initialZones` 於建立時 `normalizeZones` 一次；因 mzone 分頁只在 `capable==='zones'` 時渲染，設備切換會使分頁短暫消失再依新能力重建，元件隨之重新掛載取到新 `initialZones`，無需額外 watch。

- [ ] **Step 2: 型別檢查**

Run: `npx tsc -p tsconfig.web.json --noEmit`
Expected: 無新錯誤

- [ ] **Step 3: Commit**

```bash
git add src/renderer/composables/useMulticastZonesCapability.ts
git commit -m "feat(cms): useMulticastZonesCapability 四態能力偵測 composable（含 reprobe）

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: MulticastZones.vue 16 區可編輯表元件

**Files:**
- Create: `src/renderer/components/MulticastZones.vue`

**Interfaces:**
- Consumes（Task 1）：`normalizeZones`、`validateZones`、`serializeZones`、`MZ_COUNT`、`MZ_CODEC_PAIRS`、`MulticastZone`；（Task 2）`setSipMulticastZones`。
- Produces: 元件 `<MulticastZones :ip="string" :initial-zones="MulticastZone[] | null" />`。

- [ ] **Step 1: 實作元件**

```vue
<script setup lang="ts">
import { reactive, ref, computed } from 'vue'
import {
  normalizeZones, validateZones, serializeZones, MZ_COUNT, MZ_CODEC_PAIRS,
} from '@shared/multicastZones'
import { setSipMulticastZones } from '@/composables/deviceApi'
import type { MulticastZone } from '@shared/types'

const props = defineProps<{ ip: string; initialZones: MulticastZone[] | null }>()

const rows = reactive<MulticastZone[]>(normalizeZones(props.initialZones))
const saving = ref(false)

// 即時：已啟用區之間 priority 重複者集合（標紅用；不阻擋輸入）
const dupPriorities = computed<Set<number>>(() => {
  const seen = new Map<number, number>()
  const dup = new Set<number>()
  for (const r of rows) {
    if (!r.enabled || !r.priority) continue
    if (seen.has(r.priority)) dup.add(r.priority)
    else seen.set(r.priority, r.zone_id)
  }
  return dup
})

async function save(): Promise<void> {
  const errs = validateZones(rows)
  if (errs.length) { window.alert('❌ ' + errs.map((e) => e.message).join('\n')); return }
  saving.value = true
  const res = await setSipMulticastZones(props.ip, serializeZones(rows))
  saving.value = false
  window.alert(
    res.ok ? '✅ 組播監聽區已儲存（即時生效）'
      : `❌ 儲存失敗${res.errorZoneId ? `（Zone ${res.errorZoneId}）` : ''}：${res.message ?? ''}`
  )
}
</script>

<template>
  <div class="mz-wrap">
    <p class="mz-sub">16 區多監聽區，依優先權即時搶佔、不混音。Zone 1 ＝「SIP / 組播」單槽同一份設定。整表一次儲存、即時生效免重啟。</p>
    <div v-if="dupPriorities.size" class="mz-warn">
      ⚠ 優先權重複：{{ [...dupPriorities].sort((a, b) => a - b).join('、') }}（已啟用區的優先權須全域唯一，儲存前請修正）
    </div>

    <div v-for="row in rows" :key="row.zone_id" class="mz-row">
      <div class="mz-row-head">
        <b>Zone {{ row.zone_id }}</b>
        <span v-if="row.zone_id === 1" class="mz-hint">＝SIP / 組播頁單槽同一份設定</span>
        <label class="mz-en"><input type="checkbox" v-model="row.enabled" /> 啟用</label>
      </div>
      <div class="mz-grid">
        <label>組播位址 (224–239)
          <input v-model="row.multicast_address" placeholder="239.192.1.1" /></label>
        <label>組播埠 (1024–65535)
          <input v-model.number="row.multicast_port" type="number" placeholder="2000" /></label>
        <label>優先權 (1–16，越小越優先)
          <input v-model.number="row.priority" type="number" min="1" :max="MZ_COUNT"
                 :class="{ bad: row.enabled && dupPriorities.has(row.priority) }" /></label>
        <label>音頻編碼
          <select v-model="row.audio_codec">
            <option value="">（請選擇編碼）</option>
            <option v-for="[v, label] in MZ_CODEC_PAIRS" :key="v" :value="v">{{ label }}</option>
          </select></label>
      </div>
    </div>

    <button class="primary-btn" :disabled="saving" @click="save">
      {{ saving ? '儲存中…' : '儲存全部監聽區' }}
    </button>
  </div>
</template>

<style scoped>
.mz-sub { color: #8b9dc3; font-size: 0.8rem; margin: 0 0 12px; }
.mz-warn { color: #ff5252; font-size: 0.8rem; margin-bottom: 10px; }
.mz-row { border-top: 1px solid rgba(78,222,163,0.1); padding-top: 12px; margin-top: 12px; }
.mz-row-head { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
.mz-hint { color: #8b9dc3; font-size: 0.72rem; }
.mz-en { margin-left: auto; color: #e0f2e9; font-size: 0.82rem; }
.mz-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
.mz-grid label { display: flex; flex-direction: column; gap: 4px; font-size: 0.78rem; color: #8b9dc3; }
.mz-grid input, .mz-grid select { padding: 6px 8px; background: rgba(0,0,0,0.2); border: 1px solid rgba(78,222,163,0.15); color: #e0f2e9; border-radius: 4px; }
.mz-grid input.bad { border-color: #ff5252; }
.primary-btn { margin-top: 14px; }
</style>
```

- [ ] **Step 2: 型別檢查**

Run: `npx tsc -p tsconfig.web.json --noEmit`
Expected: 無新錯誤

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/MulticastZones.vue
git commit -m "feat(cms): MulticastZones.vue 16 區可編輯表（即時優先權標紅+整表儲存+E001 alert）

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: DeviceDetail.vue 整合（分頁 gate + 隱藏單槽卡 + error 態）

**Files:**
- Modify: `src/renderer/components/DeviceDetail.vue`（script + template）

**Interfaces:**
- Consumes（Task 3）：`useMulticastZonesCapability`；（Task 4）`MulticastZones.vue`。
- Produces: 整合完成的設備詳情面板（能力四態驅動）。

- [ ] **Step 1: script 加 import 與 composable**（`<script setup>` 內，既有 import 區）

`deviceIp` **已存在**於 `DeviceDetail.vue:215`（`const deviceIp = toRef(() => props.device.ip)`）——直接複用，勿重複宣告。加：
```ts
import MulticastZones from '@/components/MulticastZones.vue'
import { useMulticastZonesCapability } from '@/composables/useMulticastZonesCapability'

const { capable: zonesCapable, zones: zonesData, reprobe: reprobeZones } =
  useMulticastZonesCapability(deviceIp)
```
> 並確認 `computed` 已在既有 `import { ... } from 'vue'` 中（Step 2 需要）；若無則加入。

- [ ] **Step 2: 把 `tabs` 常數改為 computed（zones 分頁能力 gate）**

既有（`DeviceDetail.vue:206-212`）：
```ts
const tabs = [
  { id: 'status', label: '📊 狀態監控' },
  { id: 'audio', label: '🔊 音頻控制' },
  { id: 'sip', label: '📡 SIP / 組播' },
  { id: 'call', label: '📞 通話控制' },
  { id: 'network', label: '🌐 網路設定' },
]
```
改為（原標籤逐字保留，僅在 `capable==='zones'` 時於 SIP 分頁後插入 mzone）：
```ts
const tabs = computed(() => {
  const base = [
    { id: 'status', label: '📊 狀態監控' },
    { id: 'audio', label: '🔊 音頻控制' },
    { id: 'sip', label: '📡 SIP / 組播' },
    { id: 'call', label: '📞 通話控制' },
    { id: 'network', label: '🌐 網路設定' },
  ]
  if (zonesCapable.value === 'zones') {
    base.splice(3, 0, { id: 'mzone', label: '📡 組播監聽區' })
  }
  return base
})
```
> template 的 `v-for="tab in tabs"` 不需改（computed 回陣列可直接迭代）。

- [ ] **Step 3: template 用四態包裹既有單槽組播卡**

既有 SIP 分頁內 `DeviceDetail.vue:111-136` 為（`<hr>` + 單槽組播卡）：
```html
        <hr class="section-divider" />

        <h3>組播接收 (Multicast)</h3>
        <div class="form-grid" @input="dirty.multicast = true" @change="dirty.multicast = true">
          <div class="form-group">
            <label>Multicast Address</label>
            <input v-model="multicastForm.multicast_address" placeholder="239.168.12.1" />
          </div>
          <div class="form-group">
            <label>Port</label>
            <input v-model.number="multicastForm.multicast_port" type="number" placeholder="2000" />
          </div>
          <div class="form-group">
            <label>Codec</label>
            <select v-model="multicastForm.audio_codec">
              <option value="G.722">G.722</option>
              <option value="Opus">Opus</option>
              <option value="G.711 uLaw">G.711 uLaw</option>
              <option value="G.711 aLaw">G.711 aLaw</option>
            </select>
          </div>
          <div class="form-group checkbox">
            <label><input type="checkbox" v-model="multicastForm.enabled" /> 啟用組播</label>
          </div>
        </div>
        <button class="primary-btn" @click="handleSetMulticast">儲存組播設定</button>
```
整段（含 `<hr>`）替換為四態 gate——**只有 `unsupported` 才渲染單槽卡**：
```html
        <hr class="section-divider" />

        <div v-if="zonesCapable === 'unknown'" class="mz-probe">偵測組播能力中…</div>
        <div v-else-if="zonesCapable === 'error'" class="mz-probe">
          組播能力偵測失敗。<button class="link-btn" @click="reprobeZones">重新偵測</button>
        </div>
        <template v-else-if="zonesCapable === 'unsupported'">
          <h3>組播接收 (Multicast)</h3>
          <div class="form-grid" @input="dirty.multicast = true" @change="dirty.multicast = true">
            <div class="form-group">
              <label>Multicast Address</label>
              <input v-model="multicastForm.multicast_address" placeholder="239.168.12.1" />
            </div>
            <div class="form-group">
              <label>Port</label>
              <input v-model.number="multicastForm.multicast_port" type="number" placeholder="2000" />
            </div>
            <div class="form-group">
              <label>Codec</label>
              <select v-model="multicastForm.audio_codec">
                <option value="G.722">G.722</option>
                <option value="Opus">Opus</option>
                <option value="G.711 uLaw">G.711 uLaw</option>
                <option value="G.711 aLaw">G.711 aLaw</option>
              </select>
            </div>
            <div class="form-group checkbox">
              <label><input type="checkbox" v-model="multicastForm.enabled" /> 啟用組播</label>
            </div>
          </div>
          <button class="primary-btn" @click="handleSetMulticast">儲存組播設定</button>
        </template>
        <!-- zonesCapable === 'zones'：不渲染單槽卡（改由『組播監聽區』分頁管理，防斷鏈） -->
```
> 其餘 SIP 設定（primary line、`儲存 SIP 設定` 按鈕等，`:109` 之前）不受影響、維持原樣。

- [ ] **Step 4: template 加 mzone 分頁面板**（與其他 `activeTab === 'xxx'` 面板並列）

面板同時 gate `zonesCapable === 'zones'`，確保 reprobe 期間（capable 轉 `unknown`）MulticastZones 卸載、能力回 `zones` 時以新 `zonesData` 重新掛載（`rows` 於建立時 normalize 一次，故必須重掛載才更新）：
```html
<div v-if="activeTab === 'mzone' && zonesCapable === 'zones'" class="tab-panel">
  <MulticastZones :ip="device.ip" :initial-zones="zonesData" />
</div>
```

- [ ] **Step 4b: 能力離開 `zones` 時重置 activeTab**（script，接 Step 1 的 composable 之後）

避免切到不支援的設備後 `activeTab` 仍停在已消失的 `mzone`：
```ts
import { watch } from 'vue'  // 若尚未 import
watch(zonesCapable, (v) => {
  if (activeTab.value === 'mzone' && v !== 'zones') activeTab.value = 'status'
})
```
> `activeTab` 為既有 `ref('status')`（`DeviceDetail.vue:214`）。

- [ ] **Step 5: 加占位樣式**（`<style scoped>` 末）

```css
.mz-probe { color: #8b9dc3; font-size: 0.85rem; padding: 12px 0; }
.link-btn { background: none; border: none; color: #4edea3; cursor: pointer; text-decoration: underline; padding: 0; }
```

- [ ] **Step 6: 型別檢查 + 建置**

Run: `npx tsc -p tsconfig.web.json --noEmit && npx jest --runInBand`
Expected: tsc 無新錯誤；jest 全綠（含 Task 1 的 multicastZones 測試）

- [ ] **Step 7: 真機驗收（.70，mzweb HTTPS）**

啟動 CMS（`npm run dev` 或既有啟動方式），連 `192.168.0.70`，逐項確認（對照 spec §十）：
1. 出現「📡 組播監聽區」分頁；SIP 分頁的單槽組播卡**消失**。
2. 分頁載入現況 16 區、可編輯；改一區→「儲存全部監聽區」→ `alert` 成功。
3. 兩區設同一 priority 且皆啟用 → 即時標紅 + 卡頭警示；按儲存被前端擋（不送）。
4. 全空停用列可留、儲存不擋；半成品列（填位址未選 codec）被擋並指名 zone。
5. 構造伺服器會拒的整表（如位址 1.2.3.4 啟用）→ `alert` 顯示 E001 指名 zone。
6. 改 Zone 1 後，設備端單槽 `MULTICAST_ADDRESS` 同步（`GET /get/sip/config` 或 device-web 對照）。

- [ ] **Step 8: Commit**

```bash
git add src/renderer/components/DeviceDetail.vue
git commit -m "feat(cms): DeviceDetail 整合 16 區組播分頁（能力 gate+隱藏單槽卡防斷鏈+error 重新偵測）

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## 完成後

- 待辦 2 全部 task 完成後，CMS 這兩件（待辦1 device-web/readtemp 改動 + 待辦2 zones UI）由使用者定：併進 PR #3 或另開 PR。
- 更新 project memory [[multi-zone-selfbuild-poc]] / [[cms-maintenance-values-fix]] 標記 16 區 UI 已落地。

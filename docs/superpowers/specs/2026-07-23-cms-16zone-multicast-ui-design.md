# CMS 16 區組播監聽區 UI — 設計 spec

- 日期：2026-07-23
- 分支：`feat/multi-zone-poc-p4`（PR #3）
- 範圍：`sip-cms`（Electron + Vue 3）renderer 前端；不改設備韌體
- 相關：[[multi-zone-selfbuild-poc]]、device-web `renderMulticastZones`（設備嵌入頁權威實作）、`docs/device-web使用手冊-IO觸點與組播監聽區.md`

## 一、背景與問題

設備（gt-sip-gw / mzweb）已支援 16 區多監聽區（依優先權即時搶佔、不混音），透過 `GET|POST /get|set/sip/multicast/zones` 由 side-car mzrelay3 管理。但 CMS app 只有**單槽組播 UI**（`DeviceDetail.vue` 的「📡 SIP / 組播」分頁一筆 `MulticastConfig` → 舊 `/set/sip/multicast`）。16 區目前只能透過設備嵌入網頁管。

**斷鏈風險**：side-car 設備上 termapp 單槽 MULTICAST 必須固定聽 mzrelay3 輸出 group（`.70` 實測 `239.192.1.1:2000`）。CMS 單槽頁 `handleSetMulticast` 直接寫 termapp 單槽 → 改了就把 termapp 從 mzrelay3 拉走、斷掉多監聽區鏈。故 zones-capable 設備上單槽卡必須隱藏。

## 二、目標

- 對支援 zones 的 gt-sip-gw 設備，CMS 提供完整 16 區可編輯表，行為對齊設備 device-web `renderMulticastZones`。
- 純 runtime 能力偵測：支援 → 顯示 16 區分頁、隱藏單槽卡；不支援（舊韌體） → 隱藏 16 區分頁、保留單槽卡。
- 驗證規則、佔位列語意、優先權唯一性與設備端一致，前端先擋一層、伺服器端 E001 為最終權威。

## 三、非目標（YAGNI）

- 不加 device-kind gate：`DeviceDetail.vue` 已由 `App.vue` 依 `deviceKind==='gt-sip-gw'` 路由（dayu 走 `DayuDetail.vue`），runtime 能力偵測即足。
- 不做「區數可配置」：定死 16（需求單 §一）。
- 不改 dayu-ot300、不改設備韌體、不引入 toast 系統（CMS 現用 `alert()`，沿用）。
- 不做能力背景輪詢（僅掛載探測 + `error` 態手動「重新偵測」）。
- 不在本次拆分 `DeviceDetail.vue` 既有分頁（hermes N3）：已把 16 區邏輯抽為獨立元件+純模組；既有分頁抽元件列為未來工作，不擴大本次範圍。

## 四、元件與檔案結構

| 檔案 | 動作 | 職責 |
|---|---|---|
| `src/shared/multicastZones.ts` | 新 | 純函式 + 常數：`MZ_COUNT=16`、`MZ_CODEC_PAIRS`、`normalizeZones`、`validateZones`、`serializeZones`、`classifyZonesProbe`。無 Vue/DOM 相依，可 jest 單測 |
| `src/shared/types.ts` | 改 | 加 `MulticastZone` 介面、`ZonesProbe` 判別聯集 |
| `src/renderer/composables/deviceApi.ts` | 改 | 加 `probeSipMulticastZones`、`setSipMulticastZones` |
| `src/renderer/composables/useMulticastZonesCapability.ts` | 新 | 掛載時探測 zones 能力，回四態 `capable`（unknown/zones/unsupported/error）+ `reprobe()` |
| `src/renderer/components/MulticastZones.vue` | 新 | 16 區可編輯表；props `{ ip }`；自負載/驗證/儲存 |
| `src/renderer/components/DeviceDetail.vue` | 改 | 加「📡 組播監聽區」分頁（能力 gate）＋隱藏單槽卡＋偵測中占位 |

**設計原則**：驗證邏輯抽進 `src/shared/multicastZones.ts` 純模組（DeviceDetail 已 ~400 行，避免再膨脹；純函式易單測、易在 context 內完整推理）。元件只負責渲染與事件。

## 五、型別與 API 契約

```ts
// src/shared/types.ts
export interface MulticastZone {
  zone_id: number            // 1..16
  multicast_address: string  // 啟用/touched 時須 224.x.x.x – 239.x.x.x（完整 dotted-quad）
  multicast_port: number     // 啟用/touched 時須 1024 – 65535
  priority: number           // 啟用時須 1..16、且啟用區間全域唯一（越小越優先）
  enabled: boolean
  audio_codec: string        // "G.711U" | "G.722"
}
```

```ts
// deviceApi.ts
// 能力偵測＋載入合一：一次探測回三態判別結果（供 composable 與表載入共用）。
export type ZonesProbe =
  | { status: 'zones'; zones: MulticastZone[] }  // 支援：非空 zones 陣列
  | { status: 'unsupported' }                    // 確定的舊韌體：HTTP 404 路由不存在 / 解析成物件但無 zones / 空陣列
  | { status: 'error' }                          // 傳輸失敗/逾時（已重試一次仍失敗）
export async function probeSipMulticastZones(ip: string): Promise<ZonesProbe>

// 整表 16 筆一次送。回 {ok:true} 或 {ok:false, errorZoneId?, message}（解析伺服器 E001 指名的 zone）。
export async function setSipMulticastZones(
  ip: string, zones: MulticastZone[]
): Promise<{ ok: boolean; errorZoneId?: number; message?: string }>
```

- `probeSipMulticastZones`：`GET /get/sip/multicast/zones`，沿用 `deviceApi` 既有 https-first/token/GBK 修復管線。**須區分「舊韌體」與「傳輸失敗」**（斷鏈防護，見 §六 S2）：
  - 成功且回應含**非空** `zones` 陣列 → `{status:'zones', zones}`。
  - 成功但解析成物件卻無 `zones`／空陣列，或 **HTTP 404**（路由不存在＝確定舊韌體）→ `{status:'unsupported'}`。
  - **401/403/5xx（尤其 mzweb 於 mzrelay3 暫時不可用回的 503）／逾時／傳輸失敗 → `{status:'error'}`**（安全占位、不暴露單槽卡；`error` 時**重試一次（~800ms）**後仍失敗才定案）。⚠ 非 404 的 HTTP 錯誤絕不判 'unsupported'，否則 capable 設備瞬時 503 會誤顯危險單槽卡→斷鏈。
  - 判別（success/error 正規化後）交由純函式 `classifyZonesProbe`（§八）決定，供 jest 單測。
- `setSipMulticastZones`：`POST /set/sip/multicast/zones`，body `{ zones }`（整表 16 筆；mzrelay3 亦接受 partial=缺 zone_id 保留現值，但 CMS 恆送全表）。**不走既有 `postRetry`**（其只回 boolean、丟棄 body，無法顯示 E001 指名的 zone），改用專用 axios 呼叫取完整解析 body。伺服器恆 HTTP 200：
  - 成功 `{"status":"success",...}` → `{ok:true}`。
  - 驗證失敗 `{"status":"error","error_code":"E001","message":"zone_id N: <原因>"}`（.70 實測 + mzrelay3.c 源碼確認：zone id 在 **`message`** 欄，非 `details`）→ `{ok:false, message, errorZoneId}`，`errorZoneId` 以 regex `/zone_id\s+(\d+)/` 從 `message` 萃取（萃取失敗則 `errorZoneId` 留空，仍顯示原始 message，容錯）。

## 六、能力偵測與四態呈現

`useMulticastZonesCapability(ip)` 於 `DeviceDetail` 掛載時探測一次（`probeSipMulticastZones`），回 `capable: Ref<'unknown' | 'zones' | 'unsupported' | 'error'>`：

| 狀態 | 觸發 | SIP 頁組播區 | 「組播監聽區」分頁 |
|---|---|---|---|
| `unknown` | 探測進行中 | 顯示「偵測組播能力中…」占位 | 不顯示 |
| `zones` | probe `status:'zones'` | **完全隱藏**單槽卡 | 顯示，載入 16 區表 |
| `unsupported` | probe `status:'unsupported'`（確定舊韌體） | 維持單槽卡 | 不顯示 |
| `error` | probe `status:'error'`（逾時/傳輸失敗） | 顯示「組播能力偵測失敗，[重新偵測]」占位（**不顯示單槽卡**） | 不顯示 |

- **S2 斷鏈防護（本次設計核心修正）**：單槽卡對 side-car 設備是危險入口（改單槽＝把 termapp 從 mzrelay3 拉走、斷多監聽區鏈）。故**只有確定的舊韌體訊號（`unsupported`）才顯示單槽卡**；逾時/傳輸失敗（`error`）**絕不**回退到單槽卡，改顯示「重新偵測」占位。這修正了「保守化＝顯示單槽卡」的錯誤方向——保守應是「不確定就不暴露危險入口」。
- **S3 重新偵測**：`error` 態提供「重新偵測」按鈕（重跑 probe），維運人員無需離開頁面即可重試；設備中途韌體升級（`unsupported`→`zones`）此路徑亦適用。不做背景輪詢（YAGNI）。
- 單槽卡與分頁的可見性皆由同一 `capable` 值驅動，避免不一致。

## 七、16 區表行為（對齊 device-web `renderMulticastZones`）

1. **載入**：`probeSipMulticastZones`（`status:'zones'` 的 `zones`）→ `normalizeZones(raw)` 補滿 16 筆——`zone_id` 缺漏補停用佔位列 `{zone_id:i, multicast_address:"", multicast_port:0, priority:0, enabled:false, audio_codec:""}`，避免半張表無法新增。
2. **每區欄位**：組播位址(224–239)、埠(1024–65535)、優先權(1–16，越小越優先)、音頻編碼(`MZ_CODEC_PAIRS`=`[["G.711U","G.711 µ-law"],["G.722","G.722"]]`)、啟用核取。Zone 1 標註「＝SIP / 組播頁單槽同一份設定」（capable 時單槽卡不渲染，無雙寫）。codec 回空/未知時插入「（請選擇編碼）」哨兵選中，避免 `<select>` 靜默 fallback 覆蓋現場設定。
3. **即時提示**：啟用區之間 `priority` 重複者標紅 + 卡頭警示（不阻擋輸入，儲存時才擋）。
4. **儲存**：`validateZones(rows)` →
   - **佔位列**（全空且停用）：略過驗證。
   - **touched 列**（啟用 或 任一欄曾填值）：完整驗證——位址須合法 dotted-quad（4 段、每段 0–255）且 first octet 224–239（比 device-web 僅檢 first octet 更嚴，因 CMS 為自由文字輸入，先擋省一次伺服器 round-trip）、埠 1024–65535、優先權 1–16 整數、codec 必選。
   - **全域優先權唯一**：僅計已啟用區。
   - 通過 → `serializeZones` 套送出預設值（`multicast_port||0`、`priority||0`、`audio_codec||"G.722"`）→ 整表一次 `setSipMulticastZones`。
5. **回饋**：成功/失敗/E001 用 `alert`（沿用 CMS 模式）；E001 指名 zone_id。任一列不過整批不儲存（伺服器語意）。

## 八、純模組介面（`src/shared/multicastZones.ts`）

```ts
export const MZ_COUNT = 16
export const MZ_CODEC_PAIRS: [string, string][] = [["G.711U","G.711 µ-law"],["G.722","G.722"]]

// 補滿至 16 筆；缺漏 zone_id 補停用佔位列；輸入 null 視為空。
// 先過濾髒資料：raw.filter(z => z && z.zone_id != null)（對齊 device-web；防韌體回 null entry
// 或 zone_id==null 汙染 Map）。佔位列 port/priority 以 number 0 填入（型別維持 number）。
export function normalizeZones(raw: MulticastZone[] | null): MulticastZone[]

// 回全部錯誤（每列至多一則）；空陣列＝通過。實作佔位略過 / touched 完整驗證 / 啟用區優先權全域唯一。
export function validateZones(zones: MulticastZone[]): { zone_id: number; message: string }[]

// 套送出預設值，回可直接 POST 的 16 筆（port||0、priority||0、audio_codec||"G.722"，對齊 device-web）。
export function serializeZones(zones: MulticastZone[]): MulticastZone[]

// 能力偵測判別（純函式，供 probeSipMulticastZones 與 jest 共用）。
// 輸入為正規化後的 probe 結果：ok=true 帶 zones；ok=false 帶 httpStatus（若設備有回應）。
// 規則（安全方向，防斷鏈）：ok+非空 zones→'zones'；ok+空/無 zones→'unsupported'；
//   HTTP 404（路由不存在＝確定舊韌體）→'unsupported'；401/403/5xx/逾時/無回應→'error'。
//   ⚠ 關鍵：非 404 的 HTTP 錯誤（尤其 mzweb 於 mzrelay3 暫時不可用時回的 503）**不得**判 'unsupported'，
//   否則會在 capable 設備上誤顯危險單槽卡→斷鏈。
export function classifyZonesProbe(
  r: { ok?: boolean; zones?: unknown; httpStatus?: number }
): 'zones' | 'unsupported' | 'error'
```

`touched` 定義：`enabled || !!multicast_address || !!multicast_port || !!priority || !!audio_codec`。

## 九、測試策略（TDD）

- **`src/shared/multicastZones.test.ts`**（jest，主要防護）：
  - `normalizeZones`：少於 16 筆補滿、亂序/缺漏 zone_id 正確補位、null → 16 筆佔位、**含 null entry / zone_id==null 的髒陣列被過濾不汙染**。
  - `validateZones`：位址邊界(223/224/239/240)、**非法 dotted-quad（`224.500.1.1`、`224.256`、少段、非數字）被擋**、埠邊界(1023/1024/65535/65536)、優先權邊界(0/1/16/17、非整數)、codec 必選、佔位列略過、touched（停用但有值）仍驗、啟用區優先權重複偵測、多重錯誤聚合。
  - `serializeZones`：預設值套用（空 codec→G.722、空 port/prio→0）。
  - `classifyZonesProbe`：`{ok:true,zones:[...]}→'zones'`、`{ok:true,zones:[]}→'unsupported'`、`{ok:false,httpStatus:404}→'unsupported'`、`{ok:false,httpStatus:500}→'error'`、`{ok:false,httpStatus:401/403}→'error'`、`{ok:false}(無回應)→'error'`。**500→'error' 為斷鏈防護核心斷言（不得回退成 'unsupported'）**。
- deviceApi（`probeSipMulticastZones`/`setSipMulticastZones`）：核心判別/解析已抽為純函式（`classifyZonesProbe`、E001 `message` 的 `errorZoneId` regex）單測；axios 層（重試、body 解析）以既有 deviceApi 測試模式覆蓋或靠真機驗收。
- 元件/composable：純模組已涵蓋核心邏輯；元件層靠手動 + 真機驗收（能力四態、單槽卡隱藏、error 態重新偵測、E001 alert）。

## 十、真機驗收（.70，mzweb HTTPS）

1. 支援設備：出現「組播監聽區」分頁、SIP 頁單槽卡消失；16 區表載入現況、可編輯、儲存整表 success。
2. 優先權重複：即時標紅 + 儲存被前端擋（不送）。
3. 佔位列：全空停用列不擋、可儲存；半成品列被擋並指名 zone。
4. E001：構造伺服器會拒的整表，`alert` 指名 zone_id。
5. Zone 1 與 SIP 單槽一致性：改 zone 1 後，設備端單槽設定同步。
6. 舊韌體（模擬 / 對照 .147）：無此分頁、單槽卡保留、無誤報。
7. `error` 態：模擬探測逾時（如短暫阻斷 .70），SIP 頁顯示「偵測失敗，重新偵測」而**非**單槽卡；點「重新偵測」恢復後正常顯示 16 區分頁。

## 十一、風險與緩解

- **能力誤判斷鏈（hermes S2，已修正）**：原設計把逾時也當「不支援→顯示單槽卡」，會讓瞬時逾時的 capable 設備暴露危險單槽卡、使用者一改就斷 mzrelay3 鏈。**已改為區分**：只有確定舊韌體（`unsupported`）才顯示單槽卡；逾時/傳輸失敗（`error`）顯示「重新偵測」占位、絕不顯示單槽卡。斷鏈風險消除。
- **Zone 1 雙入口（hermes S1）**：capable（`zones`）時單槽卡**完全不渲染**，16 區表 Zone 1 為唯一入口 → 無雙寫、無不一致。
- **佔位列送 codec="G.722"（hermes S4）**：disabled 佔位列序列化後帶 `audio_codec:"G.722"`；此與 device-web 完全相同，且 `.70` P5/P7 真機驗收（含佔位列整表儲存）已通過，mzrelay3 對 disabled 列不誤判——**已實證無害**，非風險。
- **契約漂移**：`probeSipMulticastZones` 回應形狀假設 `{zones:[...]}`、E001 zone id 在 `message` 欄（`.70` 實測 + mzrelay3.c 源碼確認）；非預期形狀一律當 `unsupported`（不冒險解讀）；`errorZoneId` regex 萃取失敗仍顯示原始 message（容錯）。
- **能力偵測無單測（hermes S5，已修正）**：判別邏輯抽為純函式 `classifyZonesProbe`，jest 覆蓋 zones/unsupported/error 三態。

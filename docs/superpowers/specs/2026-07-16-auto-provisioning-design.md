# 自動供裝（Auto-Provisioning）設計文件

> 日期：2026-07-16
> 狀態：已與使用者逐節確認之設計，待實作
> 前置閱讀：`docs/DBP協定-發現與修改IP.md`、`docs/GT-SIP-REST_API.md`

## 1. 目標與範圍

使用者填入一組供裝範本 —— **IP 分配範圍（含 mask/gateway）、SIP 分機範圍、SIP 密碼（共用一組）、SIP Server（位址＋Port）、名稱前綴** —— 按「啟動」後，系統每 5 秒週期掃描，發現新設備即**全自動**依發現順序完成供裝：

1. 依序分配一個未用 IP 與未用分機號
2. DBP SET 改 IP（同封包順帶把設備名稱設為 `前綴+分機號`；設備會重開機）
3. 等設備以新 IP 上線
4. REST 下發 SIP 設定（分機、密碼、Server 同一個 `setSipPrimary` payload）

**成功定義**：`setSipPrimary` 回報 `success` 即完成（不等 SIP 註冊驗證）。

**不在範圍**：SIP 註冊狀態驗證、備援 SIP Server（backup）設定、設備 Web 管理密碼變更、半自動確認模式。

## 2. 使用者已確認的關鍵決策

| 決策點 | 選擇 |
|---|---|
| IP 範圍用途 | 分配用（完整兩階段：DBP 改 IP → REST 設 SIP） |
| 新設備認定 | 持久化登記表＋設備現況雙重檢查 |
| 指派策略 | 發現順序依序取號（第 N 台新設備拿第 N 個未用 IP＋分機） |
| 自動程度 | 全自動（啟動期間掃到即供裝，無逐台人工確認） |
| 成功定義 | 設定指令回報成功即可；順帶把設備名稱設成分機號 |

## 3. 架構總覽

**供裝引擎放 renderer**（方案 A）。理由：整套 REST 客戶端（token 管理、GBK 解碼、髒 JSON 修補、https-first fallback、401 自動重登）都活在 `src/renderer/composables/deviceApi.ts`，搬進 main 重寫的工程量與回歸風險，換不到單視窗桌面工具實際需要的好處。

main process 不新增任何網路邏輯，只新增登記表檔案 IO 的 IPC。

```
renderer                                    main
┌─────────────────────────────┐   IPC   ┌──────────────────────┐
│ useAutoProvisioning (引擎)   │ ───────▶│ dbpDiscover (既有)    │
│  掃描循環 / 狀態機 / 取號器    │ ───────▶│ changeDeviceIp (既有, │
│                             │         │   擴充 newName)       │
│ deviceApi (既有, 直連設備)    │ ───────▶│ provisionRegistry(新) │
│ stores/provisioning (新)     │         │   userData JSON 讀寫  │
│ AutoProvisionView (新)       │         └──────────────────────┘
└─────────────────────────────┘
```

## 4. 元件切分

**新增：**

| 檔案 | 職責 |
|---|---|
| `src/renderer/composables/useAutoProvisioning.ts` | 供裝引擎：掃描循環、per-device 狀態機、號碼池分配 |
| `src/renderer/stores/provisioning.ts` | Pinia store：供裝設定、任務清單、活動日誌（UI 唯一資料來源） |
| `src/renderer/components/AutoProvisionView.vue` | 供裝頁：設定表單＋啟動/停止＋任務表＋活動日誌 |
| `src/main/provisionRegistry.ts` | 登記表持久化：讀寫 `app.getPath('userData')/provision-registry.json`，原子寫入（寫 temp 檔再 rename） |

**修改：**

- `src/shared/types.ts`：新增 `ProvisionConfig`、`ProvisionRecord`、`ProvisionTaskState` 等型別
- `src/shared/constants.ts`：`IPC_CHANNELS` 加 `REGISTRY_READ` / `REGISTRY_WRITE`
- `src/main/index.ts`＋`src/preload/index.ts`：登記表 IPC（照既有四步慣例：常數 → handler → preload 包裝 → renderer 呼叫）
- `src/main/ipChanger.ts`：`IpChangeRequest` 擴充可選 `newName` 欄位，帶入 DBP SET 封包的 `Name:` 欄位（`ipChanger.ts:77` 既有欄位）
- `AppLayout.vue`：navItems 加「自動供裝」；`App.vue` 加對應 view 切換

## 5. 資料結構

```ts
// 使用者填的供裝範本（存進 registry 檔，重開 App 可還原）
interface ProvisionConfig {
  ipStart: string
  ipEnd: string          // 分配池（含端點）
  mask: string
  gateway: string        // 分配 IP 時一併下發
  extStart: number
  extEnd: number         // 分機池（含端點）
  sipPassword: string    // 所有設備共用
  sipServer: string
  sipPort: number        // 預設 5060
  namePrefix: string     // 名稱 = prefix + 分機號；預設空字串
}

// 登記表一筆記錄（MAC 為主鍵）
interface ProvisionRecord {
  mac: string
  assignedIp: string
  assignedExt: number
  status: 'pending' | 'provisioned' | 'failed'   // pending = 已取號佔位、供裝進行中
  updatedAt: string      // ISO 8601
  lastError?: string
}

// registry 檔內容
interface ProvisionRegistryFile {
  config: ProvisionConfig | null
  records: ProvisionRecord[]
}
```

執行期任務狀態（只在 Pinia store，不落地）：

```
discovered → ip_assigning → waiting_online → sip_configuring → done | failed
```

## 6. 供裝引擎流程

### 6.1 掃描循環

用**遞迴 setTimeout**（非 setInterval），避免掃描重疊：

```
啟動 → 載入登記表 → 可達性檢查（見 6.5）
loop:
  dbpDiscover(4s) → 對每台回報設備做判定（6.2）→ 派工（6.3）
  → 等到距本輪開始滿 5 秒（不足則立即）→ 下一輪
```

`dbpDiscover` 本身約 4 秒收斂，所以「每 5 秒」的語意是**週期下限 5 秒**：上一輪（掃描＋處理）結束後，距本輪開始不足 5 秒則補足間隔再啟動下一輪。

### 6.2 每台設備的判定（雙重檢查）

依序：

1. **MAC 有進行中任務** → 交給該任務狀態機處理（如 `waiting_online` 的認回，見 6.3 步驟 2）
2. **MAC 在登記表、status=provisioned、且現況 `regUser` == 分配的分機** → 已供裝，跳過
3. **MAC 在登記表但現況不符**（`regUser` 空白或不等於分配值，即被恢復出廠或外部改動）→ **沿用原分配的 IP＋分機**重跑供裝流程，不重新取號
4. **MAC 不在登記表** → 新設備：取號器分配下一個未用 IP＋分機，**立即寫登記表佔位**（status = `pending`，完成後改 `provisioned`、失敗改 `failed`），進供裝流程

### 6.3 單台供裝（狀態機）

任務掛進 `usePromiseQueue`（併發上限沿用 `MAX_CONCURRENT_SYNC` = 5）。**取號器本身在掃描循環的單一執行緒內同步執行**，兩台設備不會搶到同一號。

1. `ip_assigning`：`changeDeviceIp({device, newIp, newMask, newGateway, newName: prefix+ext})` — DBP SET，設備收到後重開機
2. `waiting_online`：等後續掃描輪認回 —— MAC 相符**且 IP == 分配值**才算上線；逾時 **120 秒** → `failed`（原因「改 IP 後未上線」）
3. `sip_configuring`：`getSipConfig(ip)` 讀現值 → 只覆蓋 `user_id / password / server_address / server_port` 四欄（read-modify-write，不動 transport、auto_answer 等其他欄位）→ `setSipPrimary(ip, merged)`。401 由 `deviceApi` 既有攔截器自動用預設帳密登入重試，新設備免手動 login
4. 回報 `success` → 登記表標 `provisioned`，任務標 `done`

**特例（重供裝且 IP 已正確）**：設備現有 IP 恰好 == 分配 IP 時，跳過步驟 1-2 直接設 SIP。此時名稱不更新（DBP SET 會觸發整機重開機，只為改名不值得），接受名稱維持原狀。

### 6.4 號碼池取號器

- IP 池與分機池各自獨立依序取用：從範圍起點往後找第一個「登記表未佔用**且**不在本輪掃描既有設備 IP 清單」的號碼
- 已分配的號碼永久佔用（記在登記表），即使該任務 failed 也保留（重試沿用）
- 任一池用盡 → 引擎**自動暫停**：停止對新設備派工，進行中任務照跑，UI 紅色警示

### 6.5 跨網段可達性

啟動時計算分配池所屬網段：

- 若不在本機任一網卡網段 → 呼叫既有 `ensureReachableForIps`（次要 IP 別名）確保 REST 打得到（對應 HK-WSDK 韌體 REST-static、無 DHCP 的限制）
- 停止供裝時清除別名（既有 `cleanupAllAliases`）

## 7. UI（AutoProvisionView）

- **設定表單**（上方）：IP 起訖、mask、gateway、分機起訖、SIP 密碼、Server 位址/Port、名稱前綴。啟動後鎖定表單。
- **啟動/停止**按鈕＋運行狀態列：已掃描輪數、池使用量（如「分機 12/50 已用」）。
- **任務表**：每列 = MAC、狀態（`waiting_online` 顯示倒數）、分配 IP/分機、錯誤原因；失敗列提供「重試」鈕（沿用原分配重跑）。
- **活動日誌**：時間戳＋事件流水（發現新設備、DBP SET 送出、上線認回、SIP 完成、失敗原因…），上限 500 條滾動。
- **表單驗證**：起 > 訖、IP/數字格式錯誤要擋；IP 池含本機網卡 IP 要警告；IP 池大小與分機池大小**不強制相等**（各自取用、任一用盡即暫停）。

導覽整合照既有慣例：`AppLayout.vue` navItems 加一筆，`App.vue` 以 `currentView` 切換（本功能為獨立頁面，非 modal）。

## 8. 錯誤處理與邊界

| 情境 | 行為 |
|---|---|
| IP 或分機池用盡 | 引擎自動暫停新派工，進行中照跑，UI 紅色警示 |
| DBP SET 後 120 秒未上線 | `failed`＋原因；登記表保留分配；手動重試沿用原號 |
| `setSipPrimary` 回 `error` | 沿用 `postRetry` 語意重試，仍失敗 → `failed`＋原因 |
| 分配的 IP 已被其他設備佔用 | 取號時跳過（比對登記表＋本輪掃描結果），記日誌 |
| 使用者按「停止」 | 停掃描循環；進行中任務跑完當前步驟後中止，狀態留在任務表 |
| App 中途被關 | 取號當下已落地佔位：重開後已完成的不重做；卡半途的由 6.2 規則 3 自動判定重跑 |
| registry 檔損壞 | JSON 解析失敗 → 視為空表、原壞檔改名備份（`.corrupt-<timestamp>`），日誌警示 |
| 混網段 | 見 6.5 |

## 9. 測試策略

- **單元測試（jest）**：
  - 取號器：依序取號、跳過已佔用、跳過掃描現存 IP、池用盡
  - 判定邏輯：6.2 四分支各一案例（含恢復出廠重供裝）
  - registry：原子寫入、壞檔容錯與備份
- **狀態機測試**：注入 mock（`dbpDiscover` / `changeDeviceIp` / `deviceApi` 抽成可注入介面），模擬掃描輪序列（發現 → 消失 → 以新 IP 出現 → SIP 成功/失敗），驗證狀態轉移、120 秒逾時、停止行為
- **真機 E2E**（實作完成後）：.147 測試環境走恢復出廠 → 自動供裝全流程（遵守既有 E2E 環境注意事項：勿動 .146、單 session）

## 10. 實作前置檢查

- 改動 `ipChanger.ts`、`deviceApi.ts` 相關符號前，先 `bash scripts/gitnexus-fresh.sh` 並跑 `impact` 分析（專案規範）
- 提交前 `detect_changes()` 核對影響範圍

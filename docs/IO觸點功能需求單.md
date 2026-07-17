# IO 觸點功能需求單（GT-SIP-GW / 板 v6.1.3 · GK7205V300）

> 提交對象：設備/韌體原廠
> 背景：板卡背面已引出 5 路乾接點 IO（絲印 `0-4 / 1-4 / 1-5 / 1-6 / 5-5` + `GND`），現況韌體未賦予功能。本版次要求原廠實作**可配置的 IO 觸點功能**，讓現場可用實體按鈕/接點觸發組播、撥號、掛斷等動作。
> 依據：板卡實物照片（背面絲印）＋ SoC 假設為 **GOKE GK7205V300**（Cortex-A7，PL061 GPIO，Linux 4.9 系 osdrv）。**若實際 SoC 型號或 GPIO 對映與本單不符，請於回覆時更正**，本單的 Linux 編號/暫存器欄以貴廠 datasheet 為準。
> 提出日期：2026-07-17
> 優先序：🔴 P0 本版次核心　🟠 P1 應做　🟡 P2 後續可排

---

## 一、總述

**目標**：把板上 5 路乾接點 IO 做成一張**可配置的「功能綁定表」**（存 flash、可由設備 Web/REST 讀寫），而非把功能寫死在韌體。每一路 IO 有 4 個獨立可配置屬性：方向（`mode`）、電氣觸點型態（`contact`：常開 NO／常閉 NC）、觸發語意（`trigger`）、綁定動作（`action`）。這樣現場需求變更時，改設定即可，**無須重新燒錄韌體**。

**設計原則**：完整鏡像既有「組播接收／發送」的設定模式——config 存 `/etc/ifcfg-sip`（或獨立 config 分區）、REST API 形狀對稱、`sip.sdk` 無參數重讀通知、開機自動恢復。把原廠改動與風險降到最低。

**責任切分（沿用現行三層）**：

```
瀏覽器 device-web「IO 觸點配置」卡片 ──（我方已完成，隨交付包提供）
   │ GET /get/io/config、POST /set/io/config（Bearer token）
   ▼
websetsip.c（控制面）──（原廠：新增 2 條路由，照既有 request_* 模板）
   │ 讀寫 io_config（JSON）
   │ Unix socket /tmp/sip.sdk：{"command":"set_io_config","cseq":n}\r\n\r\n
   ▼
/opt/termapp（執行面）──（原廠：主要工作量）
   io-manager 執行緒：kernel input 事件 → action dispatcher
     → 組播發送模組 / SIP UA 模組 / GPIO 輸出
```

---

## 二、硬體前提（GK7205V300 · 請原廠核對回填）

### 2.1 GPIO 對映

GK7205V300 為 PL061 相容控制器，每 bank 8 腳，Linux 全域編號 = `bank×8 + pin`：

| 板上絲印 | GPIO | Linux 編號（推定） | sysfs 路徑（推定） |
|---|---|---|---|
| `0-4` | GPIO0_4 | 4 | `/sys/class/gpio/gpio4` |
| `1-4` | GPIO1_4 | 12 | `/sys/class/gpio/gpio12` |
| `1-5` | GPIO1_5 | 13 | `/sys/class/gpio/gpio13` |
| `1-6` | GPIO1_6 | 14 | `/sys/class/gpio/gpio14` |
| `5-5` | GPIO5_5 | 45 | `/sys/class/gpio/gpio45` |

> ⚠ **請原廠回填確認**：上表 Linux 編號為依家族慣例推定。以貴廠 BSP/datasheet 實際值為準，若不同請於回覆更正。

### 2.2 需原廠回填的表（pinmux / 電氣）

| GPIO | pinmux(muxctrl) 暫存器值 | 預設複用功能 | 是否 boot-strap 腳 | 可否配置為輸出 | 內部上/下拉 |
|---|---|---|---|---|---|
| GPIO0_4 | ☐ | ☐ | ☐ | ☐ | ☐ |
| GPIO1_4 | ☐ | ☐ | ☐ | ☐ | ☐ |
| GPIO1_5 | ☐ | ☐ | ☐ | ☐ | ☐ |
| GPIO1_6 | ☐ | ☐ | ☐ | ☐ | ☐ |
| GPIO5_5 | ☐ | ☐ | ☐ | ☐ | ☐ |

> **重點提醒**：GPIO1_4~1_6 在此家族常與 UART/SPI/SENSOR 介面複用；GPIO0/GPIO5 部分腳可能與 boot/JTAG 相關。**若任一腳為 boot-strap 腳，開機瞬間外部接點電平可能改變啟動模式**——此類腳只能配置為輸出或需外部隔離，請務必在上表明確標示。

### 2.3 電氣前提（設計依據，供評估）

- 5 路皆為 SoC 直出 3.3V CMOS、共用一個 `GND`，電氣型態為**乾接點對地**（接點閉合＝拉低）。
- 輸入建議：內部或外部上拉 + 每腳串 470Ω~1kΩ 限流 + TVS（現場拉線易帶靜電/浪湧）。
- 輸出限制：**SoC GPIO 僅提供邏輯電平，不能直接驅動繼電器/功放**。若 GPIO5_5 要做輸出驅動外部負載，板上必須加開漏三極管/MOS 驅動級——請原廠評估現況板是否已具備，若無請於回覆說明。

---

## 三、功能綁定表（config schema）

### 3.1 每一路 IO 的可配置屬性

| 屬性 | 型別／選項 | 說明 |
|---|---|---|
| `id` | 1–5 | 邏輯埠編號（對應 §2.1 五腳，固定） |
| `gpio` | 字串 | 唯讀，回報用（如 `GPIO0_4`） |
| `mode` | `input` / `output` / `disabled` | 方向。**停用某一路 IO ＝設 `mode:disabled`**（此時 `action` 忽略）；`disabled` 只屬 mode，不是 action.type |
| `contact` | `NO` / `NC` | 常開／常閉。**這只是電氣極性反轉，不是獨立功能**：接常開按鈕配 `NO`，接消防/防拆常閉迴路配 `NC` |
| `trigger` | `edge` / `level` / `long_press` | `edge`＝按一下觸發一次；`level`＝閉合期間持續（如 PTT 按住）；`long_press`＝長按達閾值才觸發。**`output` 模式忽略 trigger** |
| `debounce_ms` | 整數 | 軟體去抖窗（建議預設 30，可配置 0–200） |
| `action` | 物件 `{type, param}` | 綁定動作，`type` 為 §3.2 的 **11 種**之一（不含 disabled）；`mode:disabled` 時整個 action 忽略 |
| `state` | 0/1 | **唯讀即時狀態**，回報用，不可寫入 |

### 3.2 動作清單（action.type，請原廠實作為原語）

**輸入動作**：

| action.type | trigger 建議 | param 意義 | 行為 |
|---|---|---|---|
| `multicast_ptt` | level | 尾音 tail_ms（如 `300`） | 閉合→開始組播發送（Mic→編碼→RTP，沿用 MTX）；斷開→啟動 tail timer（預設 300ms 可配置）→停止。**尾音延遲必做**，否則鬆開瞬間末字被切 |
| `call_toggle` | edge | 目標號碼 | 空閒按下＝撥出該號碼；通話中按下＝掛斷。一顆按鈕當話機用 |
| `call_preset` | edge | 目標號碼 | 撥打預存號碼。**未註冊/忙線時須有明確回饋**（提示音或 LED），不可靜默 |
| `hangup` | edge | — | 掛斷當前通話；空閒時為無害 no-op |
| `answer` | edge | — | 接聽來電 |
| `sos` | edge | 目標號碼 | 組合動作：撥 param 指定號碼＋同時啟動組播發送。**組播位址沿用既有 MTX（組播發送）設定的位址/埠/編碼**（同 `multicast_ptt`），param 只承載電話號碼，不另帶組播位址 |
| `volume_up` / `volume_down` | edge | — | 現場調整播放音量 |

**輸出動作**（僅限硬體允許輸出的腳，見 §2.3）：

| action.type | 行為 |
|---|---|
| `call_status` | 通話中拉高（驅動外部指示燈/錄音觸發） |
| `multicast_status` | 收到組播/正在發送時拉高（聯動功放致能/警示燈） |
| `remote_control` | 由 CMS 經 REST 遠端控制的通用輸出（開門、觸發警笛等） |

> 停用某一路 IO 請設 `mode:disabled`（見 §3.1），**不是**設 action.type——action.type 僅上列 11 種。

### 3.3 config JSON 範例（存 flash，Web/REST 讀寫、DBP 可讀）

```json
{ "io_config": [
  {"id":1,"gpio":"GPIO0_4","mode":"input","contact":"NO","trigger":"level","debounce_ms":30,"action":{"type":"multicast_ptt","param":"300"},"state":0},
  {"id":2,"gpio":"GPIO1_4","mode":"input","contact":"NO","trigger":"edge","debounce_ms":30,"action":{"type":"call_toggle","param":"<號碼>"},"state":0},
  {"id":3,"gpio":"GPIO1_5","mode":"input","contact":"NO","trigger":"edge","debounce_ms":30,"action":{"type":"call_preset","param":"<號碼>"},"state":0},
  {"id":4,"gpio":"GPIO1_6","mode":"input","contact":"NC","trigger":"edge","debounce_ms":30,"action":{"type":"sos","param":"<號碼>"},"state":0},
  {"id":5,"gpio":"GPIO5_5","mode":"output","contact":"NO","trigger":"edge","debounce_ms":0,"action":{"type":"call_status","param":""},"state":0}
]}
```

---

## 四、出廠預設 profile（全部可改，出廠給一個可直接用的組合）

| IO | 預設 mode | 預設 contact/trigger | 預設 action | 場景 |
|---|---|---|---|---|
| GPIO0_4 | input | NO / level | `multicast_ptt`（tail 300ms） | 對講/廣播 PTT（按住發送、鬆開停止） |
| GPIO1_4 | input | NO / edge | `call_toggle` | 一鍵通話（按一下撥出、通話中按掛斷） |
| GPIO1_5 | input | NO / edge | `call_preset` | 撥打第二預存號碼 |
| GPIO1_6 | input | NC / edge | `sos` | 接常閉迴路（消防/防拆），斷線即觸發求助 |
| GPIO5_5 | output | NO / edge（output 忽略 trigger） | `call_status` | 通話指示燈/錄音聯動 |

> 號碼類 param 出廠留空或填占位，由現場經 Web 設定。

---

## 五、REST API（原廠新增 2 條，照既有 request_* 模板）

沿用既有 `:80`/HTTPS 管理服務與 Bearer token 鑑權（比照 SEC-01 要求：GET 亦須驗 token）。

### 5.1 `GET /get/io/config`
回應：§3.3 的 `io_config` 陣列（含唯讀 `state` 即時值）。回應須為**合法 JSON**（用 cJSON 建構、欄位值 escape，比照 SEC-09）。

### 5.2 `POST /set/io/config`
Payload：`{ "io_config":[ {id,mode,contact,trigger,debounce_ms,action:{type,param}} ... ] }`（不含 state）。
寫入 config 後透過 `/tmp/sip.sdk` 送 `{"command":"set_io_config","cseq":n}` 通知 termapp 無重啟重載。成功回既有成功碼、失敗回既有錯誤碼。

> device-web 端「IO 觸點配置」卡片**已由我方完成並隨交付包提供**，直接對接上述兩支端點；韌體未支援時卡片可容錯顯示，原廠實作後即自動生效。

---

## 六、韌體實作要求（termapp / kernel）

| 編號 | 要求 |
|---|---|
| **IO-01** | 輸入腳用 kernel **`gpio-keys`** driver（DTS 配置腳位/極性/去抖），產生 `/dev/input/eventX` 事件，**中斷驅動、禁止 app 層輪詢 sysfs**。`NO/NC` 即 DTS/config 的 active-low 位元翻轉。 |
| **IO-02** | **開機安全**：輸出腳（GPIO5_5）於 DTS/u-boot 階段即預設為 `output-low` 或高阻，杜絕上電到 app 就緒前的毛刺誤觸發外部設備。所有輸入在 app 就緒前不得誤發動作。 |
| **IO-03** | `multicast_ptt` 語意在 app 層實作：`press→開始組播發送`、`release→啟動 tail timer（預設 300ms 可配置）→停止`。與 SIP 通話的**優先序**：SIP 通話 ＞ 組播發送 ＞ 組播接收，且可配置。PTT 按住時來電，依優先序處理。 |
| **IO-04** | **效能護欄**：action dispatcher 全部非同步（發訊息給 SIP/組播模組），**禁止在 input 事件回呼裡做網路 I/O**（否則 REGISTER 逾時會卡死按鍵事件）。GK7205V300 為單核 900MHz，此點對音訊即時性關鍵。 |
| **IO-05** | `io_config` 存獨立 config（`/etc/ifcfg-sip` 新增 key 或獨立分區），開機自動恢復；改綁定**免重啟生效**。 |
| **IO-06** | IO 的配置與即時 `state` 須進 DBP 能力清單與 REST 回報（見 §七一致性要求）；輸入觸發事件建議主動上報 CMS（便於日誌/聯動）。 |

---

## 七、與現有介面的一致性（重要）

IO 配置/狀態經三條路徑對外（DBP 能力清單、REST、Web）時，必須來自**同一份執行期資料源**，任一路徑修改後其他路徑 ≤2 秒內一致、不得要求重啟。此要求與另附《SIP 資訊一致性需求單》同源，請一併落實。

---

## 八、端對端驗收清單（總表）

| # | 測項 | 通過標準 | ☐ |
|---|---|---|---|
| 1 | PTT（GPIO0_4）按住/鬆開 ×100 | 組播發送起停 100% 對應、無黏滯 | ☐ |
| 2 | PTT 鬆開尾音 | 最後 300ms 語音不被截斷（可配置生效） | ☐ |
| 3 | `call_toggle`（GPIO1_4）空閒/通話中按 | 空閒撥出、通話中掛斷 | ☐ |
| 4 | `call_preset` 未註冊時按下 | 有明確提示音/LED 回饋，非靜默 | ☐ |
| 5 | NC 模式（GPIO1_6）剪線/斷迴路 | 迴路斷開 ≤100ms 內觸發綁定動作 | ☐ |
| 6 | 抖動接點（繼電器顫振） | 去抖後不產生多重觸發 | ☐ |
| 7 | 開機全程示波器量 GPIO5_5 | 上電→app 就緒**無任何毛刺脈衝** | ☐ |
| 8 | PTT 按住時來電 | 依優先序矩陣行為、可配置 | ☐ |
| 9 | Web 改 IO 綁定後 | 免重啟生效，GET/DBP 回報一致 | ☐ |
| 10 | `state` 即時性 | 接點變化 ≤1 秒反映於 GET/DBP `state` | ☐ |

---

## 九、交付物

- 本需求單。
- device-web「IO 觸點配置」卡片（已含於交付包 `index.html`）。
- **請原廠回覆**：§2.1 Linux 編號確認、§2.2 pinmux/strap 表回填、§2.3 GPIO5_5 是否具輸出驅動級。這三項是動土前提。

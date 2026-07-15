# 設備 Web 管理介面安全強化需求單（GT-SIP-GW / 板 v6.1.2）

> 提交對象：設備/韌體原廠
> 背景：本次原廠協助把「設備內建管理網頁」整合進韌體（`GET /` 提供網頁，見另附 `firmware-integration/`）。趁此版次，一併修補 REST `:80` 管理服務的安全缺口。
> 依據：原廠提供之 `websetsip.c / .h`（REST `:80` 設定服務源碼）逐函式核對所得。
> 提出日期：2026-06-24
> 優先序：🔴 P0 上線前必須修　🟠 P1 本版次應修　🟡 P2 後續可排

---

## 一、總述

目前 `:80` 管理服務的鑑權與傳輸防護不足：**6 個 GET 端點完全不驗 token**，其中 `/get/sip/config` 會**無認證回傳 SIP 明文密碼**；帳密與 SIP 密碼**明文落檔**；**無 HTTPS**（全程明文）。前端網頁已盡力補上 UX 層防護（強制改預設密碼、閒置登出、登入鎖定 UI、密碼遮罩），但上述屬**韌體層**問題，前端無法替代，需原廠於本版次修補。

> **真機實證（2026-06-25 於可測設備）**：未登入直接 `GET /get/sip/config` → 回 `HTTP 200` + **明文 SIP 密碼**＋帳號＋伺服器位址（SEC-01／SEC-02 成立）；`/get/device/status` 等 GET 端點亦全部免 token；`/get/device/status` 之 `device_info.model` 仍回舊白牌代碼（BRAND-02 成立）；`change_password` 接受弱密碼 `123456`（SEC-06 之複雜度未檢查成立）。

---

## 二、需求明細

### 🔴 P0 — 上線前必須修

| 編號 | 現況（依源碼） | 風險 | 要求 | 驗收 |
|---|---|---|---|---|
| **SEC-01** | `http_callback()` 對 6 個 GET 端點**未做 token 驗證**：`/get/device/status`(#5)、`/get/device/volume`(#7)、`/get/sip/config`(#8)、`/get/call/status`(#14)、`/get/network/config`(#15)、`/system/info`(#18) | 任何人不需登入即可讀取設備狀態、網路、系統資訊 | 所有 GET 端點比照 POST 端點，於 handler 開頭加 `Authorization: Bearer` token 驗證（沿用既有驗證邏輯），失敗回 `A003` | 未帶／帶錯 token 呼叫任一 GET 端點 → 回 `A003`，不回資料 |
| **SEC-02** | `request_get_sip_config()` 直接把 `PRIMARY_PASSWORD / BACKUP_PASSWORD` **明文**輸出於回應 JSON | SIP 帳號密碼經明文 HTTP 外洩，可被竊聽或未授權讀取 | `/get/sip/config` 回應中密碼欄一律遮蔽為 `"********"`；若管理頁需顯示，另開一支**需 token** 的顯示密碼端點 | 呼叫 `/get/sip/config` 回應的 `password` 欄為 `********`，不含真實密碼 |
| **SEC-03** | `init_web_listen(web_port=80,…)` 僅 HTTP；`Connection: close`、`charset=GBK`，全程明文 | 帳密、token、SIP 密碼皆可被同網段竊聽（中間人） | 提供 **HTTPS（TLS）** 管理通道（自簽憑證即可）；若硬體不足以負擔 TLS，至少提供「限制 `:80` 僅綁管理網段／管理 VLAN」之設定 | 可用 `https://<IP>/` 登入並操作；或提供綁定介面/網段之設定並驗證生效 |

> **同級競品 benchmark（補強 SEC-03 論據）**：同等級之 SIP 網路設備（如 Grandstream 系列）出貨即標配「`:80` 一律 `301` 轉址至 `https://`、強制 TLS（自簽憑證）」與安全回應標頭（`X-Frame-Options: SAMEORIGIN`、`X-Content-Type-Options: nosniff`、`X-XSS-Protection`）。可見「資源受限的 SIP 設備無法負擔 HTTPS」之說並不成立——強制 HTTPS 已是同級產品基本盤。本次整合的 `GET /` 網頁 handler（`serve_index.c`）已先補上述三個安全標頭；建議 REST `:80` 各端點回應亦比照加上，並依 SEC-03 提供 HTTPS。

### 🔴 P0 — 韌體 JSON 格式錯誤（FW，2026-06-25 於 .203 真機端對端測試發現）

> `request_get_device_status()`（`/get/device/status`）的回應**格式字串本身有兩處字面錯誤**，使回應成為**無效 JSON**，前端 `JSON.parse` 失敗 → **整個儀表板無法顯示（連線異常、各卡載入中）**。此與 SEC-09（欄位值未 escape）不同類：這是 `snprintf` 格式字串的**字面打錯**，與設定值內容無關、必現。前端已加**暫時防呆**（`index.html` 的 `cleanDirtyJSON` 針對此兩處還原），但**根因須原廠修源碼**；原廠修好出貨後，前端防呆對已修韌體不會誤動、可移除。

| 編號 | 現況（依源碼 `websetsip.c` / `request_get_device_status`） | 風險 | 要求 | 驗收 |
|---|---|---|---|---|
| **FW-01** | 第 572 行格式字串為 `"\"broadcast_volume"": %s, "`（C 相鄰字串串接後實際輸出 `"broadcast_volume: 78`）——key 少了收尾引號與冒號 | `/get/device/status` 回**無效 JSON**，前端解析失敗、儀表板全倒 | 改為 `"\"broadcast_volume\": %s, "`（輸出 `"broadcast_volume": 78`） | `/get/device/status` 回應可被標準 JSON parser 解析，`sip_status.device_info.broadcast_volume` 為數字 |
| **FW-02** | 同函式格式字串結尾為 `"\"dns\": \"%s\"}}"`，只有 **2** 個收尾 `}`；但該 JSON 有 root／`sip_status`／`network_info` 三層需閉合 | 回應**缺 root 物件收尾 `}`**（大括號不平衡），為無效 JSON | 結尾改為 **3** 個 `}`：`"\"dns\": \"%s\"}}}"` | `/get/device/status` 回應大括號平衡、可被標準 JSON parser 解析 |

> 實測樣本（真機 .147）：`{"sip_status": {... "device_info": {... "broadcast_volume: 44, "microphone_volume": 20}, "network_info": {... "dns": "8.8.8.8"}}`（注意 `broadcast_volume` 缺 `":`，且 `device_info`／`network_info` 被**錯巢狀**在 `sip_status` 內、未閉合 `sip_status`）。
>
> **真機補充（2026-06-25 .147 實測）**：FW-02 的後果不只是「大括號不平衡」，而是 `device_info` 與 `network_info` 因 `sip_status` 未在 `multicast_status` 之後收尾而被**巢狀進 `sip_status`**。前端 `paintDashboard` 讀的是 root 層的 `st.device_info` / `st.network_info` → 兩者為 `undefined` → **儀表板「設備資訊」「網路」卡與運行時間/音量 stat 全空白「—」**（連線正常時亦然，已隔離證實非連線問題）。故 FW-02 正確修法是**在 `multicast_status` 之後補 `}` 關閉 `sip_status`**，使 `device_info`／`network_info` 成為 root 同層欄位（單純在結尾補第 3 個 `}` 只會讓 JSON 可解析、但仍巢狀錯位）。前端已加**永久防呆**（`index.html` 解析後若 root 缺、`sip_status` 內有則 hoist 回 root；對已修韌體不誤動），真機驗證儀表板已正常顯示；原廠修好後此防呆自動不觸發。

### 🟠 P1 — 本版次應修

| 編號 | 現況（依源碼） | 風險 | 要求 | 驗收 |
|---|---|---|---|---|
| **SEC-04** | `/etc/ifcfg-sip` 內 `WEB_PASSWORD`、`PRIMARY/BACKUP_PASSWORD` 皆**明文**儲存 | 取得檔案即得所有密碼 | Web 登入密碼改用**雜湊**儲存（如 SHA-256 + salt），登入時比對雜湊 | 讀 `/etc/ifcfg-sip` 不應出現可讀的 Web 登入明文密碼 |
| **SEC-05** | `request_login_cmd()` **無失敗計數／鎖定**；錯誤碼表的 `A005`（登入失敗鎖定）**未實作** | 可對 `/auth/login` 無限暴力嘗試 | 加入登入失敗鎖定：同來源連續失敗達門檻（如 5 次）鎖定一段時間（如 5 分），回 `A005` | 連續錯密碼達門檻後，後續登入於鎖定時間內回 `A005` |
| **SEC-06** | `request_change_password_cmd()` 只比對舊密碼即寫入新密碼，**不檢查長度/複雜度**；改密後**舊 token 仍有效** | 可設過弱密碼；改密後舊憑證未失效 | `change_password` 加最小長度（≥8）與英數混合檢查，不合回 `E001`；改密成功後**清除現行 token**，強制重新登入 | 設弱密碼被拒；改密成功後舊 token 呼叫端點回 `A003` |
| **SEC-09** | `/get/sip/config` 等回應以 `snprintf("%s")` 直接把欄位值塞進 JSON、**完全不 escape**（見 `websetsip.c` 各 `request_get_*`） | 設定值含 `"`、`\`、換行或控制字元時，回應變成**非法 JSON**，前端解析失敗；亦是注入面 | 改用 `cJSON` 建構回應（自動 escape）；或對寫入值做嚴格字元白名單 | 將 SIP 密碼設成含 `"`/`\` 後，`/get/sip/config` 仍回合法 JSON、前端正常顯示 |

### 🟡 P2 — 後續可排

| 編號 | 現況（依源碼） | 風險 | 要求 | 驗收 |
|---|---|---|---|---|
| **SEC-07** | Token 為 `get_token_string()` 產生的 32 hex **尾帶 `\n`**，比對用 `strlen-1` 之 off-by-one；且為**全域單一 session**（新登入覆蓋舊的） | 實作脆弱、易誤判；無法多人/多端管理 | 移除 token 尾端 `\n`、修正長度比對；視需要支援多 session 與更嚴謹的逾時 | token 不含換行；多次登入行為符合預期 |
| **SEC-08** | `request_system_info()` **無 token** 且用 `popen("top -n 1")`+`df -h`，**慢且單執行緒** | **未登入即可連續打此慢端點 → 阻塞單執行緒 web 服務（DoS）**；亦拖累正常輪詢 | 先以 SEC-01 對其加 token（擋未授權 DoS）＋速率限制；實作改讀 `/proc`（`/proc/stat`、`/proc/meminfo`）取代 `popen(top)` | 未授權連打不再能阻塞服務；回應時間明顯下降 |

---

## 三、資產識別／供應商標識（BRAND）

目的：讓資安弱掃／資產盤點工具能**明確辨識本設備為「廣田資訊（Guangtian, Taiwan）」之產品 GT-SIP-GW**，而非白牌轉售品。網頁端的識別字串（`<title>`、meta、可見品牌、頁尾 URL）我方已於 `index.html` 內建完成；下列**韌體層**字串需原廠協助設定。

| 編號 | 現況（依源碼） | 要求 | 驗收 |
|---|---|---|---|
| **BRAND-01** | 所有回應的 HTTP 標頭 `Server: <HBI_WEB_SERVER>`（巨集，目前非廣田字串）——這是 banner grab／弱掃最先讀取的識別 | 將 `HBI_WEB_SERVER` 改為含廠商與產品之字串，建議：`GT-SIP-GW (Guangtian)` | `curl -I http://<IP>/` 之 `Server:` 顯示 `GT-SIP-GW (Guangtian)` |
| **BRAND-02** | `/etc/ifcfg-sip` 之 `MODEL` 為原廠預設舊代碼，由 `/get/device/status` 回傳 | 出廠值改為 `MODEL=GT-SIP-GW`（或於產線寫入） | `/get/device/status` 之 `device_info.model` 回傳 `GT-SIP-GW` |
| **BRAND-03**（選用） | 無供應商標頭 | 各回應加一個自訂標頭 `X-Vendor: Guangtian Information (www.guangtian.net.tw)`，利於指紋比對 | 回應含 `X-Vendor` 標頭 |
| **BRAND-04**（在地化，2026-06-25 .147 實測） | 韌體面向使用者的訊息為**簡體中文**：登入失敗「密码不正确」、成功「登录成功」、SIP「成功注册」、token「该Token非当前有效Token」、「操作成功/失敗」等（前端已正確 GBK 解碼，但內容本身為簡體） | 廣田為台灣產品、網頁全繁體中文；韌體面向使用者之字串請改為**繁體中文**（如「密碼不正確」「登入成功」「成功註冊」） | `/auth/login` 等回應之 `message`/`details` 為繁體中文 |

> 說明：`index.html`（本次整合的網頁）已含 `GT-SIP-GW`／`廣田資訊`／`www.guangtian.net.tw` 之標題、meta 與頁尾；BRAND-02 完成後，網頁的「型號」欄會自動只顯示 `GT-SIP-GW`（不再附韌體舊代碼）。

---

## 四、備註

- SEC-01～SEC-06 與 BRAND-01～02 皆屬 `websetsip.c`／`/etc/ifcfg-sip` 範圍，與本次「網頁整合」同一檔案，**可同版次一併處理**，不需額外取得 `/opt/termapp` 源碼。
- 前端網頁已做的（強制改預設密碼、閒置 5 分登出、登入鎖定 UI、密碼遮罩、HTTP 明文警告橫幅）僅為**用戶端 UX**，可被繞過，無法取代上述韌體層修補。
- 完成後請逐條回覆各 SEC 與 BRAND 編號之處理狀態（已修／不修＋原因／延後），以利我方更新驗收與部署規劃。

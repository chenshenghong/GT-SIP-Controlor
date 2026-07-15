# 設備內建管理網頁 (Device Embedded Web UI)

`index.html` —— 給 **GT-SIP-GW（廣田資訊 SIP 廣播閘道器）設備自身** 使用的管理網頁。單一檔案、零外部相依（no CDN / no build / no framework），可直接塞進韌體 flash，由設備 `:80` 提供。對應 `docs/GT-SIP-REST_API.md` 的 19 條 REST API，安全層級參考 **Grandstream** 網路設備網頁（GRP/GXP/HT 系列）的前端慣例。

> ⚠️ **先讀第 3 節**：本網頁負責「前端能做的安全」；真正的防護（GET 端點鑑權、HTTPS、密碼雜湊、暴力破解鎖定）必須在**韌體**補。目前工廠韌體在這幾項是不及格的，前端無法替它補上。

---

## 1. 這是什麼 / 怎麼用

* **單檔**：把 `index.html` 放到任何能被設備 `:80` 提供的位置即可（見第 2 節）。
* **同源相對路徑**：由設備提供時，所有 API 走 `/<相對路徑>`，免設定。
* **開發/測試**：登入頁「進階 · 設備位址」可填 `http://192.168.1.200` 指向實機；或網址帶 `?host=http://192.168.1.200`。
  * ⚠️ **跨來源限制（CORS）**：韌體回應沒有 `Access-Control-*` 標頭，所以**一般瀏覽器**只有在「由設備同源提供」時才能正常打 API。從 `file://` 或別台主機直接開會被 CORS 擋。跨來源測試請用：設備同源、反向代理、或關閉 web security 的容器（如本 CMS 的 Electron 環境）。

已內建處理所有韌體怪癖（與 `docs/firmware-reference/REFERENCE.md` 對齊）：

| 韌體怪癖 | 前端處理 |
|---|---|
| 回應 `charset=GBK` | `TextDecoder('gbk')` 解碼 |
| Response 尾端夾非法控制字元、token 尾帶 `\n` | `replace(/[\u0000-\u001F\u007F-\u009F]/g,'')` 清洗後再 `JSON.parse`（順帶去掉 token 換行 → 32 hex） |
| 設備單執行緒、`Connection: close` | 請求**序列化佇列**（同時只送一個）+ timeout + 重試 |
| `/system/info` 慢（`popen(top)`/`df`） | **不放進儀表板輪詢**，只在系統頁按需取 |
| 音量範圍 **0–100**（非 0–15） | slider min0 max100 |
| 改 IP / 重啟後斷線 | 全螢幕倒數遮罩 + 重連/重導向 |
| 組播位址須 224–239 | 前端先擋 |

### 本機測試（dev-proxy.mjs）— 繞過 CORS

韌體尚未提供網頁前，要從電腦測 `index.html`，最穩的方法是用本資料夾的零相依代理 `dev-proxy.mjs`（Node）。它在 localhost 同源提供網頁、把 API 轉發到真實設備，瀏覽器視為同源 → 不會被 CORS 擋。

**先確認設備可達**（在與設備同網段的電腦上，直接打設備、繞過瀏覽器）：
```bash
curl -X POST http://192.168.0.146/auth/login \
  -H "Content-Type: application/json" -d '{"username":"admin","password":"123456"}'
```
有回 `token` → 設備正常，CORS 問題用下方代理解；連不上 → 設備未開 / IP 錯 / 不同網段。

**啟動代理**（需先裝 Node.js LTS：<https://nodejs.org/>；整個 `device-web` 資料夾要放在一起）：

- **最簡單（雙擊）**：Windows 雙擊 `start-proxy.bat`、macOS 雙擊 `start-proxy.command`，輸入設備 IP（或直接 Enter 用預設）即可。
  > ⚠️ `dev-proxy.mjs` 本身**不能雙擊**——它是 JavaScript 原始碼、不是可執行程式，Windows 會跳「無法開啟此類型的檔案 (.mjs)」。請用上面兩個啟動檔，或下面的指令。
- **或用指令**：
  ```bash
  node device-web/dev-proxy.mjs 192.168.0.146        # 預設埠 8080
  node device-web/dev-proxy.mjs 192.168.0.146 9000   # 指定埠 9000
  ```

然後瀏覽器開 `http://localhost:8080/`，登入頁「**設備位址留空**」，帳密 `admin / 123456`。

**停止代理**：
| 情境 | 停法 |
|---|---|
| 前景執行（看得到 log 的那個終端機） | 按 **`Ctrl + C`**（代理會印出「■ 代理已停止」） |
| 背景執行（macOS / Linux） | `pkill -f dev-proxy.mjs`　或依埠號：`lsof -ti:8080 \| xargs kill` |
| 背景執行（Windows） | `netstat -ano \| findstr :8080` 找 PID → `taskkill /PID <PID> /F` |

> 代理只是測試輔助；**工廠完成第 2 節的整合後，直接開 `http://<設備IP>/` 即可，不需要代理。**

---

## 2. 讓設備自己提供這個網頁（韌體補一條路由）

**現況**：`websetsip.c` 的 `http_callback()` 只 dispatch 那 19 條 JSON 路由，**沒有任何靜態檔/HTML 處理**，`GET /` 不會回 HTML。所以「設備自身提供網頁」需要韌體加一條靜態路由。

**工廠已確認可整合**，現成落地包在 [`firmware-integration/`](firmware-integration/)：

| 檔案 | 用途 |
|---|---|
| `make-embed.sh` | 把 `index.html` 壓成 gzip 並產生 `web_index_gz.h`（網頁更新時重跑） |
| `web_index_gz.h` | 已產生好的內嵌 C 標頭（gzip 後約 15 KB） |
| `serve_index.c` | `request_get_index()` handler + 精確的路由插入位置 |
| `整合說明.md` | 工廠整合三步驟與驗收方式 |

已驗證：handler 以 `cc -Wall` 零警告編譯，輸出的 body 解壓後與 `index.html` **位元組完全相同**。路由必須插在 `/auth/login` 之前（既有 prefix 比對會讓 `GET /` 誤命中登入）。詳見 `整合說明.md`。

**不想動韌體的替代方案**：把 `index.html` 放在同網段的小型靜態伺服器 / 反向代理（代理同時轉發 API 到設備、消除 CORS），或內嵌進本 CMS（Electron）以視窗開啟並用「設備位址」指向實機。

---

## 3. 安全層級對照（Grandstream 參考 vs. 本實作 vs. 韌體缺口）

「參考 Grandstream 安全等級」要誠實拆成三欄：前端做得到的已實作；**做不到的都卡在韌體**。

| 安全項目（Grandstream 慣例） | 本網頁（前端） | 韌體現況 / 需補 |
|---|:---:|---|
| 登入帳密驗證 | ✅ 走 `/auth/login` | ✅ 有（但明文比對） |
| **預設密碼強制修改** | ✅ 偵測 `admin/123456` 登入即強制改密、未改不放行 | ⚠️ 韌體不強制；前端代為把關 |
| 密碼複雜度 + 強度條 | ✅ 最少 8 碼、需英數、禁用預設/同帳號 | ❌ 韌體 `change_password` **完全不檢查長度/複雜度** |
| 閒置自動登出 | ✅ 預設 5 分鐘 | ❌ 韌體無此概念（僅 token 3600s 滑動視窗） |
| 登入失敗鎖定 | ⚠️ 前端 5 次→鎖 5 分（僅本機 UX） | ❌ 韌體**未實作** A005，可被無限暴力嘗試（前端鎖定可被繞過） |
| Token 帶於 `Authorization: Bearer` | ✅ 自動附加；存 `sessionStorage`（關閉分頁即清） | ⚠️ **全域單一 session**，新登入覆蓋舊的；token 尾帶 `\n`、比較有 off-by-one |
| 密碼遮罩 + 顯示切換 | ✅ 所有密碼欄 | — |
| 危險操作二次確認 | ✅ 重啟 / 改 IP / 登出 | — |
| 連線加密 HTTPS | ⚠️ 偵測 HTTP 即顯示安全橫幅警告 | ❌ **韌體無 HTTPS**，全程明文（含 SIP 密碼） |
| **GET 端點需鑑權** | — 前端無法補 | 🔴 **嚴重**：`/get/sip/config`（**回傳 SIP 明文密碼**）、status、volume、network、system 全部**免 token 即可讀**（#5,7,8,14,15,18） |
| 密碼儲存雜湊 | — 前端無法補 | 🔴 帳密與 SIP 密碼**明文**存 `/etc/ifcfg-sip` |
| CSRF | ✅ 用 Bearer header（非 Cookie），先天免疫大部分 CSRF | — |
| `noindex` / 不外洩 | ✅ meta robots | — |

### 給工廠的韌體強化建議（依風險排序）
1. 🔴 **所有 GET 端點補 token 驗證**，至少 `/get/sip/config` 不可免鑑權回明文密碼。
2. 🔴 **回應遮蔽密碼**：`/get/sip/config` 改回 `"********"`，需要時另開「顯示密碼」鑑權端點。
3. 🔴 **改用 HTTPS**（或最低限度限制只在管理 VLAN 開 `:80`）。
4. 🟠 帳密改**雜湊**儲存（如 SHA-256+salt），勿明文落地。
5. 🟠 補**登入失敗鎖定**（真正的 A005），前端鎖定只是 UX。
6. 🟠 `change_password` 加長度/複雜度檢查；修密後**廢止舊 token**。
7. 🟡 修 token 尾端 `\n` 與 off-by-one 比較；考慮多 session / 逾時更嚴謹。

---

## 4. 可調參數

集中在 `index.html` 開頭的 `CFG` 物件：`IDLE_LOGOUT_MS`、`MAX_LOGIN_TRIES`、`LOCKOUT_MS`、`POLL_MS`、`REQ_TIMEOUT_MS`、`REBOOT_COUNTDOWN`、`PW_MIN_LEN` 等，依現場需求調整即可。

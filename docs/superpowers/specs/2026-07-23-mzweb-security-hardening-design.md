# mzweb v6.1.2 安全強化（P0＋P1）設計

> 承接 P7 mzweb（`docs/multi-zone-poc/src/mzweb/`，已真機 .70 部署）。本階段把 mzweb 從「忠實重現 v2.1.1 不安全行為」提升到符合《設備Web安全強化需求單 v6.1.2》的 P0＋P1，使自研 web server 達可出貨標準。
> 日期：2026-07-23。狀態：設計待核可。

## 一、背景與問題

P7 mzweb 是照舊源碼 `docs/firmware-reference/websetsip.c`（v2.1.1、明文 :80）重建，並**刻意保留原廠「怪癖」**——而那些怪癖正是《安全需求單 v6.1.2》列為 🔴 P0 的漏洞。真機 .70 實證：`/get/sip/config` 無 token 回明文 SIP 密碼、全程 :80 明文、`/get/device/status` 吐無效 JSON。P7 的「零漂移」對齊的是不安全的舊基準，**目標設錯**。

關鍵事實（決定設計方向）：
- **CMS 已領先 mzweb**：`src/renderer/composables/deviceApi.ts` 的 `baseURL` 已是 `https://${ip}`（https-first、http fallback），請求攔截器對**所有請求含 GET 皆帶 `Authorization: Bearer`**，並內建 FW-01 髒 JSON 修復。故 SEC-01（GET 加 token）對 CMS 透明、SEC-03（HTTPS）正是 CMS 首選——mzweb 是要**追上** CMS 已有的預期。
- 設備 `.70` **無可複用 wolfSSL**（`find` 全系統無）；libc 為 uClibc-0.9.33.2。故 mzweb 續走 musl 靜態自帶哲學，**靜態連結自帶 mbedTLS**。
- 業界基準（Grandstream/海康/Axis）：出貨即 `:80`→301→`:443`、強制 TLS 自簽、安全回應標頭；一次性憑證警告可接受。

## 二、範圍

| 項 | 需求 | 級別 |
|---|---|---|
| SEC-01 | 6 個 GET 端點加 Bearer token 驗證，失敗回 A003 | 🔴 P0 |
| SEC-02 | `/get/sip/config` 密碼欄遮蔽為 `********` | 🔴 P0 |
| SEC-03 | HTTPS（mbedTLS 靜態、設備端自簽 SAN=IP）、:80→301→:443、安全標頭 | 🔴 P0 |
| FW-01 | `/get/device/status` 格式字串 `broadcast_volume` 補收尾引號＋冒號 | 🔴 P0 |
| FW-02 | 同函式 `sip_status` 未閉合致 device_info/network_info 錯巢狀＋大括號不平衡 | 🔴 P0 |
| SEC-04 | `WEB_PASSWORD` 改雜湊儲存（SHA-256＋salt） | 🟠 P1 |
| SEC-05 | 登入失敗鎖定（同源 5 次/5 分，回 A005） | 🟠 P1 |
| SEC-06 | 改密碼複雜度（≥8、英數混合，不合回 E001）＋改密成功清除現行 token | 🟠 P1 |
| SEC-09 | 回應改用 cJSON 建構（自動 escape），取代 `snprintf("%s")` 未 escape | 🟠 P1 |

**非目標（P2，另階段）**：SEC-07（移除 token 尾 `\n`、修 off-by-one；CMS 以 `.trim()` 相容，暫留）、SEC-08（`/system/info` 改讀 `/proc` 取代 `popen(top)`；但本階段 SEC-01 已對它加 token，擋掉未授權 DoS 面）。

## 三、架構（四層）

### 3.1 TLS 傳輸層（SEC-03，最重）
- **vendor mbedTLS**（pin 版本，muslcc 靜態編，同 cJSON vendor 套路）；產物仍單一靜態 armv7 二進位，估 +200–300KB flash。
- webapi.c 新增 TLS：`:443` accept 後做 **非阻塞 TLS handshake**（mbedTLS `mbedtls_ssl_handshake` + 非阻塞 BIO，整合進既有 poll event loop——handshake 分多輪不可阻塞單執行緒 loop，比照既有 partial-read 狀態機，每 conn 帶 TLS 狀態）。TLS 之上沿用既有 HTTP 解析／路由／`web_snd_data`（改為經 `mbedtls_ssl_write`）。
- **憑證（設備端自簽）**：新增 `mzcert` 模組——首開/改 IP 時以 mbedTLS `x509write` 產 RSA-2048 自簽憑證（**SAN=IP 必要**，現代瀏覽器只認 SAN）、`daysValid=3650`、私鑰 `chmod 600` 存持久分區（`/etc/sipweb/`）。改 IP 自動重簽（刪舊 crt/key→重啟首開重生成，掛進既有改 IP 流程）。
- **`:80`→301**：`:80` 仍聽，但（憑證就緒後）對**所有路徑**一律回 `301 Location: https://<Host><原路徑>`，不在 http 上服務任何實質內容；管理頁與 19 路由全在 `:443`。（憑證未就緒的首開窗口例外，見 §五 首開延遲。）
- **安全回應標頭**：所有回應（http 301 與 https）加 `X-Frame-Options: SAMEORIGIN`、`X-Content-Type-Options: nosniff`、`X-XSS-Protection: 1; mode=block`。

### 3.2 鑑權強化（SEC-01/05/06）
- **SEC-01**：patch 對 6 個 GET（`/get/device/status`、`/get/device/volume`、`/get/sip/config`、`/get/call/status`、`/get/network/config`、`/system/info`）在 handler 開頭加 token 驗證（重用 T7 `mzweb_check_token`），失敗回 A003。CMS 已對 GET 帶 token，透明。
- **SEC-05**：新增 file-scope 失敗計數表（同源 IP→連續失敗數＋鎖定到期時戳，以 event loop `mn_now` 判時）；`request_login_cmd` 失敗遞增、達 5 次鎖 5 分回 **A005**、成功歸零。
- **SEC-06**：`request_change_password_cmd` 加最小長度 ≥8＋英數混合檢查（不合回 E001）；改密成功後 `memset now_token`（清除現行 token）強制重登。

### 3.3 資料保護（SEC-02/04/09）
- **SEC-02**：`request_get_sip_config` 的 `PRIMARY_PASSWORD`/`BACKUP_PASSWORD` 欄一律輸出 `********`。（顯示真密碼的 token 端點屬 P2，本階段不做。）
- **SEC-04**：`WEB_PASSWORD` 改存 `sha256$<salt>$<hash>` 格式；`request_login_cmd` 比對雜湊。**遷移**：讀到舊明文值（無 `sha256$` 前綴）時，比對明文成功後**就地升級為雜湊**寫回（一次性透明遷移，不需人工介入；預設 admin/123456 首登即升級）。
- **SEC-09**：`request_get_*` 回應改用已 vendor 的 cJSON 建構（`cJSON_CreateObject`/`AddString`/`Print`）自動 escape，取代手工 `snprintf("%s")`；消除設定值含 `"`/`\`/控制字元時的非法 JSON 與注入面。**FW-01/02 亦一併由 cJSON 建構根治**（不再靠手打格式字串）。

### 3.4 FW JSON 修正（FW-01/02）
- 併入 SEC-09：`request_get_device_status` 改用 cJSON 建構 → `broadcast_volume` key 正確、三層物件正確閉合、`device_info`/`network_info` 為 root 同層。根治後 CMS 的 `cleanDirtyJSON`/hoist workaround 對已修 mzweb 不再觸發（CMS 側清理屬另階段，非本階段必要）。

## 四、元件與檔案

| 檔案 | 變更 |
|---|---|
| `mzweb/vendor mbedTLS`（新，`mbedtls_vendor.*` 或子目錄） | vendor pin 版本；Makefile 靜態編入 |
| `mzweb/webapi.c/.h` | 加 `:443` listener＋非阻塞 TLS handshake/read/write；`:80`→301；安全標頭；conn 結構加 TLS 狀態 |
| `mzweb/mzcert.c/.h`（新） | mbedTLS 自簽憑證產生（SAN=IP）／載入／改 IP 重簽 |
| `mzweb/websetsip-p7.patch`（擴充） | SEC-01 GET token、SEC-02 遮密碼、SEC-04 雜湊＋遷移、SEC-05 鎖定、SEC-06 複雜度＋清 token、SEC-09/FW cJSON 建構回應 |
| `mzweb/Makefile` | vendor mbedTLS 編譯；憑證路徑常數 |
| `mzweb/tests/` | 各 SEC 項 host/容器測試（TLS handshake、301、no-token GET A003、遮密碼、鎖定、複雜度、雜湊遷移、cJSON escape/FW JSON 合法性） |
| `mzdeploy.sh` | 部署帶憑證持久化考量；首開重簽提示 |

## 五、相容性與遷移

- **WEB_PASSWORD 遷移**：舊明文→首次成功登入就地升級雜湊，零人工。若 `/etc/ifcfg-sip` 由外部工具重置為明文，下次登入再升級。
- **token 尾 `\n`（SEC-07 未做）**：暫留，CMS `.trim()` 相容；SEC-06 改密清 token 與此不衝突。
- **CMS**：已 https-first＋token-on-all＋FW workaround，SEC-01/03 透明；本階段不需改 CMS（FW workaround 移除屬清理、另議）。
- **首開憑證延遲**：RSA-2048 keygen 在單核 Cortex-A7 可能數秒~數十秒；設計為**背景產生**，未就緒前 `:443` 尚未起則 `:80` 暫不 301（避免無處可轉），就緒後啟用 301。

## 六、風險

| # | 風險 | 緩解 |
|---|---|---|
| 1 | mbedTLS 靜態體積／26MB RAM | 精簡 mbedTLS config（只開 TLS1.2/1.3＋RSA/AES/SHA256、關不需模組）；量測 RSS |
| 2 | TLS handshake CPU 於單核 Goke 拖累 event loop | 非阻塞 handshake 整合 poll、併發上限沿用 4；量測 handshake 延遲 |
| 3 | 首開 keygen 延遲 | 背景產生＋就緒前不 301；量測首開時間 |
| 4 | 密碼雜湊遷移破壞既有登入 | 就地升級策略＋保留明文比對相容路徑；真機驗證舊→新登入不中斷 |
| 5 | 自簽憑證瀏覽器警告 | 業界標準（Grandstream 同做法）；文件說明一次性「繼續」；SAN=IP 避免更嚴重的 CN 錯誤 |
| 6 | cJSON 建構回應改動 19 路由回應面 | 逐路由對照原輸出（除刻意修的 FW/escape/遮密碼）；容器＋真機回歸 |

## 七、驗收（真機 .70）

1. **SEC-03**：`https://192.168.0.70/` 可登入操作；`http://192.168.0.70/*` 回 301→https；憑證含 SAN=IP；所有回應帶三個安全標頭；改 IP 後重簽新 SAN。
2. **SEC-01**：6 個 GET 無/錯 token → A003，不回資料；帶 token → 正常。
3. **SEC-02**：`/get/sip/config` 密碼欄為 `********`。
4. **FW-01/02＋SEC-09**：`/get/device/status` 為合法 JSON、`device_info`/`network_info` 在 root 同層；SIP 密碼設含 `"`/`\` 後 `/get/sip/config` 仍合法 JSON。
5. **SEC-04**：`/etc/ifcfg-sip` 的 `WEB_PASSWORD` 為 `sha256$…`、無明文；舊明文設備首登自動升級、登入不中斷。
6. **SEC-05**：連續 5 次錯密碼 → A005，鎖定期內續錯仍 A005，5 分後恢復。
7. **SEC-06**：改密碼 <8 或非英數混合 → E001；改密成功後舊 token 呼叫 → A003。
8. **CMS**：CMS 走 HTTPS 對 .70 全功能（登入/狀態/SIP/組播/網路）。
9. **維運**：reboot 後 HTTPS＋憑證恢復；mzdeploy 部署/rollback 含憑證。

## 八、參考

- `docs/設備Web安全強化需求單.md`（SEC-01~10、FW-01/02 權威定義）
- `docs/SEC-03-HTTPS-自簽憑證實作說明.md`（自簽策略、SAN=IP、改 IP 重簽、Grandstream 基準）
- `Downloads/GT-SIP-GW-韌體交付包-2026-07-18/00-總說明.md`（板 v6.1.3、REST/HTTPS 定位）
- `src/renderer/composables/deviceApi.ts`（CMS 已 https-first＋token-on-all＋FW workaround）
- `docs/multi-zone-poc/src/mzweb/`（P7 mzweb 現況）；`docs/superpowers/specs/2026-07-22-p7-websetsip-design.md`

# SIP 終端 Web 服務丟連線診斷報告（最終確診版）

> 提交對象：設備/韌體原廠
> 結論：設備 80 埠上**同時運行兩個 web server（`lgw_web` + `hbi_web`）**，連線被隨機分配，約一半落到 `hbi_web` 並回 **403 Forbidden**，造成管理軟體「設定偶發失敗、狀態讀取不穩」。
> 跨設備復現：`192.168.0.147`、`192.168.0.148`（全新設備）皆相同。
> 更新日期：2026-06-22

---

## 零、修正已驗證（2026-06-22 結案）

原廠移除 `hbi_web` 對 :80 的監聽後，複驗結果：

```
GET /get/device/volume  ×40:   .147 → 40/40 (100%) 僅 lgw_web ；  .148 → 40/40 (100%) 僅 lgw_web
login + SET /set/device/volume ×12:  12/12 成功，全部 lgw_web，無 403、無 hbi_web
```

**`hbi_web` 完全消失、讀寫皆 100%、跨兩台設備生效 → 問題根除。** 以下為診斷與根因記錄（存檔）。

---

## 一、最終結論（確診）

對設備發送**完全相同**的 `GET /get/device/volume`，設備會回兩種結果，差別在 HTTP 回應的 **`Server` 標頭**：

| 設備回應 | Server 標頭 | 佔比 | 說明 |
|----------|-------------|------|------|
| **200 OK**（正常，含音量 JSON）| `Server: lgw_web_1.0.1` | ~50% | 正確的 API 服務 |
| **403 Forbidden** | `Server: hbi_web_1.0.1` | ~50% | 另一個 web 服務，不認識此 API |

> **根因：韌體開機後 `lgw_web` 與 `hbi_web` 兩個 web server 都綁定/監聽了 TCP :80。kernel 把進來的連線輪流分給兩者；分到 `hbi_web` 的就回 403。** 這與網路、TCP、管理端 client、長/短連線、SIP 全部無關。

**修正方向（韌體）：讓 `hbi_web` 不要監聽 80 埠，:80 只由 `lgw_web` 提供服務。** 一次修好所有設備。

---

## 二、設備與測試環境

| 項目 | 內容 |
|------|------|
| 設備型號 | SipTerm / SIP-Player-2024，韌體 HK-WSDK-1.0.2.G.Sip |
| 測試設備 | `192.168.0.147`（MAC 20:23:BB:B2:93:E7）、`192.168.0.148`（全新設備）|
| 測試主機 | Windows `192.168.0.203`、Linux `192.168.0.155`（皆與設備**同網段、同交換器、直連、無代理**）|
| 測試端點 | `GET /get/device/volume`（免授權純讀取，不更動設定）|
| 工具 | `curl`（標準短連線、讀到 EOF 乾淨關閉、不復用 socket）、`tcpdump`（標準抓包）|

---

## 三、關鍵證據

### 3.1 同一請求 → 兩個 Server（同一台機器、同一埠）

```
---- 回應 A (Server: lgw_web) ----        ---- 回應 B (Server: hbi_web) 同一個 GET ----
> GET /get/device/volume HTTP/1.1          > GET /get/device/volume HTTP/1.1
< HTTP/1.1 200 OK                          < HTTP/1.1 403 Forbidden
< Server: lgw_web_1.0.1                     < Server: hbi_web_1.0.1
< Content-Type: application/json;charset=GBK< Connection: close
< {"broadcast_volume": 56, ...}
```

### 3.2 跨兩台設備統計（各 30 次相同請求）

```
設備 192.168.0.147 :  lgw_web/200 = 17/30 (57%) ,  hbi_web/403 = 13/30 (43%)
設備 192.168.0.148 :  lgw_web/200 = 14/30 (47%) ,  hbi_web/403 = 16/30 (53%)   <- 全新設備同樣有兩個 server
```

### 3.3 封包證據（標準 tcpdump 抓包）

附 `docs/captures/device_http_two_servers.pcap`（標準 pcap，Wireshark 可直接開）。內含完整交握：
```
SYN → SYN-ACK → ACK → GET(94 bytes) → 200 OK(191 bytes) → FIN     （完整三次握手 + 請求 + 回應）
```
抓包中所有封包**只在 `.155` 與 `.147` 兩個 IP 之間**（無第三方/代理），且 `Server: lgw_web_1.0.1` 與 `Server: hbi_web_1.0.1` 兩者都出現。

> 註：先前提供的 `.pcapng` 是 Windows `pktmon` 匯出的**非標準格式**（在多個網路層各抓一次、框架不完整，標準工具讀不出），請改用本報告的 tcpdump 標準抓包。

---

## 四、排除過程（第一性原理）

| 假設 | 實測 | 結論 |
|------|------|------|
| 網路 / 硬體問題 | ICMP **50/50 (100%)** | 排除 |
| 設備 TCP 堆疊 | TCP :80 連線 **50/50 (100%)** | 排除（kernel 都接受連線）|
| 回應太慢 | 成功延遲 2–113ms，timeout 拉到 10s 也救不回失敗者 | 排除（不是慢，是另一個 server 回 403）|
| keep-alive / 長連線 / 復用 socket | 伺服器回 `Connection: close`；curl 短連線、乾淨關閉仍 ~50% | 排除 |
| 連線間隔太密（2s 關閉窗口）| 間隔 300ms 與 2500ms 皆 ~50% | 排除 |
| 管理端 client / 作業系統 | **Windows(.203) + Linux(.155)** 兩台、curl，皆 45–60% | 排除 |
| SIP 搶佔 web | 原廠證實 SIP 與 web 為獨立程序 | 排除 |
| **設備有兩個 web server 搶 :80** | 200↔`lgw_web`、403↔`hbi_web`，`.147`+`.148` 皆復現 | **確診** |

---

## 五、給原廠的請求

1. **確認韌體為何 `hbi_web` 與 `lgw_web` 都監聽 :80**（`hbi_web` 可能是另一條產品線的 web 服務被一併打包進此韌體）。
2. **讓 `hbi_web` 不要綁定/監聽 80 埠**（停用該服務、或改埠、或不啟動），:80 僅由 `lgw_web` 提供。
3. 可用第六節腳本在你們端對任一設備驗證：連續 30 次 `GET /get/device/volume`，看 `Server` 標頭是否出現 `hbi_web`。
   - 若你們測試的是**閒置裸機**且只起了 `lgw_web`，會看起來「每次都成功」而看不到此問題；請在**與我方相同（兩個服務都啟動）**的狀態下驗證。

---

## 六、可重現腳本與抓包檔

| 檔案 | 用途 |
|------|------|
| [`docs/scripts/compare-web-servers.ps1`](scripts/compare-web-servers.ps1) | Windows：對多台設備統計 `lgw_web`/`hbi_web` 佔比 |
| [`docs/scripts/capture-clean-pcap.sh`](scripts/capture-clean-pcap.sh) | Linux：產生 Wireshark 可開的標準 pcap |
| [`docs/scripts/diag-http-reliability.ps1`](scripts/diag-http-reliability.ps1) | Windows：ICMP/TCP/HTTP 三層可靠性量測 |
| [`docs/captures/device_http_two_servers.pcap`](captures/device_http_two_servers.pcap) | 標準抓包證物（含 lgw_web/hbi_web 兩種回應）|

最簡單的現場驗證（與設備同網段，cmd 直接貼）：
```
for /L %i in (1,1,20) do @curl -s -D - -o NUL --max-time 8 http://192.168.0.147/get/device/volume | findstr /C:"Server:"
```
會看到 `Server: lgw_web_1.0.1` 與 `Server: hbi_web_1.0.1` 交替出現。

---

## 附錄：管理端緩解措施（原廠修復前）

管理軟體已做：請求序列化 + 失敗/403 重試 + 短逾時。靠重試可把有效成功率拉到 95%+，但每次撞到 `hbi_web` 需重試，操作延遲存在物理下限。**根治需原廠讓 :80 只由 `lgw_web` 服務。**

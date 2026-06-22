# SIP 終端 Web 服務丟連線診斷報告

> 提交對象：設備/韌體原廠
> 目的：以分層量測證明「設備 HTTP 請求約 60% 無回應」的根因位於**設備 web server（應用層）**，而非網路或主機端，並提供可重現的量測方法與數據。
> 量測日期：2026-06-22

---

## 一、摘要與結論

管理軟體（REST over HTTP）對設備發送設定 / 輪詢狀態時，**約 60% 的 HTTP 請求得不到回應（逾時）**，造成「設定偶發失敗」「狀態讀取很慢」。

以分層量測定位後，結論明確：

> **問題在設備端的單執行緒 web server（`lgw_web`）：它把 kernel 已經接受的 TCP 連線丟棄了約 60%，未在合理時間內回應。網路、網線、交換器、設備 TCP/IP 堆疊均完全正常。**

關鍵證據（同網段、各取樣 50 次）：

| 層級 | 結果 | 判讀 |
|------|------|------|
| ① ICMP（網路/實體層） | **50 / 50 回應，0% 丟失**，avg 0.2ms | 網路完全正常 |
| ② TCP :80 連線（kernel/傳輸層） | **50 / 50 成功**，avg 2ms | 設備 TCP 堆疊完全正常 |
| ③ HTTP GET（應用層 / web server） | **20 / 50 成功（40%）**，30 次逾時 | **丟包 100% 集中在此層** |
| 補充 | HTTP 成功時延遲僅 **41–72ms** | 並非「處理慢」，而是「連線收下卻不回應」|

並發更嚴重：6 個並發 HTTP 請求僅 1 個成功（約 17%）。

---

## 二、設備與測試環境

| 項目 | 內容 |
|------|------|
| 設備型號 | SIP-Player-2024（DBP 回報 Type 為 UNKOWN，Name=SipTerm）|
| 韌體版本 | HK-WSDK-1.0.2.G.Sip |
| Web 伺服器 | `lgw_web/1.0.1`（HTTP 回應 Server 標頭）|
| 設備 IP / MAC | 192.168.0.147 / 20:23:BB:B2:93:E7 |
| 測試主機 | Windows，192.168.0.203（與設備**同一交換器、同網段**，無路由跳轉）|
| 取樣 | 每層 50 次 |
| 測試端點 | `GET /get/device/volume`（免授權、純讀取檔案，不更動設定）|

---

## 三、方法：三層分層量測

一個 HTTP 請求必須依序穿過三層，任一層丟包都會表現為「請求失敗」。分層量測可定位丟包**確切發生在哪一層**：

```
管理主機  ──①封包(ICMP)──>  ──②TCP三向交握(kernel)──>  ──③HTTP請求(web server)──>  設備
```

- **① ICMP**：驗證實體層與網路層（網線、交換器、封包傳輸）是否丟封包。
- **② TCP :80 連線**：驗證設備 **kernel** 的 TCP/IP 堆疊能否穩定接受連線（SYN/SYN-ACK）。
- **③ HTTP GET**：驗證設備 **userland 的 web server** 能否在接受連線後，讀取請求並回應。

若 ①② 接近 100% 而 ③ 明顯偏低 → 丟包必然發生在設備的 HTTP 應用層（web server），可排除網路、TCP、主機端因素。

---

## 四、量測數據（原始輸出）

```
目標設備: 192.168.0.147 | 每層取樣: 50 次

=== Layer 1: ICMP 網路層 ===
  ping 50/50 回應 (0% 丟失), avg 0.2ms, max 1ms

=== Layer 2: TCP :80 連線（kernel）===
  TCP connect 50/50 成功, avg 2ms

=== Layer 3: HTTP GET /get/device/volume（web server）===
  HTTP 逐次 20/50 成功, 30 逾時/失敗
  成功延遲 min/avg/max = 41/44/72ms
```

補充量測：
- 並發 6 個 HTTP 請求 → 僅 1 個成功（其餘逾時）。
- 寫入端點（如 `POST /set/device/volume`）行為相同：**有回應時 27–250ms 即成功**，但同樣約半數請求無回應。

---

## 五、第一性原理分析

1. 若為**網路/硬體問題**（網線、交換器、干擾、設備網卡），ICMP 與 TCP 也會丟包。實測二者 **0% 丟失、50/50 成功** → 排除。
2. **TCP 三向交握由設備 kernel 處理**，實測 50/50 成功 → 設備網路堆疊正常、能穩定接受連線。
3. 連線被 kernel 接受後，需由 **userland 的單執行緒 web server**（`lgw_web`）`accept()` → 讀取 HTTP 請求 → 回應。實測此層僅 40% 成功。
4. **web server 有回應時僅 44ms**（極快）→ 並非處理緩慢，而是大量已被 kernel 接受的連線**從未被 web server 服務到**，直到客戶端逾時。
5. 推測機制（待原廠以源碼確認）：單執行緒事件迴圈在 `accept`/服務連線上有瓶頸或間歇阻塞；HTTP 採「每請求一條新連線 + Connection: close」，連線頻繁建立/關閉可能加劇此問題；listen backlog 可能過小。

> 我方持有 web 設定處理層 `websetsip.c` 的源碼，但 **accept/listen 的框架層（event/socketbase）不在我方手上，屬原廠程式**，故無法自行定位確切行號，需原廠協助。

---

## 六、結論與給原廠的請求

**結論：設備韌體的單執行緒 web server（`lgw_web`）會丟棄約 60% 已被 kernel 接受的 TCP 連線，未予回應。此為韌體/軟體缺陷，非網路或硬體問題。**

請原廠協助：

1. **確認 `lgw_web` 的 accept/listen 迴圈**：是否 listen backlog 過小、是否事件迴圈有阻塞點、是否每請求一連線造成資源/socket 壓力。
2. **建議改善方向**（擇一/併用）：
   - 加大 listen backlog；
   - 支援 HTTP keep-alive，避免每個請求都新建/關閉連線；
   - 確認 web server 事件迴圈不會被其他工作（如 SIP/IPC）阻塞；
   - 或改用穩定的 HTTP server 元件。
3. **可重現性**：原廠可用第七節腳本，在與設備同網段的 Windows 主機上直接復現本報告數據（ICMP/TCP 近 100%、HTTP 約 40%）。

> 在原廠修復前，管理軟體端已做緩解（請求序列化 + 失敗重試 + 短逾時），可達 95%+ 可用率，但因每次無回應需等待逾時，操作延遲存在物理下限（平均約 2 秒/次操作），無法單靠客戶端根治。

---

## 七、可重現量測腳本

完整腳本見 [`docs/scripts/diag-http-reliability.ps1`](scripts/diag-http-reliability.ps1)。在**與設備同網段**的 Windows 主機上執行：

```powershell
powershell -ExecutionPolicy Bypass -File diag-http-reliability.ps1
```

（將腳本內 `$ip` 改為待測設備 IP；`/get/device/volume` 為免授權純讀取，不更動設定。）

---

## 附錄：相關韌體事實（供原廠交叉比對）

- Web 服務監聽 TCP :80（`websetsip.c`：`WEB_SIP_SET_TCP_LISTEN_PORT 80`，可由 `/etc/ifcfg-sip` 的 `WEB_PORT` 覆寫）。
- 採事件迴圈：`main.c` → `get_main_event_loop()` / `init_sip_web_set_svr()` / `event_loop_run()`。
- 回應為單行 JSON、`Connection: close`、`charset=GBK`。
- DBP 發現協定為 UDP 廣播 :58001（與本 HTTP 問題無關，併附以利定位機種）。

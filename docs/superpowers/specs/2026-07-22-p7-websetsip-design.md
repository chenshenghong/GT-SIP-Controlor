# P7 — 自建 websetsip（mzweb）設計

> Multi-zone side-car PoC 的產品化階段 P7，落實評估文件 §八拍板 2「控制面整合進 websetsip(:80)」。
> 前置：P0–P6 已於真機 `192.168.0.70` 全數驗證通過（見 `docs/multi-zone-poc/README.md`）。
> 日期：2026-07-22。狀態：設計已核可（本次 session），待實作計畫。

## 一、背景與問題

§八拍板 2 的原前提是「websetsip 源碼在手，自編加兩條 zones 路由」。實查 `docs/firmware-reference/` 後發現：源碼只有 `websetsip.c`（3022 行）＋ `main.c`（13 行）＋ `websetsip.h`，其 include 的 7 個原廠 SDK 標頭（`webapi.h`、`event.h`、`socketbase.h`、`keyvaluefile.h`、`hostsid.h`、`aio_audio.h`、`cjson.h`）與對應程式庫皆不在手上，**無法直接重編**。

經逐一呼叫點分析（符號面萃取結論見 §五），7 個標頭中 6 個為 trivial/easy，唯 `webapi.h`（HTTP server 層）需實質自製——而這與 mzrelay3 已做過的極輕 REST server 同性質。**拍板：自補相容層、重建全功能 websetsip（代號 mzweb），替換 `/etc/sipweb/sipweb`。**

因為連框架層一起自建，原「SDK 語意未知」項（`request_type` 的可能值、`init_web_listen` 的三組 NULL 槽與尾端 flag、callback 回傳值語意）全部轉為我方自行定義，相容性義務收斂為單一標準：**對外 HTTP 線上行為與原廠 sipweb 一致**。

## 二、架構

```
瀏覽器 / CMS / device-web
      │ HTTP :80（線上行為與原廠一致：GBK、Connection: close、單一 token）
      ▼
mzweb ＝ 原廠 websetsip.c（最小 diff）＋ 自研相容層（musl 靜態 armv7）
      │ 19 條原路由照舊 → /tmp/sip.sdk → /opt/termapp（閉源，不動）
      │ 新增 GET/POST /get|set/sip/multicast/zones ──轉呼──▶ mzrelay3 REST（127.0.0.1:8090）
      ▼                                                └─ 寫 /opt/mzzones.json＋熱 re-join
GET / ──▶ 回內建 device-web 管理頁（web_index_gz.h）
```

- termapp、SIP 通話面、mzrelay3 資料面（IGMP join／仲裁／RTP 重寫）零改動。
- 替換 `/etc/sipweb/sipweb` 前先備份原廠二進位；回退＝還原檔案＋reboot。

## 三、元件設計

### 3.1 相容層（新程式碼）

| 檔案 | 內容 | 依據 |
|---|---|---|
| `webapi.c/h` | poll-based 最小 HTTP server 掛在共用 event loop：accept→非阻塞讀→解析 request line／headers／body→擷取 `Authorization`→以 `APP_REQUEST_CMD` 呼叫 `http_callback(client, http_head, type, content, len)`。`web_snd_data(client, buf, len)`＝寫出後關閉連線並釋放資源（caller 已自組完整 HTTP 回應）。`get_http_url`／`get_http_head` 回傳指向請求緩衝區內部的非 NUL 結尾指標＋長度（沿用原呼叫慣例）。callback 結束而未曾 `web_snd_data` 的連線→回明確 404 後關閉。 | 唯一呼叫點 websetsip.c:3015 簽名 100% 確定 |
| `event.c/h` | 單例 `event_loop`（公開欄位 `mn_now`＝快取毫秒），`event_timer_init/start`（一次性計時器），`clock_time()`＝CLOCK_MONOTONIC 毫秒。`TIMER_EVENT` 以值內嵌，內部佈局自訂。 | API 表面極小（timer×1＋mn_now） |
| `keyvaluefile.c/h` | `KEY=VALUE\n` 純文字讀寫（`/etc/ifcfg-sip` 格式），6 函式：read/find/add/modify/write/free。 | 格式由 fallback 寫入邏輯反推 |
| `socketbase.c/h` | `set_no_block`（fcntl O_NONBLOCK）、`close_socket`（close 包裝）。 | trivial |
| `hostsid.c/h` | **stub：`judge_hostsid_is_equal()` 恆回 0**。原廠序號關卡語意不可考（唯一呼叫點無 log、比對邏輯不明）。 | 見 §六風險 3 |
| `aio_audio.h` | 空頭檔（原始碼中零符號使用，死 include）。 | 呼叫點掃描 |
| `cjson.c/h` | vendor 開源 upstream cJSON（DaveGamble/cJSON，MIT；`valueint`/`valuestring` ABI 吻合）＋薄轉接 `cJSON_Parse(content, len)` → `cJSON_ParseWithLength`。 | 僅用於解析請求 body，回應全為手工 snprintf |

### 3.2 websetsip.c 最小 diff

- **編譯用原始 GBK 版**（非 utf8 轉檔版），字串常值字節與原廠一致，保住 `charset=GBK` 線上行為。
- 路由表 `request_url` 19→21：新增 `GET /get/sip/multicast/zones`、`POST /set/sip/multicast/zones`。
- 新 handler 行為：驗自帶 Bearer token（GET 亦驗，比照 SEC-01）→ 把 body **原樣**轉呼 mzrelay3 loopback REST → 回應**原樣**轉回。E001 驗證、佔位列規則、priority 唯一性、原子寫檔、熱 re-join 全部沿用 mzrelay3 已真機驗證的實作，**websetsip 端不重複實作驗證**。
- `GET /` 回內嵌 device-web 管理頁：沿用 `device-web/firmware-integration/` 既備的 `web_index_gz.h`＋`request_get_index()`（gzip 內容原樣送出），補上原本要工廠做的靜態路由。
- **原廠怪癖原樣保留、不順手修**：token 比對 `len == strlen(now_token) - 1` 的 off-by-one、單 token 單 session（後登者覆蓋前者）、`/system/info` 走 `popen("top -n 1")` 的慢路徑、`GET /get/sip/config` 回明文密碼、部分 GET 無 token 檢查。CMS 與 device-web 相依現行行為，任何「修好」都是漂移。

### 3.3 mzrelay3 小改

- REST bind 位址納入 `/opt/mzrelay.conf` 可配置；P7 部署預設 `127.0.0.1`（loopback 免 token、對外收攤，`:8090` 全網監聽降為除錯選項）。
- 其餘（zones 驗證、持久化、熱套用、資料面）不動。

### 3.4 與需求單 §四 的刻意偏離（記錄在案）

1. **不做** zone 1 變動時同步覆寫舊四 key（`MULTICAST_ADDRESS/PORT/ENABLED/CODEC`）——該條款為「原廠改 termapp」路線而寫；side-car 架構下 termapp 必須固定聽 mzrelay3 的 dst group，同步覆寫會斷中繼鏈。
2. **不送** `/tmp/sip.sdk` 的 `set_multicast_zones` 通知（§五）——termapp 不認得此命令；熱套用改由 mzrelay3 re-join 達成，效果等價（免重啟、不斷 SIP 通話）。
3. zones 資料存 `/opt/mzzones.json`（mzrelay3 單一擁有者），不寫 `/etc/ifcfg-sip` 的 `MULTICAST_ZONES`。

## 四、建置與部署

- **建置**：同 P0 流程——Docker `muslcc/x86_64:arm-linux-musleabi`，`-march=armv7-a -static -no-pie -O2`；產物單一靜態二進位 `mzweb`。
- **部署**（`mzdeploy.sh` 擴充）：備份 `/etc/sipweb/sipweb` → 安裝 mzweb 於原位 → 重啟 web 服務；`status` 納入 mzweb 健康檢查；`rollback` 還原備份。開機自啟沿用原廠對 sipweb 的既有拉起機制（替換原位即繼承）。
- **回退**：還原備份二進位＋reboot，單步完成。

## 五、關鍵事實（符號面分析結論摘要）

- token/session 管理**完全在 websetsip.c 內自帶**（`static struct http_sip_set` 單例、`/proc/sys/kernel/random/uuid` 產 token、以 `mn_now` 判過期、verify 滑動延展），不依賴任何缺失庫。
- `init_web_listen` 唯一呼叫點簽名 100% 確定；三組 `(NULL,0)` 與尾端 `0` 語意不可考，相容層自行定義（忽略）。
- `aio_audio.h` 零使用；`hostsid` 僅啟動關卡一處呼叫，與 HTTP 路由無關。
- 完整符號表與呼叫點行號：本次 session 子代理分析（來源 `docs/firmware-reference/websetsip.utf8.c`）。

## 六、風險與緩解

| # | 風險 | 緩解 |
|---|---|---|
| 1 | 19 條原路由任何線上行為漂移會炸 CMS／現場 | 驗收第一項即「原廠 vs mzweb 線上 diff 回歸」（§七.1）；websetsip.c 應用碼原樣沿用、僅動路由表與新 handler |
| 2 | 未知路由／畸形請求的原廠行為無從比對 | 真機探測原廠行為後，mzweb 定為明確 404/close；屬可接受偏離，記錄於驗收報告 |
| 3 | hostsid stub 移除原廠序號關卡（若真有授權語意） | 部署範圍限自有設備（`.70` 續掛觀察）；客戶生產設備部署須另行風險評估（§八拍板 4 原則不變） |
| 4 | 相容層 HTTP 解析邊界（分包、慢客戶端、超長 header） | 沿用 mzrelay3 已驗證的讀取迴圈模式；驗收加入畸形請求探測 |
| 5 | GBK 編譯鏈路（GBK 源碼過 musl gcc） | 字串常值為原始字節、不經轉碼；建置後以線上 diff 驗證 GBK 回應字節一致 |

## 七、驗收標準（真機 `192.168.0.70`）

1. **線上回歸**：腳本對原廠 sipweb 與 mzweb 逐一打全部 19 條路由（含錯誤案例：壞 token、壞 JSON、A001/A002/A003/E001/E008 路徑），diff 狀態碼／標頭／body（時間戳等動態欄位遮罩）＝零差異；CMS `deviceApi.ts` 實連全功能不炸。
2. **新功能**：兩條 zones 路由通過需求單 §四全部驗證案例（E001 各分支、佔位列規則、priority 唯一性、`audio_codec` 白名單）；P5 的 device-web「載入 16 區→儲存→熱套用免重啟→GET 一致」閉環改經 `:80` 重跑通過；`GET /` 回內嵌管理頁。
3. **維運**：reboot 後 mzweb＋mzrelay3 自動恢復、與 SIP 通話並行無干擾；`mzdeploy.sh` 部署／status／rollback 三向真機驗證；`.70` 續掛觀察（記憶體/存活）。

## 八、非目標

- 不改 termapp、不動 SIP 通話面、不做 HTTPS（原廠 `:80` 明文現狀維持；SEC-03 另案）。
- 不修原廠既有怪癖（單 session、明文密碼回傳、慢 `/system/info`）。
- 不做每區獨立 codec（§八拍板 5：全域統一單一 codec）。

## 九、參考

- `docs/組播多監聽區-自研可行性評估與PoC計畫.md`（§八拍板）
- `docs/組播多監聽區需求單.md`（§四路由規格；§三/§五為原廠路線條款，偏離見本文 §3.4）
- `docs/firmware-reference/REFERENCE.md`＋`websetsip.c`（權威源碼；不進版控）
- `docs/multi-zone-poc/README.md`（P0–P6 現況）；`device-web/firmware-integration/整合說明.md`（GET / 內嵌頁素材）

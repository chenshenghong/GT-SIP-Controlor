# 交接 Prompt — CMS 數值錯誤修復 ＋ CMS 16 區 zones UI

> 給新 session 用。貼下面「交接內容」給新 session 即可接手。前一 session 已把 GT-SIP-GW 的自研 web（mzweb）做到 P7（收攏 :80 控制面）＋v6.1.2 安全強化（HTTPS/SEC-01~09），真機 .70 驗收全過、已 push 進 PR #3。本次待辦是兩件 CMS 相關工作。

---

## 交接內容（貼給新 session）

你接手 GT-SIP-Controlor（`sip-cms` — SIP 設備中央管理系統，Electron + Vue 3）。分支 `feat/multi-zone-poc-p4`（PR #3，未合併）。設備測試機 `192.168.0.70`（Goke GK7205V200 / OHLinux，root SSH :9521）現跑**自研 mzweb HTTPS 版**（:443 + :80→301）。有兩件待辦，請用 superpowers 流程（brainstorming→spec→plan→SDD）處理。

**開工先讀**（背景全在這）：
- project memory：`multi-zone-selfbuild-poc.md`（P0–P8 全貌，mzweb 架構、GBK patch 陷阱）、`gt-sip-gw-rogue-hbi-web.md`、`deploy-to-*.md`、`sip-gw-e2e-test-env.md`（.70 存取雷區）。
- 設備存取：`docs/multi-zone-poc/src/mzctl.py`（`python3 mzctl.py sh '<cmd>'` root SSH .70）。CMS 設備 API：`src/renderer/composables/deviceApi.ts`（已 https-first、Bearer token on all）。
- mzweb 源碼：`docs/multi-zone-poc/src/mzweb/`（自研 C，musl 靜態交叉編譯；⚠ `websetsip-p7.patch` 是 GBK+CRLF，**不可用 Edit/Write 工具改**會污染，須 binary-mode bash/python + patch/diff）。
- 設備 https 登入：`curl -sk https://192.168.0.70/auth/login -d '{"username":"admin","password":"123456"}'`（自簽憑證用 -k）。

### 待辦 1：CMS 系統維護頁數值錯誤

CMS 連 .70 的「系統維護」頁顯示 **CPU 0%、溫度 0°C**，且頂部連線狀態卡在「連線中...」。前一 session 已探測，findings：

- **溫度 0°C ＝真 bug（設備側）**：`/system/info` API 回 `"temperature": 0`。根因：mzweb 的 `docs/multi-zone-poc/src/mzweb/readtemp.c` 讀 `/sys/class/thermal/thermal_zone0/temp`（Linux 標準 thermal sysfs），但 **.70 的 Goke GK7205V200 無此路徑**（`ls /sys/class/thermal/` 無 thermal_zone0，`/dev` 也無溫度裝置）。→ 需求：找 Goke GK7205V200 的溫度感測介面（可能是 Goke 專屬 /proc、ioctl、或 `/dev` 下某 mpp 節點如 `/dev/sys`；查 Goke SDK/termapp 怎麼讀溫度——`strings /opt/termapp | grep -i temp` 或 `/dev/logmpp`/`/dev/sys` 探索），改 readtemp.c 讀對的來源；若此平台確實不易暴露溫度，則決定顯示「N/A」而非 0（並改 CMS 顯示邏輯）。**注意**：readtemp.c 是 mzweb 一部分，改它要重編 arm 二進位＋重部署 .70（`mzctl.py put ... /etc/sipweb/sipweb.new` + 原子替換 + 經 `/etc/sipweb/sipweb.sh` 監督重啟；備份鏈見下）。
- **CPU 0% ＝多半非 bug**：API 其實回 `cpu_usage` 浮動值（探測時抓到 9.1），.70 閒置時 top 顯示 `100% idle` 故 CPU≈0% 是正常。但請確認 CMS 顯示是否有欄位對應/取整 bug（對照 API 回的 `cpu_usage` 與 CMS 顯示）——若 API 給 9.1 而 CMS 顯示 0 才是 CMS bug。
- **「連線中...」卡住 ＝ CMS 側**：連線狀態邏輯在 `src/renderer/composables/useReconnect.ts` + `src/renderer/components/ReconnectOverlay.vue`。頁面有資料代表已連上，但狀態未轉「已連線」。可能因某輪詢端點慢/失敗（`/system/info` 用 `popen("top -n 1")` 慢＝已知 SEC-08，單執行緒；deviceApi timeout 1500ms 可能對 /system/info 太短）或連線判定邏輯。查 CMS 怎麼判「已連線」、哪個端點卡住。**先確認是 CMS 判定邏輯還是設備端 /system/info 逾時**。

`/system/info` handler 在原廠 `docs/firmware-reference/websetsip.c` 的 `request_system_info`（用 popen top + df + get_local_temp），mzweb 經 patch 沿用；SEC-01 已對它加 token。溫度欄來自 `get_local_temp()`（readtemp.c）。

### 待辦 2：CMS 加 16 區組播監聽區（zones）UI

**背景**：設備已支援 16 區多監聽區（mzweb 的 `/get|set/sip/multicast/zones` 轉呼 side-car mzrelay3），但 **CMS app 只有單槽組播 UI**（`src/renderer/components/DeviceDetail.vue` 的「📡 SIP / 組播」分頁，單筆 `MulticastConfig` → 舊 `/set/sip/multicast`）。16 區目前只能透過設備嵌入網頁（`http(s)://設備IP/` 的 device-web 頁）管。

**已 brainstorm 的設計方向**（前一 session 探索、使用者核可「CMS 加完整 16 區 zones UI」，但因先做安全強化而擱置）：
- **核可方案**：CMS runtime 偵測設備是否支援 zones（`GET /get/sip/multicast/zones` 有回 zones 陣列＝支援；RESP_PARSE/404＝舊韌體）。支援 → 用 16 區表**取代**單槽卡（單槽卡隱藏，避免斷鏈）；不支援（舊韌體）→ 保留單槽卡。
- **斷鏈風險（務必處理）**：side-car 設備上 termapp 單槽 MULTICAST 必須固定聽 mzrelay3 輸出 group（`.70` 實測 `MULTICAST_ADDRESS=239.192.1.1:2000`＝mzrelay3 輸出）。CMS 單槽頁 `handleSetMulticast` 會直接寫 termapp 單槽 → **改了就把 termapp 從 mzrelay3 拉走、斷掉多監聽區鏈**。故 zones-capable 設備上單槽卡必須隱藏/鎖定。
- **16 區 UI 規格**（照設備嵌入頁 `device-web/index.html` 的 16 區實作搬進 CMS）：16 區固定、每區 `multicast_address`(224–239)/`multicast_port`(1024–65535)/`priority`(1–16，啟用區間全域唯一)/`enabled`/`audio_codec`(G.711U/G.722)；佔位列（全空）略過驗證、半成品列擋下；整表 16 筆一次送 `POST /set/sip/multicast/zones`；伺服器端 E001 指名 zone_id。device-web 的 `renderMulticastZones`（`device-web/index.html` 約 L928-1010）有完整規則可對照。
- **需要**：新增 `MulticastZone[]` 型別（`src/shared/types.ts`，已有 `DeviceKind='gt-sip-gw'|'dayu-ot300'`）、`getSipMulticastZones`/`setSipMulticastZones`（`deviceApi.ts`）、DeviceDetail 的 16 區可編輯表 + 能力偵測 gating。

**建議**：待辦 1（數值/連線）較獨立、先做；待辦 2 是新前端功能，走 brainstorming→spec→plan→SDD。兩者可各自一個 spec/plan。

### 交接注意
- `.70` 備份鏈：`/etc/sipweb/sipweb.orig`＝rogue hbi_web、`/etc/sipweb/sipweb.p7`＝P7 明文 mzweb、`/etc/sipweb/sipweb`＝現行 HTTPS mzweb。改 readtemp 重部署前先確認能 rollback。
- mzweb 改碼→`cd docs/multi-zone-poc/src/mzweb && make arm-mzweb`（Docker muslcc）→ 推 .70。host/容器測試 `sh tests/run_host_tests.sh`。
- 工作樹有既有未提交 `AGENTS.md`/`CLAUDE.md` 改動，任何 commit 勿夾帶。
- PR #3（`feat/multi-zone-poc-p4`→main）現 50 commit、OPEN；CMS 這兩件做完可續併進或另開 PR，由使用者定。

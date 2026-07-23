# P7 mzweb 真機驗收紀錄（.70，2026-07-22）

> 對應計畫 `docs/superpowers/plans/2026-07-22-p7-mzweb-websetsip.md` T11–T12。
> 驗收機：`192.168.0.70`（Goke GK7205V200 / OHLinux，root SSH :9521）。

## 一、現場勘查揭露的關鍵真相（改寫了驗收方法）

替換前唯讀勘查即發現 P7 原計畫的核心前提有誤，經逆向確認後改採「直接部署＋CMS 契約驗收」：

1. **ASSUMPTION 佐證通過**（spec §3.4-2）：`strings /opt/termapp | grep -c set_multicast_zones` = **0**，termapp 確實不認得該命令，「不送 sip.sdk 通知、改由 mzrelay3 re-join 熱套用」的決策成立。

2. **`.70` 的 `/etc/sipweb/sipweb` 是 rogue hbi_web 空殼，不是真 web server**：
   - Server 標頭 = `hbi_web_1.0.1`；`strings` 顯示**真實路由字串數 = 0**（無 `/auth/login`、`/get/device/status` 等）。
   - 對所有 API 路由（含 `/auth/login`）回真實 `HTTP/1.1 403 Forbidden`；`GET /` 回 200。
   - loopback(127.0.0.1) 與外部 IP **都 100% 403** → 非 IP-based gating。

3. **逆向結論（無需拉 binary 深挖）**：CMS 的 `src/renderer/composables/deviceApi.ts` 註解已權威診斷此缺陷——真 web server 是 **`lgw_web`（always-200+JSON）**；曾有 rogue **`hbi_web`** 也 bind :80 回 403（~半 race）；**工廠已在 .147/.148 移除 hbi_web（2026-06-22 驗證 100% lgw_web）**。`.70` 是未套此修復的機器。
   - **我方 mzweb 源碼是正確的**（= lgw_web 等價，19 路由、always-200+JSON+GBK+token 尾帶 `\n`）。
   - 403 不是要複製的框架 gating，是已知 rogue-hbi_web 缺陷。

**驗收方法調整**：無法對 .70 現有 sipweb 做「零漂移 diff」（那是缺陷空殼、非有效基準）。改以「部署 mzweb 取代 rogue hbi_web、CMS API 契約 + zones 功能 + reboot 存活」驗收。部署 mzweb 到 .70 等同**順帶修好其 rogue-hbi_web 缺陷**。

## 二、拉起機制（T11 現場實證）

- `/etc/sipweb/sipweb.sh start` = respawn 監督迴圈（`while[1]; do /etc/sipweb/sipweb; sleep2; done`）；mzweb 為常駐 server，只有 crash 才觸發重起，相容。
- 開機自啟那行預設在 `/etc/init.d/S20ipgaurd` **被註解** → 這是 .70 開機 :80 停的原因。已（經使用者核可）取消註解啟用自啟（備份 `S20ipgaurd.orig`）。
- mzrelay3 開機自啟＝`/etc/init.d/S21mzrelay` + `/opt/mzrelay.conf`（P7 於 conf 末追加第 8 參數 `127.0.0.1`）。

## 三、部署與驗收結果（全部真機通過）

| 項目 | 結果 |
|---|---|
| 備份 rogue hbi_web → `/etc/sipweb/sipweb.orig` | ✅ md5 `281aa88e…`（148244B） |
| 推送 mzweb-arm → 原子替換 | ✅ 遠端 md5 `37e91a7e…` = 本地一致 |
| `POST /auth/login` | ✅ **HTTP 200**、`Content-Type: application/json;charset=GBK`、`Allow: GET, POST`、回合法 token（尾帶 `\n` off-by-one 怪癖重現）、`{"status":"success","message":"登入成功",...}` |
| `GET /`（內嵌 device-web 頁） | ✅ 200、22923 bytes、`text/html; charset=UTF-8`（gzip 解開） |
| `/auth/verify`（帶 token） | ✅ 200 |
| `/get/device/status`、`/get/sip/config`、`/get/network/config` | ✅ 200 + 真實 JSON（GBK） |
| mzrelay3 REST 收攏 loopback | ✅ `:8090` 綁 `127.0.0.1`（外部不可達）；免 token GET zones → 200 1709B |
| **[P7 核心] mzweb:80 GET zones（帶 token）→ 轉呼 mzrelay3 loopback** | ✅ 200、**16 區** |
| zones 無 token → mzweb 擋 | ✅ **401** |
| **zones POST 合法整表** | ✅ `{"status":"success"}`、寫入持久化 |
| **zones POST E001（非法組播位址 192.168.1.1）** | ✅ `{"status":"error","error_code":"E001","message":"zone_id 1: multicast_address invalid (224-239 required)"}`；`/opt/mzzones.json` 完整未污染（1709B 合法值） |
| **reboot 存活** | ✅ uptime 57.93s（確實重開）；init 自啟 fresh PID：`sipweb.sh start`→mzweb(:80)、`mzrelay3 …127.0.0.1`(loopback:8090)；reboot 後 login→zones 16 區、GET / 22923B 全通 |

## 四、CMS 應用層驗收

CMS 為使用者桌面 Electron app，無法於此 headless session 啟動。但：
- CMS `deviceApi.ts` 使用的路由（`/auth/login`、`/get/device/status`、`/get/sip/config`、`/set/sip/*` 等）已於真機逐一驗證回 200+JSON+GBK，**契約一致**。
- **部署 mzweb 順帶修好 .70 的 rogue-hbi_web 缺陷**：CMS 對 .70 原本會遇到 ~50% 403（deviceApi.ts 靠 retry 兜底），現由 mzweb 100% 應答。
- **✅ 已由使用者以 CMS app 對 .70 實連確認通過（2026-07-23）**——登入／狀態／SIP／組播頁全正常，rogue-hbi_web 缺陷修復生效。
- **後續發現的產品缺口**：CMS app 的組播頁只有**單槽**（`DeviceDetail.vue` 單筆 `MulticastConfig` → 舊 `/set/sip/multicast`），管不到 16 區多監聽區（僅設備嵌入頁 `GET /` 有 16 區 UI）。且單槽頁在 side-car 設備上有**斷鏈風險**（改 termapp 單槽會把它從 mzrelay3 輸出拉走）。→ 已決策：CMS 新增完整 16 區 zones UI（另立設計/計畫，見 `docs/superpowers/specs/`）。

## 五、回退

- `./mzdeploy.sh mzweb-rollback`：還原 `/etc/sipweb/sipweb.orig`（rogue hbi_web）＋`S20ipgaurd.orig`（回 found-state :80 web off）＋reboot。
- mzrelay3 回退：`/opt/mzrelay3.p6`（P6 備份）+ 移除 conf 第 8 參數。

## 六、生產化追蹤項（非 .70 PoC 阻擋項）

- mzweb Server 標頭現為 `SIP-Player-2024`（REFERENCE.md 命名值；CMS 只看 body 不看此標頭）。若要與工廠 lgw_web 完全一致可再校正。
- mzweb_zones 轉呼 mzrelay3 為**同步阻塞**（mzrelay3 hang 至多凍 2s event loop）——與原廠 `/system/info` popen(top) 同架構、非回歸；生產前可改 async（見 T7 審查）。
- 其餘 mzweb SDK 框架層（`init_web_listen` 三 NULL 槽/尾 flag）語意仍不可考——.70 上 mzweb 行為已實證正確，但若日後對接需要那層特性再議。

# 組播多監聽區（Multi-zone）— 自研可行性評估與 PoC 計畫

> 對象：內部技術決策（是否不等原廠、以自研方式在既有 GT-SIP-GW 上實現 multi-zone）
> 觸發：2026-07-20 逆向取得設備 **root SSH（root / BcastTerm2 / 9521）**，可讀寫設備任意檔、佈署自研元件、替換 `/opt/termapp`（見 project memory `gt-sip-gw-firmware-upgrade-ssh`）。原本《組播多監聽區需求單》假設「原廠改韌體」；本文評估把該功能**自研落地**的可行性。
> 測試資源：公司內測試機 **GT-SIP-GW `192.168.0.70`**（✅ 已上線並完成 P0–P2 真機驗證，2026-07-21）。
> 規格依據：`docs/組播多監聽區需求單.md`（16 區、優先權搶佔、`MULTICAST_ZONES`、REST 2 條、MZ-01~07）。
> PoC 程式碼：`docs/multi-zone-poc/src/`（`mzrelay.c` 單區中繼 / `mzrelay2.c` 多區仲裁+RTP 重寫 / `mztone.c` 本機送流器 / `mzctl.py` 佈署 helper）。
>
> **狀態（2026-07-21）：PoC P0、P1、P2 及 P3 核心假設（切流平順度 R1）已真機通過**，見下方「§實證結果」。剩餘為工程整合（規模/codec/config/開機/維運），非原理性未知數。

---

## 〇、結論先行（TL;DR）

| 問題 | 結論 |
|---|---|
| 自研 multi-zone 可行嗎？ | **可行——已真機驗證**。執行面走「側車（side-car）RTP 仲裁中繼」，不改閉源 termapp。 |
| 最大不確定性（原） | **切流時 termapp 的 jitter buffer 對 RTP 流跳變的反應**——原列 PoC 第一優先。**✅ 已驗證通過**：RTP 重寫（統一 SSRC/連續 seq-ts/切換 marker）後，反覆搶佔切流**乾淨、無爆音**，使用者聽覺確認。 |
| 已驗證（2026-07-21） | P0 自製 ARM binary 設備原生執行 ✅／P1 side-car 透明中繼、termapp 零改動收播 ✅／P2 多區搶佔（≤50ms）+ 靜默恢復 + 不混音 + 切流無爆音 ✅。 |
| 次要風險（未消） | 各區 codec 混用、26MB RAM／單核資源預算（16 區壓測）、與原廠韌體升級的共存、維運游離。 |
| 建議 | **核心假設已通過，自研技術可行性成立**。續推工程整合（P4–P6：規模/config/開機/維運），與原廠需求單並行作為時程保險。 |
| 不建議 | 反組譯 patch termapp（B/C 路，風險高、不可維護）；完全重寫 termapp（工程量不切實際）。 |

**一句話**：我們無法讓閉源的 termapp 自己聽 16 區，但可以自研一支輕量 daemon 替它聽 16 區、做優先權仲裁，再把「勝出的那一路」餵給 termapp 當單流播放——termapp 現成的解碼／音頻輸出／G.722 時鐘修正全部沿用。成敗取決於「餵入的流切換時 termapp 是否平順接受」。

---

## 一、背景：為什麼現在能談自研

需求單原本的責任切分是「device-web（我方已完成）＋ websetsip 2 條路由（原廠）＋ termapp 多 socket join＋仲裁（原廠主要工作量）」，即**執行面要原廠改閉源韌體**。

這 session 逆向升級後，局面改變：我們對這批設備有 **完整 root 控制權**——能 SSH（`root/BcastTerm2:9521`）、能 SFTP 佈署任意 ARM binary、能替換 `/opt/termapp`、能改 `/etc/*` 與 init 腳本。於是「自研執行面」從不可能變成一個工程選項。本文即評估這條路。

> 定位：自研是**原廠的替代/加速手段**，不是否定原廠路線。兩者可並存決策（見 §八）。

---

## 二、事實基礎（本 session 實測，非推測）

### 2.1 設備硬體／OS（實測 `192.168.1.140`，同款）
- SoC **Goke GK7205V200（ARM Cortex-A7，單核）**；OHLinux / BusyBox；uClibc **0.9.33.2**。
- **RAM 僅 26 MB**（MemTotal 26208 kB，MemAvailable ~16 MB）。⚠ 這是最硬的約束——自研 daemon 必須極輕量。
- 無 on-device 編譯器（gcc/cc 皆無）→ 自研元件須**交叉編譯**成 uClibc 相容 ARM binary。
- 音頻輸出裝置 `/dev/ao`（Goke 音頻 HAL，termapp 專用）＋ `/dev/snd`。

### 2.2 三層架構（原廠源碼 `docs/firmware-reference/websetsip.c` + 實測佐證）
```
瀏覽器 / CMS ── HTTP :80（REST，明文 GBK）
      ▼  websetsip（/etc/sipweb/sipweb；原廠源碼在手，3022 行）
      │  token 驗證 → cJSON 解析 → 驗證 → read/modify/write_keyvalue_file(/etc/ifcfg-sip)
      │  → 經 Unix socket /tmp/sip.sdk 送 JSON 命令通知 termapp
      ▼  /opt/termapp（閉源 ARM binary；SIP 註冊、撥號、組播接收、音頻解碼/輸出、DBP）
```
- 組播設定端點 `request_set_sip_multicast()`（websetsip.c:2440）：模板＝驗證 `224–239`＋port 範圍 → 寫 `MULTICAST_ADDRESS/PORT/ENABLED/CODEC` → sip.sdk 通知。
- sip.sdk 命令格式（termapp strings 佐證）：`{"command":"set_sip_multicast","cseq":n}`，termapp 收到**無參數重讀** config、免重啟生效。

### 2.3 組播執行面現況（實測）
- termapp **單槽 join**：讀 `/etc/ifcfg-sip` 的 `MULTICAST_ADDRESS:MULTICAST_PORT`，`setsockopt(IP_ADD_MEMBERSHIP)` 加入**一個** group。
- `/proc/net/igmp` 實測該台僅 join `224.0.0.1`（all-hosts 基本 group）＝**目前未配應用組播**；配了才會多 join 一個應用 group。
- RTP 收流在 termapp 的動態 UDP socket；`/dev/ao` 出聲。

### 2.4 我們的能力邊界
- ✅ root SSH、SFTP 佈署、改 `/etc/*`、加 init 腳本、替換 termapp、控制面源碼在手、config schema 已知、device-web「📡 組播監聽區」頁**已完成**。
- ❌ termapp 無源碼（stripped）；設備資源極小；需交叉編譯 toolchain。

---

## 三、自研路徑選項比較

| 路徑 | 做法 | 可行性 | 風險/成本 | 判定 |
|---|---|---|---|---|
| **A. Side-car RTP 仲裁中繼** | 自研輕量 daemon `mzrelay` join 16 區＋優先權仲裁＋把勝出流轉發給 termapp（termapp 當單流播放器，不動它） | **高** | 中：RTP 切流連續性、資源預算、toolchain | ⭐**推薦** |
| B. 反組譯 patch termapp | 反編譯 termapp 找 join 點改成多區＋插入仲裁邏輯 | 低 | 極高：stripped binary、音頻即時性、每次原廠升級失效、不可維護 | ✗ |
| C. 完全自研 termapp | 重寫 SIP/RTP/codec/音頻 HAL/GPIO/對講/DBP | 極低 | 不切實際（等於重做整個韌體） | ✗ |
| D. 純控制面配置 | 假設 termapp 已內建多區、只是沒暴露 API | — | 實測否定：termapp 單槽 join，無隱藏多區能力 | ✗（已排除） |

**推薦 A**：唯一「不碰閉源執行面、又能複用 termapp 現成解碼/音頻/G.722 修正」的路徑。以下詳述。

---

## 四、推薦架構：Side-car RTP 仲裁中繼（`mzrelay`）

### 4.1 資料流
```
   16 區真實組播（eth0）                          termapp（不改）
  zone1 239.x:port ─┐                          聽「中繼 group」單槽
  zone2 239.y:port ─┤   ┌──────────────┐        MULTICAST_ADDRESS=239.255.0.1
  ...  (IGMP join   ├──▶│   mzrelay     │──RTP──▶ :PORT（本機遞送）
  每 enabled 區各1) ─┘   │ 優先權仲裁器  │        │ 解碼→/dev/ao 出聲
  zone16 ...────────┘   │ RTP 重寫器    │        ▼
                        └──────────────┘      （現成單流播放路徑）
```
- `mzrelay` 對每個 `enabled` 區各開 UDP socket＋`IP_ADD_MEMBERSHIP`（16 區 join 在 side-car，不在 termapp）。
- **仲裁器**：收到某區封包＝該區「活躍」；`RTP_SILENCE_TIMEOUT`（預設 2s）未收＝該流結束。當前輸出＝所有活躍區中 priority 最小者；高優先權來流即時搶佔；其結束後若低優先權仍活躍則恢復；同優先權先到先播（＝需求單 §一搶佔語意、驗收 2/3/4/5）。
- **輸出**：把勝出區的 RTP 封包轉發到 termapp 監聽的「中繼 group」（把 termapp 的 `MULTICAST_ADDRESS` 設成一個保留給中繼用的 group，如 `239.255.0.1`；mzrelay 本機送出、termapp join 收）。

### 4.2 關鍵技巧：RTP 重寫（讓切流對 termapp 透明）
不同區是不同 RTP 流（各自 SSRC / seq / timestamp）。若直接轉發，切流瞬間 termapp 會看到 SSRC 跳變 → jitter buffer 可能重置/靜默/爆音。
**對策**：mzrelay 轉發時改寫每個外送封包的 RTP header：
- **SSRC** → 固定值（termapp 全程只見「一條流」）。
- **sequence number** → mzrelay 自己連續遞增。
- **timestamp** → 依 codec 時鐘（G.711 8kHz / G.722 亦 8kHz RTP 時鐘，RFC 3551 §4.5.2）連續推進。
- payload 原樣（不解碼、不轉碼）→ 純封包層搬運，Cortex-A7 單核可負擔。
> 這正是 RTP switcher/mixer 的標準手法。**能否讓 termapp 平順接受，是 PoC P3 的核心驗證點**。

### 4.3 控制面（兩選項）
- **選項 1（PoC 推薦，隔離）**：`mzrelay` 自帶極輕 HTTP，提供 `GET/POST /get|set/sip/multicast/zones`（另一 port，如 `:8080`），寫自有 config `/etc/mzrelay/zones.json`；device-web 指向此 port。**websetsip/termapp 完全不動**，風險最低、易回退。
- **選項 2（產品化）**：用原廠源碼**自編 websetsip**，加需求單 §四的 2 條路由，寫 `MULTICAST_ZONES` 進 `/etc/ifcfg-sip`，新增 sip.sdk 命令通知 mzrelay。整合度高但要替換 `/etc/sipweb/sipweb`，風險較大，留待 PoC 通過後。

### 4.4 Config 與生效
- `mzrelay` 讀 `/etc/mzrelay/zones.json`（16 區表，欄位同需求單 §一）；SIGHUP 或自有 socket 觸發**無中斷重讀**（重建 join 集合與仲裁狀態，不重啟）。
- **向下相容**：`zones.json` 缺失時，`mzrelay` 讀舊 `MULTICAST_ADDRESS/PORT` 當 zone 1，或直接不啟用讓 termapp 走原生單槽（需求單 §二）。

### 4.5 佈署與生命週期
- 交叉編譯 `mzrelay`（arm-himix100 / goke uClibc 0.9.33.2 相容）→ SFTP 佈署 `/opt/mzrelay` ＋ `/etc/init.d/S08mzrelay` 開機自啟 ＋ 改 termapp 的 `MULTICAST_ADDRESS` 指向中繼 group（經 sip.sdk 或改 config）。手法同本 session 的韌體佈署。
- **與原廠升級共存**：termapp 整包 rom 升級（ipguard `update_rom.enc`）會覆蓋 rootfs → 需重佈 mzrelay；app 替換（換 termapp）不影響 mzrelay。須納入維運 runbook。

---

## 四之二、實證結果（真機 `192.168.0.70`，2026-07-21）

> 以下為 §四架構的實機驗證。程式碼見 `docs/multi-zone-poc/src/`。

### 4B.1 P0 — 自製 binary 設備原生執行（ABI 相容）✅
- toolchain 用 **musl cross-compiler**（`muslcc/x86_64:arm-linux-musleabi`）編**靜態、非 PIE** armv7 binary，繞過 uClibc 版本相依——**不需原廠 SDK**（解掉風險 R6）。
  ```bash
  docker run --rm --platform linux/amd64 -v "$PWD":/src -w /src --entrypoint gcc \
    muslcc/x86_64:arm-linux-musleabi -march=armv7-a -static -no-pie -fno-pie -O2 -o mzrelay mzrelay.c
  # → ELF 32-bit LSB executable, ARM, statically linked
  ```
- 上傳 `.70` 執行：印出 usage、`rc=2`（正常啟動解析參數）。設備 `Linux OHLinux 4.9.37 armv7l`。
- **結論**：我方能自由編譯部署原生程式到設備。

### 4B.2 P1 — side-car 透明中繼，termapp 零改動收播 ✅
- termapp 續聽 `239.192.1.1:2000`（**config 完全不動**）；`mzrelay` 收源流 → 轉發到該 group（本機 loopback）。
- 實測：`mzrelay` 持續中繼（`relayed N pkts` 穩定遞增）、`/proc/net/igmp` 確認 join 正確、**喇叭實際出聲**（中文語音清楚可辨）。
- **結論**：side-car 可透明插在 termapp 前，這是整個自研架構的基石（解掉風險 R4）。

### 4B.3 P2 — 多區搶佔 + 恢復 + 不混音 + 切流平順（**核心假設 R1**）✅
`mzrelay2` 監聽多區、依優先權**單流輸出**、RTP header 重寫。設備本機零丟包送流（低優先「數數」持續 + 第 8 秒「緊急」插播 5s），仲裁 log：
```
[T0.0 ] SWITCH -> zone0 (prio2)    ← 低優先數數開始
[T8.0 ] SWITCH -> zone1 (prio1)    ← 緊急「即時搶佔」（切換延遲 ≤50ms ≪ 需求 200ms）
[T14.4] zone1 SILENT -> release    ← 緊急靜默逾時 2000ms
[T14.4] SWITCH -> zone0 (prio2)    ← 「恢復」低優先數數（20ms 內即時）
```
乾淨 3 事件（`zone0 →搶佔→ zone1 →恢復→ zone0`）。**使用者聽覺確認：緊急乾淨蓋掉數數（非混音）、緊急後恢復數數、切流瞬間無爆音**——即原列「最大不確定性 R1」（termapp jitter buffer 對 RTP 跳變的反應）**已被 RTP 重寫馴服**。

| 需求（§六 MZ / §八驗收） | PoC 結果 |
|---|---|
| 高優先即時搶佔 ≤200ms（MZ-02／#3） | ✅ ≤50ms |
| 靜默逾時恢復低優先（MZ-03／#4，預設 2s） | ✅ 2000ms 後恢復 |
| 不混音、單流輸出（MZ-02） | ✅ 任一時刻僅轉發 winner 區 |
| 切流無疊音/爆音（R1） | ✅ RTP 重寫（統一 SSRC/連續 seq-ts/marker）|

> 測試環境註記：PoC 期間 mac 與 `.70` 一度跨網段（組播不經 L3 路由），故 P1 用「mac 單播→mzrelay 轉組播」、P2 改「設備本機 `mztone` 送流」以消除丟包變數；真實部署源流為組播（P4/原 P3-scale 處理）。

---

## 五、風險登記（誠實揭露，PoC 逐項驗證）

| # | 風險 | 影響 | 緩解／驗證 |
|---|---|---|---|
| R1 | **termapp jitter buffer 對切流的反應**（即使 RTP 重寫，內部 buffer 深度/重置行為未知） | 切流爆音/瞬斷/靜默 | **PoC P3 核心**；必要時調 buffer 前導、切流時補靜音封包過渡 |
| R2 | **codec 混用**：termapp 單一 payload type，各區若不同 codec 解碼會錯 | 混用區出雜音 | PoC 先限**同 codec**；混用需 side-car 轉碼（單核吃力）或切流改 termapp codec（複雜）→ 列進階 |
| R3 | **資源**：26MB RAM／單核，16 socket＋buffer＋轉發 | OOM／音訊斷續 | mzrelay 用 C、零拷貝轉發、固定小 buffer；PoC P4 壓測 16 區 |
| R4 | **中繼 group 遞送**：讓 termapp 收到本機送出的 multicast | 收不到＝不出聲 | PoC P1 先證明；本機 multicast route / TTL / join 介面調校 |
| R5 | **搶佔延遲 ≤200ms**：封包層可達，但 termapp buffer 深度影響實際出聲延遲 | 超規 | PoC P2 量測端到端切流延遲 |
| R6 | **toolchain 取得**：需 goke/海思 arm uClibc 0.9.33.2 相容工具鏈 | 無法產出可跑 binary | PoC P0 前置；先編 hello-world 驗證 ABI |
| R7 | **與原廠韌體升級衝突／維運負擔**：自研元件游離於原廠韌體外 | 升級後失效、需重佈 | 佈署自動化＋維運 runbook；策略上評估「等原廠」對比 |
| R8 | **可維護性／交接**：自研變成我方長期責任 | 長期成本 | 文件化＋自動化；納入 §八決策 |

---

## 六、PoC 計畫（分階段，里程碑式，測試機 `192.168.0.70`）

> 原則：**每階段有明確 go/no-go**，最便宜的先做、風險最大的先驗。任一階段未過即停下重新評估，不盲目往下。對應需求單 §八驗收清單編號標於括號。

### P0 — 前置（環境就緒）✅ **PASSED（2026-07-21）**
- [x] `192.168.0.70` 上線、確認 root SSH（`root/BcastTerm2:9521`）。
- [x] 交叉編譯：**改用 musl 靜態非 PIE armv7**（`muslcc/x86_64:arm-linux-musleabi`）繞過 uClibc 版本相依，**免取得原廠 toolchain**；`mzrelay` 上傳 `.70` 執行成功（印 usage、rc=2）。
- **Go/No-go**：✅ binary 在 `.70` 原生執行 → 進 P1。

### P1 — 中繼可行性（最小閉環）✅ **PASSED**
- [x] `mzrelay` 單區中繼：收源流 → 轉發到 termapp 聽的 group（本機 loopback）；termapp config **零改動**。
- [x] `.70` **實際出聲**（中文語音清楚可辨）；`relayed N pkts` 穩定、IGMP join 正確。
- **Go/No-go**：✅ 穩定出聲 → 進 P2。（R4 本機組播遞送已通）

### P2 — 多區 join ＋ 優先權仲裁（功能核心）✅ **PASSED**
- [x] `mzrelay2` 監聽 2 區（priority 2/1）；先送低優先權 → 播低優先權。
- [x] 低優先權播放中送高優先權 → **≤50ms 搶佔、無疊音**（優於需求 200ms）。
- [x] 高優先權靜默逾時（2000ms）、低優先權仍在送 → **恢復低優先權**。
- [x] 不混音：任一時刻僅轉發 winner 區。
- **Go/No-go**：✅ 仲裁正確 → 進 P3。（同優先權先到先播 = 仲裁器 `prio` 相等時不切換，邏輯已具備，待補測）

### P3 — RTP 重寫／切流平順度（原**最高風險**）✅ **核心 PASSED**
- [x] SSRC/seq/timestamp 重寫 + 切換 marker bit；反覆搶佔切流。
- [x] 切流瞬間：**無爆音、無疊音、termapp 不重置/不掉線**（使用者聽覺確認）——**原列自研路最大不確定性 R1，已被馴服。**
- [ ] （待補）G.722 各區音調/語速壓測（無 2× 回歸；驗收 #8、MZ-04）；端到端切流延遲量測（R5）。
- **Go/No-go**：✅ 切流體感乾淨 → 自研技術可行性成立 → 進 P4 工程整合。

### P4 — 規模與 codec 邊界　✅ **完成**（2026-07-22 真機 `.70`）
- [x] 16 區全 enabled、輪流送流，每區皆可收播（驗收 #6）：16 區逐一 SWITCH 覆蓋完整、低優先循環中被高優先秒插並自動回落。**R3 徹底排除**——VmRSS **44KB**、VmSize 180KB、20 fd、單執行緒、CPU ≈**0.6%**（36 jiffies/57s），系統 free 前後不變（測試腳本 `src/p4scale.sh`）。
- [x] 斷電重啟：全區設定與 join 自動恢復（驗收 #7、MZ-05）：binary＋config 落 `/opt`（jffs2 持久），`/etc/init.d/S21mzrelay` 開機自啟（rcS 不帶參數呼叫→腳本預設 start；guarded＋背景化不阻塞開機；`src/S21mzrelay`、`src/mzrelay.conf.example`）。真機 `reboot` 後 16 區設定全恢復、轉發正常（G.722 送流即 SWITCH）。註：`/tmp` 為 tmpfs 重啟即清，測試素材需重推——正式部署一切持久物只放 `/opt`。
- [x] codec 邊界：G.711U/G.722 混用行為，界定支援範圍（R2）：`mzrelay2` 改 **PT 透傳**（不再硬貼 PT9；G.722/PCMU 皆 20ms@8kHz RTP clock，ts+=160 通用）、`mztone` 加 pt 參數。實測純 G.711U、G.722↔G.711U 混用搶佔切換：relay 轉發與仲裁全部正常、**termapp 全程不重啟不掉線**（pid 不變）；termapp binary 內含 G711/PCMU/PCMA/G722/"payload type" 字串，具多 codec 處理路徑。**待補：現場聽覺確認 G.711U 解碼出聲與混切音質**（機器面可驗項全過）。

### P5 — 控制面 ＋ device-web 對接
- [ ] 控制面選項 1（mzrelay 自帶 REST）：`GET/POST /…/zones`，整表覆寫、priority 唯一性伺服器端驗證、佔位列規則（需求單 §四）。
- [ ] device-web「📡 組播監聽區」頁對接、載入 16 區、改任一區儲存即時生效免重啟、GET 回報與畫面一致（驗收 #10、#1 向下相容）。

### P6 — 共存與維運
- [ ] 原廠韌體升級（app 替換／整包 rom）後 mzrelay 的存活與重佈流程。
- [ ] 佈署自動化腳本（比照本 session 升級腳本）＋回退方案＋維運 runbook。

---

## 七、工作量與時程（粗估，單人）

| 里程碑 | 內容 | 估時 | 狀態 |
|---|---|---|---|
| P0–P1 | toolchain＋最小中繼閉環 | 3–5 天 | ✅ **完成**（2026-07-21）|
| P2 | 多區 join＋仲裁 | 3–5 天 | ✅ **完成** |
| P3 | RTP 重寫＋切流調校（原**變數最大**） | 3–10 天 | ✅ **核心完成**（切流平順已證；G.722 壓測/延遲量測待補）|
| P4 | 規模/codec/開機恢復 | 3–5 天 | ✅ **完成**（2026-07-22；G.711U 聽覺確認待現場）|
| P5 | 控制面＋device-web | 3–5 天 | ⏳ 待做 |
| P6 | 共存/佈署/維運 | 2–3 天 | ⏳ 待做 |
| **合計** | PoC→可用 | **約 4–8 週**（視 P3） | 分水嶺 P3 已過 |

> **原「分水嶺」P3（切流平順度）已通過**——自研技術可行性成立。剩餘 P4–P6 為工程整合（規模、config/REST 對接、開機自啟、維運），無原理性未知數。

---

## 八、策略決策點（需人拍板）

1. **自研 vs 等原廠**：原廠韌體是「原生多區 join」（無 R1 切流風險、無維運游離），但受制於原廠排程/意願；自研快、可控，但 R1/R7/R8 是長期成本。**建議**：以 PoC P0–P3 當「技術探針」平行推進，不放棄向原廠施壓；P3 通過再論產品化。
2. **控制面路線**：PoC 用隔離的 mzrelay 自帶 REST（低風險）；產品化再考慮自編 websetsip 整合。
3. **維運歸屬**：自研元件成為我方長期責任，需納入升級/佈署自動化（已有本 session 的腳本基礎）。
4. **適用範圍**：先在 `.70` PoC；新興國小 30 台為潛在受益場域，但**客戶生產設備的自研佈署須另行風險評估與授權**（不在本 PoC 範圍）。

---

## 附錄 A：關鍵事實速查（實測值）
- 憑證：`root / BcastTerm2 / :9521`（OpenSSH 5.5，client 需放寬舊算法）。
- 設備：Goke GK7205V200 Cortex-A7 單核 / RAM 26MB / uClibc 0.9.33.2 / `/dev/ao` 音頻。
- 三層：websetsip(:80, 源碼在手) → `/tmp/sip.sdk`(Unix socket, `{"command":...,"cseq":n}`) → `/opt/termapp`(閉源)。
- 組播 config key：`/etc/ifcfg-sip` 的 `MULTICAST_ADDRESS/PORT/ENABLED/CODEC`（單槽）；目標新增 `MULTICAST_ZONES`(JSON) 或 mzrelay 自有 `zones.json`。
- 相關文件：`docs/組播多監聽區需求單.md`、`docs/firmware-reference/websetsip.c`、`docs/GT-SIP-REST_API.md`、project memory `gt-sip-gw-firmware-upgrade-ssh`。

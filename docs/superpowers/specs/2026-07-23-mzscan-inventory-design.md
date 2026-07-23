# mzscan — 設備盤點/前置探測 scanner 設計（新興國小 52 台 rollout 子專案 C）

> 2026-07-23。經 brainstorming ＋ Codex 設計審查（11 阻斷性問題已處置：8 納入、2 部分納入、1 劃歸 B/D 範疇）後定稿。
> 上游 brief：`docs/superpowers/PLANNING-2026-07-23-xinxing-52device-rollout.md`（子專案 C）。
> 消費者：F（韌體升級 v2.1.0→v2.1.1）、B（批次部署編排器）、E（termapp 鎖定參考）、人工判讀。

## 一、目標與範圍

對同一 L2 校網內的 52 台 gt-sip-gw 逐台探測，產出機器可讀 inventory（餵 F/B filter `action`）＋人讀摘要表，解 v2.1.0/v2.1.1 分佈、rogue hbi_web 分佈、side-car 部署狀態。

**範圍內**：發現、深探、對帳、分類、輸出。
**範圍外**（劃界，Codex 審查後明確）：inventory TTL/消費前強制重掃＝**B 的消費政策**；desired-state manifest＝**D 的範疇**。C 只保證「一次掃描的忠實快照」；F 後重掃＝重跑 mzscan，天然冪等。

## 二、形態

- 單檔 `docs/multi-zone-poc/src/mzscan.py`，python3 **stdlib-only**（跳板機 xxes-tc 無 pip）。
- 執行位置：rsync 到現場跳板機（xxes-tc，192.168.1.1，與 52 台同 L2）執行。
- 探測邏輯與分類函式模組化（同檔內純函式），供 stdlib `unittest` 在 mac 直測。

## 三、管線

### Phase 1 — 發現（DBP）

- DBP UDP 廣播 `255.255.255.255:58001`（`GET DBP/1.0`，協定同 `src/main/dbpDiscover.ts`），重發 3 次收斂，收集 `{ip, mac, fw_ver_dbp}`。
- 同一 IP 多次回應**內容不一致時記錄衝突**（`dbp_conflict` 欄），不悄悄留最後一筆。
- 與 `--expect fleet.txt` 對帳（見 §五）：missing 台仍嘗試 unicast DBP + SSH 直探，全失敗才判 unreachable。

### Phase 2 — 深探（逐台，並發限流預設 8 workers，逐台 15s 硬 timeout）

經 pty 驅動系統 ssh（root/BcastTerm2:9521，放寬舊 KEX/HostKey 算法；手法同 2026-07-20 升級 30 台之實證腳本）。**除 §三之寫測檔外全程唯讀**。timeout/失敗時保證 kill 殘留子程序。

| 欄位 | 探測方法 |
|---|---|
| `ssh_ok` | ssh 連線 + `echo OK` 回讀 |
| `ssh_hostkey_fp` | 記錄 host-key 指紋（首掃建立信任基準，B 部署時 pin 用；scanner 本身不做 strict 驗證——封閉校網首掃無既有基準） |
| `fw_ver` | 依 §四決策表：`md5sum /opt/termapp` × DBP Ver 交叉 |
| `web_type` | 依 §四決策樹（md5 → https → lgw → hbi → unknown） |
| `opt_writable` | `test ! -e /opt/.mzscan.<pid> && touch … && rm …`（唯一檔名、先驗不存在） |
| `opt_free_kb` | `df /opt` |
| `termapp_multicast_addr` | 讀 termapp 單槽 config（**確切路徑實作時上 .70 實查**；unknown 不擋分類，僅供 E 參考） |
| `sidecar_relay_bin` / `sidecar_relay_running` / `sidecar_init` / `sidecar_rest_ok` | `/opt/mzrelay3` 存在、ps 有程序、`/etc/init.d/S21mzrelay` 在位、REST `:8090 /get/sip/multicast/zones` 可達（四項分別記錄，可偵測半套） |

**三態原則（審查修訂核心）**：每個欄位＝「值」或 `unknown`＋`errors[]` 內的原因；探測失敗**只污染該欄**，不中斷該台其餘探測、不中斷全掃。

## 四、判定規則

### 韌體版本決策表

| termapp md5 | DBP Ver | → `fw_ver` |
|---|---|---|
| == v2.1.1 已知值 `b0eed3b30bd4fa4f1599a9475296fb6d` | （任意） | `2.1.1`（md5 為準） |
| ≠ 已知值 | `2.1.0` | `2.1.0` |
| ≠ 已知值 | `2.1.1` 或其他 | `unknown`（矛盾，附兩側證據） |
| 讀不到 | `2.1.0` / `2.1.1` | `unknown`（DBP 單源不足採信） |
| 讀不到 | 無 | `unknown` |

### web_type 有序決策樹

1. `md5sum /etc/sipweb/sipweb` == 本地 `mzweb/build/mzweb-arm` md5 → `mzweb`
2. HTTPS+token 握手/登入路由通（`:443`）→ `https`
3. `:80` 回 `200 OK`+JSON → `lgw`
4. `:80` 對 `/auth/login` 回 403 **且 loopback（設備上 nc 127.0.0.1）也 403** → `hbi`（`strings | grep /auth/login`=0 僅記錄為佐證，不作判準）
5. 其餘 → `unknown`

### 空間門檻（由 artifact 實際大小推導，非魔數）

`OPT_MIN_FREE_KB = 2×(mzrelay3 81KB + mzweb 402KB) + 512KB ≈ 1478KB`（2× 涵蓋 binary＋`.prev`/`.orig` 備份；實作時以當次 build 的真實檔案大小計算，本數字為現值示意）。

### 衍生分類（純函式：事實 → `action`，優先序由上而下）

| 條件 | `action` |
|---|---|
| DBP、unicast DBP、SSH 全不通 | `blocked:unreachable` |
| SSH 不通（DBP 可見） | `blocked:no-ssh` |
| `opt_writable`=false 或 `opt_free_kb` < 門檻 | `blocked:opt` |
| **任一關鍵欄位 unknown**（fw_ver / web_type / opt_writable / sidecar 四項） | `blocked:probe-incomplete`（附 unknown 欄清單） |
| `fw_ver`=`2.1.0` | `needs-fw-upgrade`（F 先跑，優先於 sidecar 判定） |
| `fw_ver`=`2.1.1` 且（sidecar 四項未全綠 **或** `web_type`≠`mzweb`） | `needs-sidecar`（四項部分綠→附 `sidecar_partial: true`） |
| `fw_ver`=`2.1.1` 且 sidecar 四項全綠 **且** `web_type`=`mzweb` | `done` |

**不變式：資訊不足永不判 `done`**——`done` 只能由全欄位確定值推出。

## 五、身分模型與對帳

- `fleet.txt`：每行 `IP[,MAC]`——**IP 必填**（unicast 探測目標），MAC 選填（僅用於與 DBP 回應交叉驗證，mismatch 記 `mac_mismatch` 警示欄）。不支援 MAC-only 條目。
- 有 `--expect`：輸出含 missing（名單內未發現）/ unexpected（發現但不在名單）＋逐台 action。
- **無 `--expect`：只出 discovery report（發現清單＋事實欄），不產 `action` 欄**——防止半盲清單被 B 自動消費。

## 六、輸出

- `inventory-<YYYYMMDD-HHMMSS>.json`：**tmp+rename 原子寫入**。頂層 metadata：`schema_version`、`scan_id`（唯一）、`started_at`/`finished_at`、`producer`（mzscan 版本字串）、`expect_file`（名單檔名與行數）、統計摘要。逐台 row：全部事實欄＋`errors[]`＋`action`（有名單時）。**絕不落任何密碼**。
- stdout 人讀摘要表＋統計（`found 50/52, missing: …; 2.1.0×N 2.1.1×M unknown×K; blocked×J`）。
- 退出碼：0=掃描完成（無論分類結果）；非 0=掃描器自身故障（如廣播 socket 建立失敗）。

## 七、錯誤處理

- 單台任何失敗只記該台 `errors[]`，不中斷全掃；每台 row 必然出現在輸出。
- DBP 無回應≠不存在：名單內 missing 台 → unicast DBP + SSH 直探，全敗才 `blocked:unreachable`。
- 逐台 15s 硬 timeout；worker 結束時 kill 該台殘留 pty/ssh 子程序（8 workers / 15s 為初值，現場 52 台實測後可調）。

## 八、測試

- **unittest（mac 跑，零網路）**：DBP 封包組裝/解析（含衝突偵測）、韌體決策表全列、web_type 決策樹全分支、分類矩陣全分支（**含各關鍵欄 unknown 組合 → 必為 blocked:probe-incomplete**）、對帳邏輯（missing/unexpected/mac_mismatch）、JSON schema 與原子寫入。
- **真機 smoke（兩型）**：`.70`（v2.1.1＋full side-car → 應判 `done`）；一台未部署 side-car 機 → 應判 `needs-sidecar`。

## 九、風險與開放事項

- termapp 單槽 config 路徑未實查（實作首步上 `.70` 確認；該欄 unknown 不擋分類）。
- 8 workers 並發對設備側 sshd（OpenSSH 5.5）壓力未實測；有異常先降 4。
- host-key 信任模型＝首掃建立基準（TOFU）；若現場疑有異物設備，以 `mac_mismatch`＋指紋比對人工複核。

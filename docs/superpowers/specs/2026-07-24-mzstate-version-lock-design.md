# mzstate — side-car 版本標記/冪等判定＋完整性鎖定（新興國小 52 台 rollout 子專案 D＋E）

> 2026-07-24 設計 spec。上游規劃：`docs/superpowers/PLANNING-2026-07-23-xinxing-52device-rollout.md`。
> D＝版本標記/冪等判定；E＝憑證/config/termapp 完整性鎖定與漂移偵測。兩者共用同一套判定核心與標記檔，合併一份 spec。產出直接被 B（批次編排器）消費。

## 一、目標與範圍

**目標**：讓 B 對 52 台混版 fleet 的每一台，能機器判定「已就緒（skip）／需升韌體（F）／需部署 side-car／config 不就緒／有人為漂移／不可達」，且整條流程可安全重跑（冪等）。

**交付物**：
1. `docs/multi-zone-poc/src/mzmanifest.json` — desired manifest（repo 端版本真相源）＋產生器。
2. 設備標記檔 `/opt/mzstate.json` 規格＋`mzdeploy.sh` 寫標整合（含 `mark` 補標子命令）。
3. `docs/multi-zone-poc/src/mzstate.py` — 判定核心（純函式庫）＋CLI（退出碼＝B 契約）。
4. `mzscan.py` 事實欄擴充（schema_version "1"→"2"）。
5. READY 的機器可判定條件定義（E 的「這台機已就緒」）。

**非目標**：
- B 本體（並發、重試、進度彙總）——B 子專案的事，本 spec 只定 B 消費的介面。
- F 韌體升級的執行——B/F 的事；本 spec 只負責「判定出需要 F」。
- 自動修復漂移——DRIFT 一律進人工佇列，不自動覆蓋人為改動。
- OmniVox zones 內容的正確性——`/opt/mzzones.json` 是營運資料（OmniVox 為真相源），不入完整性鎖定。
- binary 內嵌版本字串——已拍板不做（見決策 D1）；日後新版 binary 可順手加，但不參與判定。

## 二、已拍板決策（2026-07-24 brainstorming）

| # | 決策 | 理由 |
|---|---|---|
| D1 | **標記檔＋md5 權威**（不做 binary 內嵌版本判定） | mzrelay3/mzweb/mzio 現況零版本字串；.70 等既部署機的舊 binary 永遠回報不了版本；重編＋mzweb GBK patch 雷區成本高。md5 對 build 產物一一對應，即為版本。 |
| D2 | **判定邏輯全在 B 端 Python**（設備上只有被動標記檔） | BusyBox sh 難測難維護；改判定規則免重部署 52 台；與 mzscan 同語言可互 import、同風格 unittest。 |
| D3 | **termapp 鎖 binary md5＋單槽 MULTICAST_ADDRESS 設定** | 單槽指錯 group＝整台無聲卻各元件「看起來都對」——防斷鏈是 E 的核心目標。 |
| D4 | **憑證驗存在性＋key 權限＋SAN==IP＋未過期；md5 只做漂移 warning** | 每台自簽 SAN=IP、md5 全 fleet 不同，無法鎖統一值；OmniVox 要打 zones REST，SAN 錯＝信任失敗，必驗。重簽屬合法行為，md5 變化不擋 READY。 |
| D5 | 整合形態＝**獨立 mzstate.py**；mzscan 只補事實欄、mzdeploy 只加寫標 | mzscan＝感知、mzstate＝裁決、mzdeploy＝執行，三職責分離；B 依序消費。 |
| D6 | termapp **不入標記檔** | termapp 判定純靠 manifest md5 對照表；F 升級流程免碰標記檔，少一個要同步的狀態。 |

## 三、Desired manifest（repo 端）

路徑：`docs/multi-zone-poc/src/mzmanifest.json`，進 git，隨 release 更新。

```json
{
  "schema_version": "1",
  "release": "2026-07-24",
  "components": {
    "mzrelay3":   {"path": "/opt/mzrelay3",          "md5": "<mzrelay3 build md5>",  "version": "p7"},
    "mzweb":      {"path": "/etc/sipweb/sipweb",     "md5": "<mzweb-arm build md5>", "version": "6.1.2-txio"},
    "mzio":       {"path": "/opt/mzio",              "md5": "<mzio-arm build md5>",  "version": "1.0"},
    "S21mzrelay": {"path": "/etc/init.d/S21mzrelay", "md5": "<repo 檔 md5>"},
    "S21mzio":    {"path": "/etc/init.d/S21mzio",    "md5": "<repo 檔 md5>"},
    "termapp":    {"path": "/opt/termapp",           "md5": "b0eed3b30bd4fa4f1599a9475296fb6d", "version": "2.1.1"}
  },
  "config": {
    "mc_out_group": "239.192.1.1",
    "mc_out_port": 2000
  }
}
```

- **產生器**：`mzstate.py gen-manifest [--release <tag>]` — 讀 build 產物（`mzweb/build/mzweb-arm`、`mzweb/build/mzio-arm`、`mzrelay3` ARM binary）與 repo 內 init scripts 算 md5，termapp 條目與 config 保留手寫值（產生器只更新 side-car 五件）。缺任一 build 產物→退出碼 2、不寫檔（fail-closed，不產半份 manifest）。
- `version` 欄純人讀標籤，**判定一律以 md5 為準**。
- termapp 的 md5↔版本對照由此 manifest 驅動；`mzscan.py` 內建常數 `TERMAPP_MD5_V211` 保留當無 manifest 時的 fallback。
- `config.mc_out_group/port`＝termapp 單槽應指向的 mzrelay3 輸出 group（現值 239.192.1.1:2000，改值改這裡）。

## 四、設備標記檔（`/opt/mzstate.json`）

由 `mzdeploy.sh` 在各 install 動作**成功後**寫入；jffs2 持久、reboot 不失。

```json
{
  "schema_version": "1",
  "release": "2026-07-24",
  "written_at": "2026-07-24T10:00:00Z",
  "components": {
    "mzrelay3":   {"md5": "...", "deployed_at": "2026-07-24T10:00:00Z"},
    "mzweb":      {"md5": "...", "deployed_at": "..."},
    "mzio":       {"md5": "...", "deployed_at": "..."},
    "S21mzrelay": {"md5": "...", "deployed_at": "..."},
    "S21mzio":    {"md5": "...", "deployed_at": "..."}
  },
  "cert": {"crt_md5": "<部署當下 /etc/sipweb/mz.crt md5，可為 null（尚未首開 keygen）>"}
}
```

- **寫入方式**：tmp＋rename 原子寫（同 mzscan/keyvaluefile 慣例；tmp 檔名帶 PID 避免與他行程撞名——記取 mzweb/mzio 共用 tmp 檔名 race 教訓）。
- **read-modify-write**：`deploy` 只更新 mzrelay3/S21mzrelay 條目、`mzweb-install` 只更新 mzweb 條目、`mzio-install` 只更新 mzio/S21mzio 條目；其餘條目保留。設備端無 jq——由 mzdeploy 從跳板機側以 heredoc 生成完整 JSON 上傳，或以 `mzstate.py mark` 代寫（實作階段擇一，傾向後者：sh 不碰 JSON）。
- **`mark` 補標**：`mzdeploy.sh mark`（或 `mzstate.py mark --probe <ip>`）——對「實際檔案 md5 已符合 manifest 但無標記」的機（如 .70）現場補寫標記檔。mark **必須先驗實際 md5==manifest 才寫**，不符即拒絕（退出碼 1），防止把漂移機「洗白」。
- termapp 不入標記檔（決策 D6）。

## 五、裁決模型（mzstate.py 核心）

### 5.1 元件級三方比對

輸入：desired（manifest md5）、marker（標記檔 md5，可缺）、actual（設備實際 md5，可缺）。

| actual vs desired | actual vs marker | 元件態 | 語意 |
|---|---|---|---|
| == | —（不論） | `ok`（marker 不符或缺→附 `marker_stale` 註記） | 就緒；marker_stale 屬自癒項：重寫標記即可，不擋 READY |
| 檔缺 | — | `missing` | 需部署 |
| ≠ | ==（actual==marker） | `outdated` | 單純舊版（上次部署的舊 release），需更新 |
| ≠ | ≠ 或無 marker | `drift` | 非我方部署的內容（人為動過／半套／未知來源），需人工 |

### 5.2 整機裁決＋退出碼（B 消費契約）

優先序由上而下，first-match：

| 退出碼 | 裁決 | 觸發條件 | B 的動作 |
|---|---|---|---|
| 20 | `UNREACHABLE` | SSH 探測失敗 | 重試佇列 |
| 11 | `NEEDS_FW_UPGRADE` | termapp actual md5 ≠ manifest termapp md5（＝非 v2.1.1） | 先走 F（升韌體＋reboot），再重判 |
| 12 | `DRIFT` | 任一 side-car 元件態=`drift` | 人工佇列（不自動覆蓋） |
| 10 | `NEEDS_DEPLOY` | 任一 side-car 元件態=`missing`/`outdated`（含半套） | 走 deploy／mzweb-install／mzio-install，成功後重判 |
| 13 | `NOT_READY_CONFIG` | 元件全 `ok` 但 §六 runtime/config 條件任一不成立 | config 修復流程（重啟服務／重簽憑證／改單槽），成功後重判 |
| 0 | `READY` | §六 全部成立 | skip（冪等重跑安全） |
| 2 | usage error | 參數／輸入檔錯誤 | 修正呼叫 |

- 優先序理由：韌體先於 side-car（已拍板 F 排 B 部署前）；**DRIFT 先於 NEEDS_DEPLOY**——同機有 drift 元件時不得自動部署其他元件（整機狀態已不可信，交人工）；部署缺口先於 config 微調。
- 憑證 crt_md5 ≠ marker 記錄值→**warning**（輸出於 JSON 報告 `warnings[]`），不影響裁決（決策 D4）。
- 多台批次模式下，每台各自產裁決；CLI 整體退出碼＝0 若全 READY，否則 1（單台模式退出碼即該台裁決碼）。

### 5.3 CLI 介面

```
mzstate.py decide --inventory <mzscan.json> [--manifest mzmanifest.json] [--json out.json]   # 批次
mzstate.py decide --probe <ip>              [--manifest mzmanifest.json] [--json out.json]   # 單台（部署後 re-verify）
mzstate.py mark   --probe <ip>              [--manifest mzmanifest.json] [--components a,b]  # 補標（預設全部；--components 只更新指定條目，供 mzdeploy 各 install 動作呼叫）
mzstate.py gen-manifest [--release <tag>]
```

- `--probe` 複用 `mzscan.py` 的 probe（import，同 `MZSCAN_SSH_PW` 憑證慣例、同跳板機執行模型）。
- JSON 報告 schema：`{"schema_version":"1","manifest_release":"...","devices":[{"ip":"...","verdict":"READY","exit_code":0,"components":{"mzrelay3":{"state":"ok"},...},"checks":{"termapp_fw":"2.1.1","singleslot_mc":"ok","cert_san":"ok","rest_ok":true,...},"warnings":[],"reasons":[]}]}`。`reasons[]` 給每個非 READY 裁決人讀原因（B 直接放進彙總報表）。

## 六、READY 條件（E：「這台機已就緒」機器可判定定義）

全部成立才 READY：

1. termapp actual md5 == manifest termapp md5（v2.1.1）。
2. 五件 side-car（mzrelay3、mzweb、mzio、S21mzrelay、S21mzio）actual md5 == manifest。
3. mzrelay3 running 且 loopback REST `/get/sip/multicast/zones` 回合法 JSON（沿 mzscan `sidecar_rest_ok` 嚴格解析）。
4. sipweb（mzweb）running 且 `:443` TLS 握手成功。
5. mzio running。
6. 憑證：`mz.crt`＋`mz.key` 存在、key 權限 0600、SAN 含設備 IP、未過期（B 端 TLS 握手取 peer cert 驗，Python ssl 免驗證模式取證書）。
7. termapp 單槽 `MULTICAST_ADDRESS` == `manifest.config.mc_out_group:mc_out_port`（239.192.1.1:2000）。
8. 標記檔 `/opt/mzstate.json` 存在且可解析（內容過期只降級 `marker_stale` warning，見 5.1）。

**漂移偵測**＝同一套比對的另一面：任何時點重跑 `decide`，元件 `drift`／config 條件劣化即被抓出。B 部署完成後的 verify、日後例行巡檢，用同一 CLI 同一契約。

## 七、事實蒐集（mzscan.py 擴充，schema_version "1"→"2"）

PROBE_CMD 新增段落（沿現有 `===TAG===` 分段慣例）：

| 新事實欄 | 取法 |
|---|---|
| `mzstate_marker` | `cat /opt/mzstate.json`（原文帶回，B 端解析；缺檔→null） |
| `singleslot_mc_addr` | 讀 `/etc/ifcfg-sip` 的 `MULTICAST_ADDRESS`（含 port 欄位；見 §九 開放問題 Q1） |
| `cert_crt_exists` / `cert_key_exists` / `cert_key_perm` | `ls -l /etc/sipweb/mz.crt /etc/sipweb/mz.key` |
| `cert_crt_md5` | `md5sum /etc/sipweb/mz.crt`（供漂移 warning 比對） |
| `mzio_bin` / `mzio_running` / `mzio_init` | 同現有 sidecar 三欄模式（`/opt/mzio`、ps、`/etc/init.d/S21mzio`） |
| `mzio_md5` / `mzrelay3_md5` / `s21mzrelay_md5` / `s21mzio_md5` | `md5sum` 各檔（現況只有 termapp/sipweb 有 md5 欄） |

- 既有欄位全部保留（向下相容）；`schema_version` bump 到 "2"，mzstate 拒收 unknown schema（fail-closed）。
- SAN／效期不在 SSH probe 做（設備端無 openssl）——由 mzstate B 端 TLS 握手取證。
- `decide_web_type`、四項 sidecar 判定等既有邏輯不動。

## 八、mzdeploy.sh 擴充

- `deploy`／`mzweb-install`／`mzio-install` 成功路徑尾端：更新 `/opt/mzstate.json` 對應條目（實作傾向呼叫 `mzstate.py mark --components <list>`，sh 不自組 JSON；離線 fallback 為 heredoc 全量重寫）。
- 新子命令 `mark`：轉呼 `mzstate.py mark --probe $MZHOST`。
- 失敗路徑**不寫標**——標記檔只反映「成功部署過什麼」；半套失敗留給 decide 判 `missing`/`drift`。
- rollback／mzweb-rollback 成功後：**刪除**對應條目（或整檔），讓 decide 回到 `missing`→`NEEDS_DEPLOY`，不留假標。

## 九、開放問題與 SDD 首要實查

- **Q1（SDD Task 1，.70 實查）**：`/etc/ifcfg-sip` 中 `MULTICAST_ADDRESS`（與 port）的確切鍵名/格式/讀寫途徑。背景矛盾：mzscan 當時結論「單槽 config 只在二進位內、欄位恆 unknown」，但 A 驗證實證「工廠單槽改 config 寫 /etc/ifcfg-sip、killall termapp 重讀生效」。實查後：可靠→§六條件 7 照做；不可靠→`singleslot_mc_addr` 留 unknown，條件 7 降級為 warning 並記錄於 spec 修訂（B 部署流程仍主動設定單槽，只是不入 READY 硬條件）。
- **Q2**：`mzstate.py mark` 遠端寫檔的傳輸方式（沿 mzscan 的 SSH/pty 驅動慣例，put tmp＋mv）。實作細節，plan 階段定。
- **Q3**：v2.1.0 的 termapp md5 目前未知——第一次對站內 v2.1.0 機跑 probe 時記錄下來，可加進 manifest 當已知舊版（改善 `NEEDS_FW_UPGRADE` 的 reasons 可讀性；不影響判定正確性，非 v2.1.1 一律 11）。

## 十、測試計畫

- **單元（TDD，unittest，同 mzscan 風格）**：三方比對全 4×狀態矩陣、整機裁決優先序（含多元件混合態 first-match）、marker_stale 自癒路徑、mark 拒絕洗白、SAN/效期驗證（自產測試憑證）、ifcfg-sip 解析、mzscan schema "2" 解析與 unknown schema fail-closed、gen-manifest 缺產物 fail-closed、JSON 報告 schema。
- **真機 `.70`（本地）**：`mark` 補標→`decide --probe` 應 READY（退出碼 0）；篡改任一檔（如 mv mzio）→`DRIFT`/`NEEDS_DEPLOY` 對應正確；刪標記檔→元件 ok＋marker_stale warning 仍 READY；改 ifcfg-sip 單槽→13。
- **tailscale 站內抽測**：v2.1.0 機應回 11；未部署 v2.1.1 機應回 10；混批 `decide --inventory` 彙總正確。
- commit 前照例走 adversarial-reviewer 對抗審查＋`detect_changes()`。

## 十一、與 B 的介面總結（B 子專案的輸入契約）

1. **每台流程**：`mzscan`（或單台 probe）→ `mzstate decide` → 按退出碼分派：0 skip／11 F 流程／10 部署流程／13 config 修復／12 人工佇列／20 重試 → 動作完成後 `decide --probe` re-verify → READY 才計成功。
2. **冪等保證**：decide 無副作用；deploy 動作本身已原子（既有 mzdeploy 機制）；標記檔只在成功後更新；重跑任意次收斂到 READY 或穩定的非 READY 裁決。
3. **機器介面**：退出碼表（§5.2）＋JSON 報告（§5.3）；人讀 `reasons[]` 供彙總報表。

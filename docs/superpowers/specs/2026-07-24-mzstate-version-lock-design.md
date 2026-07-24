# mzstate — side-car 版本標記/冪等判定＋完整性鎖定（新興國小 52 台 rollout 子專案 D＋E）

> 2026-07-24 設計 spec **v2**（v1 經 Codex FAIL＋hermes PASS-WITH-FIXES 雙審後重寫裁決模型與介面契約；審查裁決記錄見 §十二）。上游規劃：`docs/superpowers/PLANNING-2026-07-23-xinxing-52device-rollout.md`。
> D＝版本標記/冪等判定；E＝憑證/config/termapp 完整性鎖定與漂移偵測。兩者共用同一套判定核心與標記檔，合併一份 spec。產出直接被 B（批次編排器）消費。

## 一、目標與範圍

**目標**：讓 B 對 52 台混版 fleet 的每一台，能機器判定「已就緒（skip）／需升韌體（F）／需部署 side-car／config 不就緒／需補標／有人為漂移／探測不完整／不可達」，且整條流程可安全重跑（冪等）。

**交付物**：
1. `docs/multi-zone-poc/src/mzmanifest.json` — desired manifest（repo 端版本真相源）＋產生器。
2. 設備標記檔 `/opt/mzstate.json` 規格＋`mzdeploy.sh` 寫標整合（寫標唯一路徑＝`mzstate.py mark`）。
3. `docs/multi-zone-poc/src/mzstate.py` — 判定核心（純函式庫）＋CLI（退出碼＋`required_actions[]`＝B 契約）。
4. `mzscan.py` 事實欄擴充（schema_version "1"→"2"），含修正單槽 probe（讀 `/etc/ifcfg-sip`）。
5. `mzdeploy.sh` 既有 bug 修復：`status` 的 REST 健檢改設備端 loopback（見 §八）。
6. READY 的機器可判定條件定義（E 的「這台機已就緒」）。

**非目標**：
- B 本體（並發、重試、進度彙總）——本 spec 只定 B 消費的介面與 B 必須遵守的呼叫契約（§十一）。
- F 韌體升級的執行——本 spec 只負責判定出「需要 F」與「韌體版本無法辨識」。
- 自動修復漂移——DRIFT 一律進人工佇列，不自動覆蓋人為改動。
- OmniVox zones 內容的正確性——`/opt/mzzones.json` 是營運資料（OmniVox 為真相源），不入完整性鎖定。
- binary 內嵌版本字串（決策 D1）。
- mzio 自動回退——v1 不支援（`mzdeploy.sh` 本無 `mzio-rollback`；`.prev` 留人工），marker 的 mzio 條目僅由 `mzio-install` 成功路徑與 `mark` 更新。
- marker 簽章/防偽（決策 D7，見下）。

## 二、已拍板決策

| # | 決策 | 理由 |
|---|---|---|
| D1 | **標記檔＋md5 權威**（不做 binary 內嵌版本判定） | mzrelay3/mzweb/mzio 現況零版本字串；.70 等既部署機的舊 binary 永遠回報不了版本；重編＋mzweb GBK patch 雷區成本高。md5 對 build 產物一一對應，即為版本。 |
| D2 | **判定邏輯全在 B 端 Python**（設備上只有被動標記檔） | BusyBox sh 難測難維護；改判定規則免重部署 52 台；與 mzscan 同語言可互 import、同風格 unittest。 |
| D3 | **termapp 鎖 binary md5＋單槽 MULTICAST_* 設定** | 單槽指錯 group＝整台無聲卻各元件「看起來都對」——防斷鏈是 E 的核心目標。**Q1 已於 2026-07-24 真機 .70 實查定案**：`/etc/ifcfg-sip` 為明文 key=value，含 `MULTICAST_ADDRESS=239.192.1.1`、`MULTICAST_PORT=2000`、`MULTICAST_ENABLED=true`，機器可讀可判 → 條件 7 為硬條件。mzscan v1「恆 unknown」係當時 probe 只 grep `/opt`、未讀 `/etc/ifcfg-sip`，schema "2" 修正。 |
| D4 | **憑證驗存在性＋key 權限＋SAN==IP＋未過期；md5 只做漂移 warning** | 每台自簽 SAN=IP、md5 全 fleet 不同，無法鎖統一值；OmniVox 要打 zones REST，SAN 錯＝信任失敗，必驗。重簽屬合法行為，md5 變化不擋 READY。 |
| D5 | 整合形態＝**獨立 mzstate.py**；mzscan 只補事實欄、mzdeploy 只加寫標 | mzscan＝感知、mzstate＝裁決、mzdeploy＝執行；B 依序消費。 |
| D6 | termapp **不入標記檔** | termapp 判定純靠 manifest md5 對照＋DBP 交叉；F 升級免碰標記檔。 |
| D7 | **marker 不做簽章/防偽**（Codex C14 裁決：拒絕） | marker 是輔助判定線索、非授權憑據。偽造 marker（改 binary 又改 marker 湊 md5）的最壞後果＝該元件被判 `outdated` → B 自動部署 desired 版本 → 機器**被收斂回已知良好狀態**（安全方向，非破壞方向）。52 台校內 LAN fleet、root 憑證本就共享的威脅模型下，B 端簽發＋設備身分綁定的簽章體系不合比例。 |
| D8 | **mzstate 拒收 mzscan schema "1"**（hermes F5 裁決：拒絕相容） | schema "1" 缺 D/E 判定必需欄位（marker/單槽/憑證/mzio md5），吃了只會產出資訊不足的裁決去驅動 52 台批次操作。拒收時錯誤訊息明確指示「請以新版 mzscan 重掃」。 |

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
    "S21mzio":    {"path": "/etc/init.d/S21mzio",    "md5": "<repo 檔 md5>"}
  },
  "termapp": {
    "path": "/opt/termapp",
    "known_versions": {"b0eed3b30bd4fa4f1599a9475296fb6d": "2.1.1"},
    "desired_version": "2.1.1"
  },
  "config": {
    "mc_out_group": "239.192.1.1",
    "mc_out_port": 2000
  }
}
```

- **產生器**：`mzstate.py gen-manifest [--release <tag>]` — 讀 build 產物與 repo 內 init scripts 算 md5；`termapp`/`config` 保留手寫值。缺任一 build 產物→退出碼 2、不寫檔（fail-closed）。
- `version` 欄純人讀標籤，**判定一律以 md5 為準**。
- `termapp.known_versions` 是可擴充的 md5↔版本對照表（v2.1.0 md5 第一次對站內機 probe 到就補進來，見 §九 Q3）；mzscan 的內建常數保留當無 manifest 時的 fallback。
- `config.mc_out_group/port`＝termapp 單槽應指向的 mzrelay3 輸出 group。
- manifest 檔的 md5（manifest digest）會被 decide 報告引用，供 B 稽核「這批裁決是對哪版 desired 做的」。

## 四、設備標記檔（`/opt/mzstate.json`）

由 `mzstate.py mark` 寫入（唯一寫入路徑；`mzdeploy.sh` 各 install 成功後轉呼，見 §八）。jffs2 持久、reboot 不失。

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
  "cert": {"crt_md5": "<部署當下 mz.crt md5，可為 null（尚未首開 keygen）>"}
}
```

- **寫入方式**：設備端 tmp（檔名帶 PID）＋`mv` 原子替換＋`sync`。更新期間以 `mkdir /opt/.mzstate.lock` 原子鎖保護 read-modify-write（防禦縱深；主保證是 §十一 B 契約「每台同時只有單一 worker」。lock 目錄存在超過 120s 視為 stale、可打破）。
- **`mark` 語意**（防洗白＋all-or-nothing）：
  1. probe 目標機取實際 md5。
  2. 指定的每個元件都必須 `actual == manifest` 才寫；**任一不符 → 一個條目都不寫**、退出碼 1（all-or-nothing）。
  3. `--components a,b` 只更新指定條目（其餘保留）；預設全部五件。
  4. cert 條目：記 probe 當下 `mz.crt` md5（檔不在記 null，不影響成敗）。
- **讀回防護**：probe 讀 marker 一律 `head -c 8192`＋嚴格 JSON 解析；解析失敗（含被 `===TAG===` 注入截斷、手改壞檔）＝視同 marker 缺。
- termapp 不入標記檔（D6）。

## 五、裁決模型（mzstate.py 核心）

### 5.1 元件級比對（desired / marker / actual 三方，均可缺）

| # | actual | marker 條目 | actual vs desired | actual vs marker | 元件態 | 語意 |
|---|---|---|---|---|---|---|
| 1 | 有 | —（不論） | == | — | `ok` | 就緒（marker 缺/不符時另記 stale，見 §5.2 NEEDS_MARK） |
| 2 | 檔缺 | —（不論） | — | — | `missing` | 需部署（含 rollback 後、被刪檔——一律以重佈收斂） |
| 3 | 有 | 有 | ≠ | == | `outdated` | 我方部署過的舊 release，需更新 |
| 4 | 有 | 有 | ≠ | ≠ | `drift` | 非我方部署的內容（人為動過），需人工 |
| 5 | 有 | **缺** | ≠ | — | `missing` | **無基準線不判 drift**：全新工廠機（原廠 sipweb 等）＝未部署，需部署 |
| 6 | **probe 失敗（md5 讀取錯誤/None）** | — | — | — | `unknown` | 事實不明，fail-closed（→ PROBE_INCOMPLETE，禁一切自動動作） |

**關鍵規則：drift 需要基準線**——只有「該元件有 marker 條目、且 actual 同時 ≠ marker ≠ desired」才判 drift。無 marker 的機器（全新工廠機、rollback 後、標記檔遺失）永不判 drift；此規則使 52 台初次盤點不會整批掉進人工佇列（v1 的 Critical 洞）。

**marker 篡改的含義（D7）**：手改 marker 湊 md5 只能把 `drift` 變 `outdated`，讓 B 自動部署 desired 版本——收斂方向安全，不設防。

### 5.2 整機裁決＋退出碼（B 消費契約）

優先序由上而下，first-match：

| 退出碼 | 裁決 | 觸發條件 | B 的動作 |
|---|---|---|---|
| 20 | `UNREACHABLE` | SSH 探測失敗 | 重試佇列 |
| 21 | `PROBE_INCOMPLETE` | 任一判定必需事實為 `unknown`（md5 讀取失敗、cert 檢查工具缺失等） | 重試 probe；連續失敗進人工佇列。**禁止 F/deploy/mark** |
| 14 | `UNKNOWN_FW` | termapp md5 可讀但無法歸類：不在 `known_versions` 且 DBP 無 `2.1.0` 交叉證據（沿 mzscan `decide_fw_ver()` 語意） | 人工佇列（不明韌體不得自動覆蓋——可能非同產品線/毀損） |
| 11 | `NEEDS_FW_UPGRADE` | fw_ver == "2.1.0"（md5 非已知新版**且** DBP 交叉證實 2.1.0） | 走 F（升韌體＋reboot），完成後重判 |
| 12 | `DRIFT` | 任一 side-car 元件態 = `drift` | 人工佇列（不自動覆蓋） |
| 10 | `NEEDS_DEPLOY` | 任一 side-car 元件態 = `missing`/`outdated` | 走 deploy／mzweb-install／mzio-install，完成後重判 |
| 13 | `NOT_READY_CONFIG` | 元件全 `ok` 但 §六條件 3-7 任一不成立 | config 修復（重啟服務／重簽憑證／改單槽），完成後重判 |
| 15 | `NEEDS_MARK` | §六條件 1-7 全成立，唯 marker 缺／不可解析／條目與 actual 不符（stale） | 執行 `mark`（自帶驗證，安全冪等），完成後重判 |
| 0 | `READY` | §六全部成立 | skip（冪等重跑安全） |
| 2 | usage error | 參數／輸入檔錯誤（含 inventory schema/時效拒收） | 修正呼叫 |

- 優先序理由：探測不完整先於一切裁決（部分事實不得驅動動作）；韌體先於 side-car（F 排 B 部署前）；**DRIFT 先於 NEEDS_DEPLOY**——同機有 drift 元件時整機狀態不可信，不得自動部署其他元件；NEEDS_MARK 墊底＝「其他全對只差標」。
- 憑證 `crt_md5` ≠ marker 記錄值 → `warnings[]`，不影響裁決（D4）。
- **動作後強制重判（防裁決遮蔽）**：11 會遮蔽同機的 12（fw 優先），B 完成任一動作（F/deploy/config/mark）後**必須** `decide --probe` 重判、依新裁決重新分派；**禁止**「F 完成→直接 deploy」的鏈式跳過——F 後重判若揭露 12，該機進人工佇列。

### 5.3 CLI 介面

```
mzstate.py decide --inventory <mzscan.json> --json <out.json> [--manifest mzmanifest.json] [--allow-stale]  # 批次（--json 必填）
mzstate.py decide --probe <ip> [--json out.json] [--manifest mzmanifest.json]                              # 單台（部署後 re-verify）
mzstate.py mark   --probe <ip> [--manifest mzmanifest.json] [--components a,b] [--delete a,b]              # 補標/寫標/刪條目（唯一寫標路徑；--delete 供 rollback 前置）
mzstate.py gen-manifest [--release <tag>]
```

- **inventory 信任前置**：`--inventory` 必驗 `schema_version=="2"`（其他一律退出碼 2，錯誤訊息指示重掃；D8）＋`valid_until` 未過期（過期拒收；`--allow-stale` 顯式豁免、報告加 warning）。報告帶入 `scan_id`、manifest `release`＋digest。
- `--probe` 複用 `mzscan.py` probe（import；同 `MZSCAN_SSH_PW` 慣例、同跳板機執行模型）。
- 批次模式 `--json` 必填且**原子產出完整報告**（任何單台失敗都不缺條目）；批次整體退出碼：全 READY=0，否則 1。單台 `--probe` 模式退出碼＝該台裁決碼；無 `--json` 時 stdout 印一行人讀摘要（`192.168.0.70 READY(0)` / `192.168.0.71 DRIFT(12) mzrelay3: md5 mismatch`），有 `--json` 時完整報告寫檔。
- **JSON 報告 schema**：

```json
{
  "schema_version": "1",
  "manifest_release": "2026-07-24",
  "manifest_digest": "<mzmanifest.json md5>",
  "scan_id": "<入力 inventory 的 scan_id；--probe 模式為 null>",
  "devices": [
    {
      "ip": "192.168.8.140",
      "verdict": "NEEDS_DEPLOY",
      "exit_code": 10,
      "required_actions": ["install_mzweb", "install_mzio"],
      "components": {"mzrelay3": {"state": "ok", "actual_md5": "...", "marker_md5": "..."},
                      "mzweb": {"state": "missing", "actual_md5": "<原廠 sipweb md5>", "marker_md5": null}},
      "checks": {"termapp_fw": "2.1.1", "singleslot_mc": "239.192.1.1:2000", "singleslot_enabled": true,
                 "cert_san_ok": true, "cert_expiry_ok": true, "rest_ok": true,
                 "mzweb_https_ok": true, "relay_running": true, "mzio_running": true},
      "warnings": [], "reasons": ["mzweb: factory web (no marker baseline)"]
    }
  ]
}
```

- **`required_actions[]`（機器可讀，B 的動作依據；B 不得解析 `reasons[]`）**，enum：`fw_upgrade`｜`deploy_mzrelay3`｜`install_mzweb`｜`install_mzio`｜`mark`｜`fix_singleslot`｜`regen_cert`｜`restart_services`｜`manual_review`｜`retry_probe`。由元件態＋checks 決定性導出。
- **checks 值規範**：boolean 型欄位失敗＝`false`；觀測值型欄位（`termapp_fw`、`singleslot_mc`）記**實際觀測值**（判定結論由 verdict/required_actions 表達，不用 "ok"/"mismatch" 魔法字串）；無法取得＝`null`（並使整機落 21）。
- **warnings/reasons 邊界**：`warnings[]`＝不影響本次裁決的非阻塞事項（任何裁決等級皆可有，如 cert md5 漂移、--allow-stale）；`reasons[]`＝導致非 READY 的直接原因（人讀，與 warnings 不重疊）。
- **UNREACHABLE 條目形狀**：`components`/`checks` 為空物件、`required_actions=["retry_probe"]`、`reasons` 帶 ssh 錯誤描述——B 解析不會 KeyError。

## 六、READY 條件（E：「這台機已就緒」機器可判定定義）

條件 1-7 全部成立＋條件 8 → READY；1-7 成立唯 8 不成立 → NEEDS_MARK(15)：

1. termapp md5 ∈ `known_versions` 且對應版本 == `desired_version`（2.1.1）。
2. 五件 side-car actual md5 == manifest。
3. mzrelay3 running 且 **設備端** loopback REST `/get/sip/multicast/zones` 回合法 JSON（沿 mzscan `sidecar_rest_ok` 嚴格解析）。
4. sipweb（mzweb）running 且 `:443` TLS 握手成功。
5. mzio running。
6. 憑證：`mz.crt`＋`mz.key` 存在、key 權限 0600、SAN 含設備 IP、未過期。
7. 單槽：`/etc/ifcfg-sip` 的 `MULTICAST_ADDRESS==mc_out_group` 且 `MULTICAST_PORT==mc_out_port` 且 `MULTICAST_ENABLED=true`（Q1 已實查定案，硬條件）。
8. 標記檔存在、可解析、五件條目 md5 與 actual 一致。

**憑證 SAN/效期驗證機制（具體化）**：B 端 TLS 握手 `getpeercert(binary_form=True)` 取 DER（CERT_NONE 下 `getpeercert()` 回空 dict、不可用），DER 餵跳板機 `openssl x509 -inform DER -noout -checkend 0 -text` 解析 SAN 與效期。**openssl 為跳板機前置需求**：mzstate 啟動時 preflight 檢查，缺 openssl → cert 檢查記 `null` → 該機落 21（fail-closed），不靜默跳過。

**漂移偵測**＝同一套比對的另一面：任何時點重跑 `decide`，元件 `drift`／config 劣化即被抓出。B 部署後 verify、日後例行巡檢，同一 CLI 同一契約。

## 七、事實蒐集（mzscan.py 擴充，schema_version "1"→"2"）

PROBE_CMD 新增段落（沿 `===TAG===` 分段慣例）：

| 新事實欄 | 取法 |
|---|---|
| `mzstate_marker` | `head -c 8192 /opt/mzstate.json`（原文帶回、B 端嚴格解析；缺檔→null） |
| `singleslot_mc_addr` / `singleslot_mc_port` / `singleslot_enabled` | 讀 `/etc/ifcfg-sip` 的 `MULTICAST_ADDRESS`/`MULTICAST_PORT`/`MULTICAST_ENABLED`（**修正 v1 只 grep /opt 的錯誤**） |
| `cert_crt_exists` / `cert_key_exists` / `cert_key_perm` / `cert_crt_md5` | `ls -l`＋`md5sum` |
| `mzio_bin` / `mzio_running` / `mzio_init` | 同現有 sidecar 三欄模式 |
| `mzrelay3_md5` / `mzio_md5` / `s21mzrelay_md5` / `s21mzio_md5` | `md5sum` 各檔 |

- 既有欄位全部保留；probe 個別段落失敗→該欄 `null`＋`errors[]`（既有慣例），由 mzstate 判 21。
- SAN／效期不在 SSH probe 做（設備無 openssl）——B 端 TLS 握手＋跳板機 openssl（§六）。
- **C 工具降級聲明**：mzscan 的 `action` 分類欄自 schema "2" 起**僅供人讀分佈統計**，B 的路由一律以 mzstate verdict 為準（C 的 `classify()` 不看 mzio、其 mzweb 信任 md5 為寫死常數，與 manifest 會脫節）；mzscan 的 `MZWEB_KNOWN_MD5S` 增加可由 `--manifest` 餵入，新 release 不被誤判 unknown。

## 八、mzdeploy.sh 擴充與修復

- **既有 bug 修復（本 spec 範圍）**：`status` 的 REST 健檢現為跳板機直接 `curl http://$MZHOST:8090`（mzdeploy.sh:64）——P7 後 mzrelay3 REST 是 loopback-only bind，遠端必拒，`status`（連帶 `deploy` 尾端健檢）對 P7 設備必失敗。改為設備端 `nc 127.0.0.1:8090` 嚴格 JSON 驗證（同 mzscan `sidecar_rest_ok`）。
- **寫標**：`deploy`／`mzweb-install`／`mzio-install` 成功路徑尾端轉呼 `mzstate.py mark --components <list>`（mark 自帶「actual==manifest 才寫」驗證，即遠端 md5 事後驗證；**無 heredoc fallback**——寫標唯一路徑一條）。mark 失敗（含驗證不符）→ 該 install 動作整體退出非 0，B 依 §5.2 重判。
- **失敗路徑不寫標**；半套失敗由 decide 判 `missing`。
- **rollback 順序（強制，防假 drift／殘標）**：
  1. `rollback`（mzrelay3）：先呼 `mzstate.py mark --delete mzrelay3`（刪條目、原子重寫 marker）→ 刪標失敗即中止、不動 binary → 再 `cp .prev`＋重啟。
  2. `mzweb-rollback`：先 `mark --delete mzweb` → 刪標失敗即中止、**不 reboot** → 再還原 `.orig`＋S20ipgaurd → `sync` → `reboot`。
  3. rollback 後語意：該元件無 marker → 下次 decide 判 `missing` → 10。**B 重佈是 desired-state 收斂、by design**；不想被重佈的機器應從 fleet 清單（`--expect`）移除。

## 九、開放問題

- ~~Q1（單槽 config 可靠性）~~ **已定案**（2026-07-24 .70 實查，見 D3）。
- ~~Q2（mark 遠端寫檔傳輸）~~ **已定案**：沿 `mzctl.py` 既有 pty 驅動 sftp `put` tmp＋`mv`＋`sync`（P0-P8 及 30 台韌體升級已實戰驗證的機制），mark 在 mzstate.py 內 import 同一 driver。
- **Q3**：v2.1.0 的 termapp md5 未知——第一次對站內 v2.1.0 機 probe 時記錄、補進 manifest `known_versions`。**注意**：在補上之前，v2.1.0 機的判定路徑＝md5 不在表內＋DBP 交叉 `2.1.0` → 11（正常升級）；DBP 也拿不到的機 → 14 人工。此為保守設計（C2 裁決），非缺陷。

## 十、測試計畫

- **單元（TDD，unittest，同 mzscan 風格）**：
  - §5.1 六列矩陣全組合（含 `unknown`、無 marker 不判 drift、marker 篡改→outdated）。
  - §5.2 優先序 first-match（多元件混合態；11 遮蔽 12 後動作重判揭露 12；21 壓過一切）。
  - fw 判定：known md5→版本；未知 md5＋DBP 2.1.0→11；未知 md5 無交叉→14；md5 None→21。
  - mark：all-or-nothing（任一不符全不寫）、防洗白、`--delete`、lock 競爭。
  - 報告 schema：UNREACHABLE 形狀、required_actions 導出、checks 值規範、warnings/reasons 邊界。
  - inventory 閘門：schema "1" 拒收、過期拒收、--allow-stale。
  - marker 讀回：8KB 截斷、壞 JSON→視同缺。
  - gen-manifest 缺產物 fail-closed；SAN/效期解析（自產測試憑證餵 openssl 路徑）；ifcfg-sip 解析。
- **真機 `.70`（本地）**：`mark` 補標→`decide --probe` 應 READY(0)；刪標記檔→應 15（非 READY）；篡改 mzio binary（marker 在）→12；mv 走 mzio（missing）→10；改 ifcfg-sip 單槽→13；修復 mzdeploy `status` 後六命令重驗。
- **tailscale 站內抽測**：v2.1.0 機應 11（並記錄其 termapp md5 回填 manifest，Q3）；未部署 v2.1.1 機（原廠 sipweb、無標）**應 10 非 12**（no-marker-no-drift 驗證）；混批 `decide --inventory` 報告完整性。
- commit 前照例走 adversarial-reviewer 對抗審查＋`detect_changes()`。

## 十一、與 B 的介面總結（B 子專案的輸入契約）

1. **每台流程**：`mzscan`（schema "2"、未過期）→ `mzstate decide` → 按 `exit_code`＋`required_actions[]` 分派：0 skip／15 mark／11 F／10 部署／13 config 修復／14、12 人工佇列／20、21 重試佇列 → **每個動作完成後 `decide --probe` 重判、依新裁決重新分派（禁止鏈式跳過）** → READY 才計成功。
2. **B 必須遵守的呼叫契約**：每台同時只有單一 worker（marker RMW 的主保證）；不解析 `reasons[]`（人讀）；不得在 12/14/21 上自動執行部署類動作。
3. **冪等保證**：decide 無副作用；deploy 動作原子（既有 mzdeploy 機制）；mark 驗證後才寫、all-or-nothing；重跑任意次收斂到 READY 或穩定的非 READY 裁決。
4. **機器介面**：退出碼表（§5.2）＋JSON 報告（§5.3，批次必產、含 scan_id/manifest digest 溯源）。

## 十二、v1→v2 審查裁決記錄（Codex FAIL＋hermes PASS-WITH-FIXES）

**採納（v2 已修）**：矩陣補 `unknown`→21 fail-closed（Codex C1）；fw 升級需雙源交叉、未知韌體→14（C2）；marker 缺失語意統一為獨立 15 `NEEDS_MARK`（C3＋hermes F1，取代「READY+warning」）；no-marker-no-drift 規則解工廠機整批誤判 drift（hermes F2 所指之洞，其表述經修正）；rollback 先刪標後動作、失敗中止（C4＋F3/F8）；動作後強制重判防 11 遮蔽 12（F4）；mark all-or-nothing（F6）；寫標唯一路徑＝mark、刪 heredoc（C17/F7）；`required_actions[]` 機器契約（C7）；inventory 時效/信任閘門＋報告溯源（C8）；批次 `--json` 必填（C9）；mzdeploy 遠端 curl :8090 既有 bug 入 scope 修復（C11，已對碼證實）；C `action` 欄降級＋manifest 餵 md5（C12）；SAN 驗證機制具體化 openssl（C13，已證 stdlib 不可行）；marker 讀回 8KB 上限＋嚴格解析（C15）；mzio 無自動回退明文化（C6）；單 worker 契約＋mkdir 鎖（C5）；Q1/Q2 定案入 spec（C18；Q1 以 2026-07-24 真機實查推翻「不可靠」疑慮）；報告細節補全（hermes F9-F12）；Q1 條件耦合明確化（F13）。
**拒絕（附理由）**：marker 簽章（C14→D7：偽造只能導向安全收斂，威脅模型不合比例）；schema "1" 相容（F5→D8：資訊不足的裁決比拒收更危險）；mark 綁 host-key/MAC 身分（C16：mark 寫前必驗 actual==manifest，錯機寫標僅在該機恰好全符 manifest 時發生、此時寫標無害；B 部署動作的 host-key pinning 屬 C/B spec 既有要求，不在 mark 重複）。

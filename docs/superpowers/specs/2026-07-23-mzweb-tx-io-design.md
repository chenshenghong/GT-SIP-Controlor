# mzweb 補 TX + IO 路由 ＋ mzio daemon — 設計 spec（第一版）

> 新興國小 52 台 rollout 子專案（E-mzweb-extend）。日期：2026-07-23。
> 上游文件：`docs/superpowers/HANDOFF-2026-07-23-mzweb-tx-io-extension.md`、`docs/組播發送功能需求單.md`（MTX-01~12）、`docs/IO觸點功能需求單.md`（§3/§5/§6）。
> 已拍板決策（brainstorming 2026-07-23）：
> 1. **IO 觸發 TX 機制＝複用 termapp TX 管線**（寫 `MULTICAST_TX_*`＋sip.sdk；termapp TX 已於 .72 真機驗證可用）。
> 2. **GPIO 監看＝sysfs edge + poll(2)**（純中斷路徑；不做輪詢兜底，真機不支援再回頭）。
> 3. **io_config 真相源＝mzweb REST 唯一寫入口**（web/CMS/OmniVox 都走 `POST /set/io/config`）。

## 一、問題與目標

mzweb（自研 side-car web，取代工廠 web）目前只有接收/zones 路由。裝上設備後工廠 web 消失，設備就失去 TX（組播發送）配置能力，且 IO 觸點功能原廠未交付。本版目標：

1. mzweb 補 `POST /set/multicast/tx` 與兩條 GET 擴充（照組播發送需求單）。
2. mzweb 補 `GET/POST /get|set/io/config`（照 IO 需求單 §5）。
3. 新增 **mzio daemon**（C、arm musl 靜態、比照 mzrelay3）：監看 GPIO、分派動作。第一版只實作 **io1＝GPIO5_5（Linux 45）→ `multicast_ptt`**，其餘 action 佔位。

**非目標（v1 明確不做）**：其餘 10 種 action 的執行（僅 schema 接受＋log 跳過）、輸出模式（output）、MTX-07 仲裁（termapp 職責）、MTX-08 真實狀態檔（/tmp/mcast_tx 由 termapp 落，v1 狀態由 config 推導）、MTX-09 TTL、MTX-10 不落盤 PTT 指令、CMS/OmniVox 端整合。

## 二、元件與資料流

```
device-web 卡片（已完成，在交付包 index.html）
   │ POST /set/multicast/tx          │ GET/POST /get|set/io/config
   ▼                                 ▼
mzweb（webapi.c 擴充）
   ├─ TX：寫 /etc/ifcfg-sip MULTICAST_TX_* ＋ /tmp/sip.sdk set_sip_multicast_tx → termapp 啟停推流
   └─ IO：原子寫 /opt/mzio.json ＋ SIGHUP（/var/run/mzio.pid）通知 mzio
mzio daemon（新 side-car）
   └─ 讀 /opt/mzio.json → export gpio、edge=both → poll(2) 等 POLLPRI
      io1 短接(讀值0，NO/active-low)→ 寫 MULTICAST_TX_ENABLED=true＋sip.sdk → termapp 開始 Mic TX
      io1 放開(讀值1)→ tail_ms 計時到 → ENABLED=false＋sip.sdk → 停止
      即時 state → /tmp/mzio_state（tmpfs JSON，mzweb GET 合併）
```

各單元一句話契約：
- **mzweb TX 路由**：HTTP 進、ifcfg-sip＋sip.sdk 出；不碰音訊。
- **mzweb IO 路由**：HTTP 進、mzio.json＋SIGHUP 出；不碰 GPIO。
- **mzio**：mzio.json＋GPIO 事件進、ifcfg-sip＋sip.sdk＋/tmp/mzio_state 出；不聽 HTTP。

## 三、mzweb TX 路由（MTX-01~03、§2.1/§2.2、MTX-06）

### 3.1 `POST /set/multicast/tx`

- 鑑權：Bearer token 照 mzweb 既有內聯模板（含 `strlen(now_token)-1`）；無/錯 `A003`、過期 `A002`。
- Request 4 欄全必填：`multicast_address`／`multicast_port`／`enabled`／`audio_codec`。
- 驗證：位址第一段 224–239 否則 `E001 非法组播地址`；port 1–65534 否則 `E001 非法组播端口`；缺欄/型別錯 `E001`；`audio_codec` 白名單僅 `G.722` 否則 `E001`。
- **MTX-06 迴授防護**：請求之 位址:埠 與本機 RX（`MULTICAST_ADDRESS`:`MULTICAST_PORT`）相同且 `enabled=true` → 拒絕，回 `E001`。
- 落盤：save_flag 模式——值有變才 `write_keyvalue_file`；4 key `MULTICAST_TX_ADDRESS/PORT/ENABLED/CODEC`，首次讀不到即播種預設 `239.0.0.100/9000/false/G.722`（MTX-01 播種責任由 mzweb 承接，因工廠 web 已被取代）。
- 生效：`/tmp/sip.sdk` 送 `{"command":"set_sip_multicast_tx","cseq":1}\r\n\r\n`，熱生效不重啟。
- Response：`{"status":"success","message":"操作成功","data":{}}`，HTTP 一律 200、`charset=GBK`。
- 路由整合：路徑固定 `/set/multicast/tx`（勿 `/set/sip/multicast_tx`——`/set/sip/multicast` 為其前綴會誤命中）；加入 mzweb dispatch 前先檢查與既有路由無前綴包含關係。

### 3.2 GET 擴充

- `/get/sip/config`：`multicast_config` 之後加 `multicast_tx_config`（4 欄同形；讀 ifcfg-sip，無 key 回預設值）。
- `/get/device/status`：`sip_status` 直接子物件、與 `multicast_status` 同層加 `multicast_tx_status`：`{"status":"发送中"|"关闭","address":"a:p","audio_codec":"G.722"}`；v1 由 `MULTICAST_TX_ENABLED` 推導。
- 兩端點以 cJSON 建構（不手刻 snprintf），驗收整包過 `python3 -m json.tool`。

## 四、mzweb IO 路由（IO 需求單 §3/§5）

### 4.1 `GET /get/io/config`

- 讀 `/opt/mzio.json` 回 `{"io_config":[...]}`；每列合併 `/tmp/mzio_state` 的即時 `state`（無檔或無該腳→0）。Bearer token 同上。

### 4.2 `POST /set/io/config`

- Payload：`{"io_config":[{id,mode,contact,trigger,debounce_ms,action:{type,param}}...]}`。
- 驗證（任一失敗整包拒收 `E001`，不部分套用）：`id` 1–6 不重複；`mode` ∈ input/output/disabled；`contact` ∈ NO/NC；`trigger` ∈ edge/level/long_press；`debounce_ms` 0–200；`action.type` ∈ 需求單 §3.2 的 11 種白名單；`param` 為字串。
- 傳入的 `state`、`gpio` 一律忽略——**gpio 對映由 mzio 端常數表擁有**（見 §5.2），不可經 API 改。
- 落盤：tmp＋rename 原子寫 `/opt/mzio.json`（保留伺服器端 gpio 欄），成功後讀 `/var/run/mzio.pid` 送 SIGHUP（pid 無效/無檔→仍回 success，log 警告；daemon 下次啟動會讀到新檔）。

### 4.3 出廠預設 `/opt/mzio.json`

6 列。**id 編號規則（定案）**：本板絲印為 io0–io5 共 6 路（與需求單那塊 GK7205V300 板的 5 路 id 1–5 不同），`id`＝絲印號＋1（io0→id1、io1→id2、…、io5→id6），`gpio` 欄回報 bank 名；避免 id 0 與需求單 1 起算慣例衝突。
- 有真實對映者：**id2（io1）＝GPIO5_5／Linux 45**、**id3（io2）＝GPIO1_6／Linux 14**（均 2026-07-23 真機差異比對實證；與需求單 GK7205V300 推測表不同，本板為 GK7205V200）。
- 出廠內容：id2（io1）＝`{"gpio":"GPIO5_5","mode":"input","contact":"NO","trigger":"level","debounce_ms":30,"action":{"type":"multicast_ptt","param":"300"}}`；id3（io2）＝`gpio:"GPIO1_6"` 但 `mode:"disabled"`；id1/4/5/6＝`gpio:""`、`mode:"disabled"`。
- daemon 載入規則：跳過 `mode:disabled` 或 gpio 未在對映表者。

## 五、mzio daemon

### 5.1 形態

- 單一 C 檔（`mzio.c`）＋共用 keyvaluefile/cjson_vendor；arm musl 靜態、Docker muslcc 交叉編譯，比照 mzrelay3 的 Makefile 目標（`make arm-mzio`）。
- 單執行緒 poll(2) 事件迴圈：GPIO value fd 集（POLLPRI）＋自管 SIGHUP/SIGTERM volatile 旗標；tail timer 以 poll timeout 實作，無執行緒無 alarm。
- init：S21 風格 script（比照 `S21mzrelay`）部署 `/opt/mzio`，開機自啟；寫 `/var/run/mzio.pid`。

### 5.2 GPIO 對映表（daemon 內建常數，唯一真相）

| 邏輯 id | 絲印 | GPIO | Linux 編號 | 狀態 |
|---|---|---|---|---|
| 1 | io0 | ？ | ？ | 未對映，佔位 |
| 2 | io1 | GPIO5_5 | 45 | ✅ 實證 |
| 3 | io2 | GPIO1_6 | 14 | ✅ 實證（v1 不啟用） |
| 4–6 | io3–io5 | ？ | ？ | 未對映，佔位 |

### 5.3 GPIO 監看（決策 2）

- 啟動/SIGHUP 重載：對每個啟用的 input 腳——export（已 export 容忍 EBUSY）→ `direction=in` → `edge=both`。**`edge` 寫入失敗＝該腳標故障、log ERROR、不啟用（不退輪詢）**；部署 .70 首要驗證此點。
- 事件：POLLPRI → lseek(0)＋read 值 → 起 debounce 窗（該腳 `debounce_ms`，預設 30）→ 窗到再讀一次，兩讀一致且異於上次穩定值 → 視為狀態變化。
- 極性：實體「短接」＝讀值 0（active-low、有上拉，實證）。`contact:NO`→短接=作動；`contact:NC`→反轉。

### 5.4 `multicast_ptt` 動作（決策 1；IO-03/IO-04 精神）

- 作動（press）：寫 `MULTICAST_TX_ENABLED=true` 到 `/etc/ifcfg-sip`（keyvaluefile；只動該 key）→ sip.sdk `set_sip_multicast_tx`。位址/埠/codec 沿用 `MULTICAST_TX_*` 現值（即 web 卡片所設）。
- 釋放（release）：起 tail timer（`action.param` ms，預設 300）→ 到期寫 `ENABLED=false`＋sip.sdk。tail 未到又 press → 取消停止、維持推流（不重送 start）。
- sip.sdk connect/write 失敗：重試 1 次，仍失敗 log ERROR、放棄本次（不阻塞事件迴圈；socket 操作皆帶短 timeout，符合 IO-04「事件路徑不卡網路 I/O」精神）。
- **開機歸零**：daemon 啟動時若 `MULTICAST_TX_ENABLED=true` 且本機有 `multicast_ptt` 綁定 → 寫回 `false`＋sip.sdk（防斷電時按住、重開機誤持續推流）。
- 其餘 10 種 action.type：接受配置，觸發時 log `action not implemented` 跳過。

### 5.5 state 回報

- 每次穩定狀態變化，全表寫 `/tmp/mzio_state`（tmpfs，JSON `{"1":0,"2":1,...}` 以邏輯 id 為 key）；mzweb GET 合併。滿足需求單「state ≤1 秒反映」。

## 六、取捨與風險（已知、v1 接受）

| 風險 | 說明 | 對策 |
|---|---|---|
| flash 磨損 | 每次 PTT 寫 /etc/ifcfg-sip 2 次 | v1 接受（校園喊話低頻）；後續路徑＝MTX-10 不落盤指令（需韌體）或 daemon 自建送流 |
| edge 不支援 | 純中斷路徑單點風險 | 部署 .70 第一件事驗證；失敗則回頭補輪詢兜底（設計已預留腳級故障標記） |
| mzweb/mzio 併發寫 ifcfg-sip | 兩寫者理論競態 | v1 不加鎖；操作規範「PTT 使用中不改 web TX 設定」；兩者都走同一 keyvaluefile 寫法 |
| termapp 啟停延遲 | 實測 ~2 秒內 | 需求單即為此標準，可接受；PTT 體感由 tail 與提示音（未來）緩解 |
| websetsip-p7.patch GBK+CRLF | 不可用 Edit 工具改 | 本次只動 mzweb 自有 C 檔，不碰該 patch |

## 七、測試計畫

- **host 單元測試**（比照 mzweb `tests/`，純函式抽離）：TX 欄位驗證（位址/port/codec/迴授防護）、io_config schema 驗證（整包拒收語意）、mzio 去抖＋tail 狀態機（press/release/re-press 序列表格測試）、mzio.json 解析與佔位列跳過。
- **建置**：`make arm-mzweb`、`make arm-mzio` 交叉編譯通過；若動 device-web 需重生 `web_index_gz.h`（本版預期不動）。
- **真機 .70 驗收**（交接檔清單）：
  1. `POST /set/multicast/tx` 200；`192.168.1.1`→`E001 非法组播地址`；port 0/65535→`E001 非法组播端口`；無 token→`A003`；TX==RX 位址:埠→`E001`。
  2. `/get/sip/config` 出現 `multicast_tx_config`、`/get/device/status` 出現 `multicast_tx_status`，整包過 `python3 -m json.tool`。
  3. web 設好 TX 位址→io1 短接→另一端（.72 或 mztone）收到 .70 Mic 聲；放開→tail 300ms 後停。
  4. `GET/POST /get|set/io/config` 正常；POST 後 SIGHUP 重載生效免重啟；`state` 短接時變 1（NO 作動語意）≤1 秒。
  5. daemon 重開機自啟；開機 ENABLED 歸 false。

## 八、實作順序（供 writing-plans 展開）

1. mzweb TX 路由＋GET 擴充（含單元測試）。
2. mzweb IO 路由＋mzio.json 預設檔（含 schema 測試）。
3. mzio daemon（GPIO 迴圈＋ptt 狀態機＋state 檔）。
4. 交叉編譯＋部署 .70＋真機驗收（先驗 edge 支援）。

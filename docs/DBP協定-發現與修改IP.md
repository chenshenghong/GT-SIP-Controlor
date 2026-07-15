# DBP/1.0 協定 — 設備發現 & 修改 IP

> **分析來源（v2 已抓包實證）**：`QueryTool.exe` v5.0.9.L 反組譯 + **tcpdump 實機抓包**（2026-07-15，對真機 GT-SIP-GW v2.1.0 由原廠工具連續改 IP／多欄位，並以本專案重寫後的 CMS 端到端實測改 IP 成功）。
>
> ⚠️ **本文 v1 的核心結論全部錯誤，已於 v2 推翻**：v1 說「傳輸層是 TCP、請求行 `SET DBP/1.0`、埠號未知」——實測證實**傳輸是 UDP 廣播、請求行以 MAC 定址、設備根本沒有任何 DBP TCP listener**。請以本 v2 為準。

---

## 零、一句話

設備發現與改 IP **都走 UDP 廣播到 `255.255.255.255:58001`**（同一通道）。改 IP 靠**請求行的 MAC 定址** + **廣播**，因此**免路由、可跨網段**——這正是原廠工具能對「不同網段」設備改 IP 的原因，TCP 做不到（需 L3 路由可達）。

---

## 一、傳輸層（發現與 SET 共用）

| 項目 | 實測值 |
|------|--------|
| 傳輸層 | **UDP 廣播**（非 TCP） |
| 目標 | `255.255.255.255 : 58001` |
| 來源埠 | 工具綁一個 ephemeral port（如 55603 / 57586），設備**廣播回覆到該來源埠** |
| 定址 | 靠封包內容（GET 廣播問全部；SET 請求行帶目標 MAC，設備自我過濾） |
| 跨網段 | ✅ 廣播免路由，主機／設備網段不同也送得到 |

> **全埠掃描實證（1–65535）**：真機只開 `tcp/80`、`tcp/443`（REST，:80→301→:443 自簽憑證）、`tcp/9521`（內嵌 SSH）、`tcp/9611`（連得上但不回話）。**沒有任何 DBP TCP listener。** 舊 `ipChanger.ts` 用 TCP unicast 連 `DBP_PORT_CANDIDATES` 猜測埠，永遠 ECONNREFUSED。

> **多網卡送出策略（v2.1，抓包實證）**：CMS 不只送 limited broadcast `255.255.255.255`（多網卡主機上 OS 只從**預設路由網卡**送出，會漏掉其他網卡網段的設備），而是列舉每張非內部網卡、對各自的 subnet-directed broadcast（如 `192.168.0.255`、`192.168.1.255`）逐一送出，由路由表導到正確網卡，涵蓋所有網卡網段（`routeManager.getBroadcastTargets()`，discovery 與改 IP 共用）。實測 `.184`（enp5s0=0.x 為預設路由、enp4s0=1.x）：新版對 `192.168.1.255` 送出走 enp4s0，成功找到並回覆 1.x 網段的兩台設備；舊版只送 `255.255.255.255`（走 enp5s0）則漏掉它們。
>
> ⚠️ **已知限制**：兩張網卡在**完全相同**網段時，Node `dgram` 無法對廣播指定出口介面，只會走路由挑中的那一張。生產環境極罕見。

---

## 二、設備發現（GET）

**請求（廣播）：**
```
GET DBP/1.0\r\n
CSeq: <n>\r\n
IFCFG-APP:<base64>\r\n        ← {"key_name":["RegAddr","ServerPort",...,"PTT","COR","ROLE"]}
IsBroadcast: 1\r\n
\r\n
```

**回應（設備 → 廣播:來源埠，`Key: Value` 逐行）：**
```
DBP/1.0 200 OK\r\nCSeq: <n>\r\n
GROUP / CAP / VOL / AGC / ID / Type / Ver / Name / MAC / IP / Mask / Gateway /
Server / Server2 / DNS1 / DNS2 / UseDNS / AutoIP / IPGUARD_VER / IFCFG-APP / Mode
```
- `IFCFG-APP`（回應）為 base64 JSON，含 `RegAddr/ServerPort/RegUser/RegPswd/OutVol/MicVol/ConnectMode/PTT/COR/ROLE/...`。
- ⚠️ 回應**不含** `Encrypt`／`Treble`／`Bass`（見下）。

---

## 三、修改 IP／設定（SET）

**請求（廣播，純 ASCII、無二進位前綴）：**
```
<現ID> <Type> <MAC> DBP/1.0\r\n     ← 請求行：以「現有 ID + MAC」定址設備
CSeq: <n>\r\n
Type: <t>\r\n
ID: <新ID>\r\n                       ← 內文帶「要寫入的新值」
IP: <新IP>\r\n
Mask: <遮罩>\r\n
Gateway: <閘道>\r\n
Server: <ip:port>\r\n
Server2: <ip:port>\r\n
IsBroadcast: 1\r\n
UseDNS: 0\r\n
AutoIP: <0靜態/1DHCP>\r\n
Treble: 0\r\n
Bass: 0\r\n
Encrypt: 1\r\n
Name: <名稱>\r\n
GROUP: <組號>\r\n
AGC: <自適應音量>\r\n
VOL: <播放音量>\r\n
CAP: <麥克風音量>\r\n
IFCFG-APP: <base64>\r\n              ← {"COR":"0","PTT":"0","ROLE":"0","key_name":["PTT","COR","ROLE"]}
Reboot: 1\r\n                        ← 觸發重啟套用
\r\n
```

**回應：** `DBP/1.0 200 OK\r\nCSeq: <n>\r\n\r\n`（設備從**舊 IP** 回覆，約 4ms 內；重啟後才換新 IP）。CSeq 用來配對請求/回應。

### 三大關鍵規則（抓包實證）

1. **請求行「舊身份」定址、內文「新值」寫入**：請求行 `ID` 是設備**當前**的 ID（＋MAC），用來找設備；內文 `ID:` 是要寫入的**新** ID。改 ID 時兩者不同（實測 `1005 ... DBP/1.0` 請求行 vs `ID: 101` 內文）。
2. **完整回填**：SET 帶上設備**整組現有設定**（Server/Server2/Name/GROUP/VOL/CAP/AGC…），只覆蓋使用者實際變更的欄位——避免改一個設定卻清掉其他設定。
3. **DNS 永不出現**：原廠工具**沒有 DNS 欄位**，SET 封包**從不帶** `DNS1`/`DNS2`（即使設備 GET 回應有 DNS）。DNS 屬設備上線後的 REST 管理範疇，不走 DBP。

### 欄位來源對照（工具 UI → 封包）

| 工具 UI | 封包欄位 | 備註 |
|---|---|---|
| 设备 ID | `ID` | 內文＝新值；請求行＝舊值(定址) |
| IP 地址 / 子网掩码 / 默认网关 | `IP` / `Mask` / `Gateway` | |
| 广播服务器 / 备用服务器 | `Server` / `Server2` | `ip:port` |
| 组号 | `GROUP` | |
| 播放音量(PLAY) | `VOL` | |
| Mic音量(CAP) | `CAP` | |
| 自适应音量(AGC) | `AGC` | |

### 工具固定常數（非來自設備）

`UseDNS: 0`、`Treble: 0`、`Bass: 0`、`Encrypt: 1`、`IsBroadcast: 1`、`Reboot: 1`、`IFCFG-APP: {COR,PTT,ROLE}`。

設備 GET **不回報** `Encrypt/Treble/Bass`，故工具永遠送這三個字面值（`1/0/0`）。本 CMS 亦硬編碼相同值以忠實重現。若未來有別型號設備會在 GET 回報這些，再改為「有回報就 echo」。

---

## 四、本專案實作對應

- **傳輸與封包建構**：`src/main/ipChanger.ts`（UDP 廣播 SET，完整回填，match CSeq 判成功）。
- **發現與欄位解析**：`src/main/dbpDiscover.ts`（含 PTT/COR/ROLE，供 SET 回填）。
- **請求型別**：`IpChangeRequest` 帶整個 `device: DeviceNode`；經 IPC 前需 `JSON.parse(JSON.stringify(device))` 深拷貝（Vue reactive proxy 無法 structured clone）。
- **CMS 改 IP 範圍**：只改 `IP/Mask/Gateway/AutoIP`，其餘欄位從 discovery 原樣回填（專職改 IP，非全設定編輯器）。

---

## 五、驗收（已通過）

- ✅ 三次抓包（.149→.150→.151 逐一、.70、多欄位 ID/Server/音量）皆對照無誤。
- ✅ CMS 端到端實測：改 IP → 設備回 200 OK(相同 CSeq) → 重啟上到新 IP → ping 0% 丟包、ARP 正確。
- ✅ 本 CMS 產出的 SET 封包與原廠工具**位元組結構一致**（僅 CSeq 序號與 IFCFG-APP 之 JSON 排版差異，語意等價、韌體接受）。

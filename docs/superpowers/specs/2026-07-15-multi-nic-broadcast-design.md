# 多網卡自動廣播（DBP 發現 + 改 IP）— 設計

> 日期：2026-07-15 ｜ 狀態：已核准，待實作
> 相關：`docs/DBP協定-發現與修改IP.md`（DBP 協定實證）

## 1. 問題

DBP 的兩條 active 路徑都用 UDP **limited broadcast**（`255.255.255.255:58001`）：
- `src/main/dbpDiscover.ts` — 設備發現（App.vue 觸發）
- `src/main/ipChanger.ts` — 改設備 IP / SET（IpChangeModal 觸發）

在**多網卡主機**上，作業系統對 `255.255.255.255` 通常只從**預設路由那一張網卡**送出。因此：
- 掛在「非預設路由網卡」網段上的設備 **掃不到、也改不了 IP**。
- 實例：測試機 `.184` 有兩張實體網卡（`enp5s0`=192.168.0.184 為預設路由、`enp4s0`=192.168.1.203）。舊行為只送 `255.255.255.255` → 只走 enp5s0 → `192.168.1.x` 網段的設備漏掉。

`detectLocalNetwork()` 另有「只挑第一張非內部網卡」的問題，但它現在只影響 REST 掃描的預設網段（次要），不在本輪範圍。

## 2. 目標與非目標

**目標**：DBP 發現與改 IP 在多網卡主機上自動涵蓋**所有網卡**的網段，使用者零設定。

**非目標（本輪不做）**：
- UI 選網卡 / 設定 store（採「自動涵蓋全部」策略，免選）。
- `detectLocalNetwork()` 改動。
- `scanner.ts`（TCP-DBP）、`taskServerClient.ts` 死碼清除 —— 另開一輪（impact 顯示牽動 4 個 IPC handler + 5 個 preload API + routeManager route 函式）。

## 3. 方案

不再只送 limited broadcast，改為**列舉本機每張非內部 IPv4 網卡、算出各自的 subnet-directed broadcast 位址，逐一送出**。路由表會把每個 directed broadcast 導到對應的正確網卡，等於自動涵蓋所有網卡——免綁介面、免使用者選。

收包 socket 維持綁 `0.0.0.0`（本就收得到所有網卡的廣播回覆），不需改動。

### 3.1 新增共用 helper（`src/main/routeManager.ts`）

```ts
/**
 * Broadcast targets for DBP send: limited broadcast + every non-internal IPv4
 * interface's subnet-directed broadcast (e.g. 192.168.0.255, 192.168.1.255).
 * On a multi-NIC host the OS sends 255.255.255.255 out only ONE interface, so
 * directed broadcasts (routed per-subnet to the correct NIC) are what actually
 * reach devices on every NIC's segment.
 */
export function getBroadcastTargets(): string[]
```

實作要點：
- 來源 `os.networkInterfaces()`；對每個 `addr`，條件 `family==='IPv4' && !internal && addr.netmask`。
- directed broadcast = 逐 octet `(ipOctet | (~maskOctet & 0xff))`。
- 結果集合：`255.255.255.255` + 各 directed broadcast，**去重**（`Set`）。
- 跳過我方自加的別名 IP（沿用 `addedAliases` 既有排除邏輯，避免對別名網段重複送）——與現有 `detectLocalNetwork`/`allLocalIfaces` 一致。

放 `routeManager.ts` 的理由：網卡列舉/別名排除邏輯已集中在此檔，避免散落。

### 3.2 `src/main/dbpDiscover.ts`

`blast()` 由「送一個 `255.255.255.255`」改為對 `getBroadcastTargets()` 每個位址各送一次：

```ts
const targets = getBroadcastTargets()
const blast = () => {
  if (settled) return
  for (const t of targets) sock.send(REQUEST, DBP_PORT, t, () => { /* ignore */ })
}
```
其餘（收包 parse、去重、timeout、重送節奏）不變。

### 3.3 `src/main/ipChanger.ts`

SET 的 `blast()` 同樣改為對每個 target 各送一次（sender 內已 `setBroadcast(true)`）。CSeq 配對、200 OK 判定、timeout 不變。

## 4. 資料流

```
getBroadcastTargets()  →  ['255.255.255.255','192.168.0.255','192.168.1.255']
        │
   dbpDiscover.blast() / ipChanger.blast()
        │  對每個 target sock.send(...)
        ▼
   OS 路由：192.168.1.255 → enp4s0 ；192.168.0.255 → enp5s0 ；255.255.255.255 → 預設 NIC
        ▼
   各網段設備收到 → 廣播回覆到來源埠
        ▼
   收包 socket（0.0.0.0:ephemeral）收到所有網段回覆
```

## 5. 錯誤處理 / 邊界

- **無網卡 / 全 internal**：`getBroadcastTargets()` 至少回 `['255.255.255.255']`（保底，行為不劣於現況）。
- **重複 directed broadcast**（多網卡同網段）：`Set` 去重，只送一次。
- **同網段雙網卡（不同實體段）**：**已知限制**。Node `dgram` 無法對廣播指定出口介面，送到共同 directed broadcast 只會走路由挑中的那一張。極罕見、生產環境不存在；會註記於 `docs/DBP協定-發現與修改IP.md` 與程式碼註解。
- **send 失敗**：沿用現有 fire-and-forget（callback 忽略錯誤）；單一 target 失敗不影響其他 target。

## 6. 測試 / 驗證

- **單元**：`getBroadcastTargets()` 對給定 interface 表算出正確 directed broadcast + 去重 + 保底。（若無現成測試框架，至少以 node 腳本驗證計算。）
- **真機端到端（.184）**：
  1. 設備現於 `192.168.1.101`（enp4s0 網段，非主機預設路由網段）。
  2. tcpdump 抓包確認 discovery/SET 有送到 `192.168.1.255` 且走 enp4s0。
  3. 確認設備回 200 OK、discovery 能列出該設備——即修復舊版會漏掉的情境。
  4. 迴歸：`192.168.0.x` 網段設備（.148）仍正常。

## 7. 影響範圍（GitNexus）

- 改動 symbol：`getBroadcastTargets`（新增）、`dbpDiscover` 內 blast、`changeDeviceIp` 內 blast。
- 上游：`dbpDiscover` ← DBP_DISCOVER handler；`changeDeviceIp` ← CHANGE_IP handler。皆 LOW risk、行為增強（送更多 target），不改介面簽章。

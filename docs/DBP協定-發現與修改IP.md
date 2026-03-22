# DBP/1.0 協定 — 設備發現 & 修改 IP

> 分析來源：`QueryTool.exe` v5.0.9.L 字串反組譯 + `config.ini`

---

## 一、設備發現協定

### 通訊方式

| 項目 | 說明 |
|------|------|
| **傳輸層** | TCP Socket（QTcpSocket） |
| **連線方式** | 逐台 IP 嘗試 `connectToHost(ip, port)` |
| **掃描範圍** | 自動偵測本機網段 或 手動輸入 IP 範圍 |
| **內建預設** | IP `192.168.1.10`、遮罩 `255.255.255.0`、閘道 `192.168.1.1` |

### 協定格式

**發送（查詢請求）：**
```
GET DBP/1.0
```

**接收（設備回應）— `Key: Value` 純文字逐行回傳：**
```
DBP/1.0 200 OK
CSeq: 1
ID: %d
Type: %s
Ver: %s
MAC: %s
IP: %s
Mask: %s
Gateway: %s
Server: %s:%d
Server2: %s:%d
DNS1: %s
DNS2: %s
Website: %s
UseDNS: %d
AutoIP: %d
Reboot: %s,%d
SN: %s
Mode: %s
IsBroadcast: %d
Speed: %d
SvcConfig: %s
Name: %s
Treble: %d
Bass: %d
TbAgc: %d
TbLinein: %d
Encrypt: %d
LocalSet: %d,%d,%d,%d
PlayVol: %d
CaptureVol: %d
UpdateAll: %d
ResetAll: %d
VOL: %d
CAP: %d
AGC: %d
GROUP: %d
IFCFG-APP: %s
Group: %d
HostName: %s
```

### 流程

```
1. 決定 IP 範圍（如 192.168.1.1 ~ 192.168.1.254）
2. 對每個 IP 執行 TCP connect
3. 連線成功 → 發送 "GET DBP/1.0"
4. 讀取回應 → sscanf 逐行解析 "Key: %s" 格式
5. 連線失敗/逾時 → 跳過，掃下一台
```

> ⚠️ **TCP 目標埠號**在 exe 中未找到明確的硬編碼值，需從實際抓包確認。

---

## 二、修改 IP 協定

### 協定格式

**發送（設定請求）：**
```
SET DBP/1.0
```

搭配要修改的網路參數欄位（推測格式與 GET 回應對稱）：

```
IP: 192.168.1.200
Mask: 255.255.255.0
Gateway: 192.168.1.1
AutoIP: 0
```

其中 `AutoIP: 0` 表示切換為手動 IP（DHCP 關閉）。

### 相關欄位

| 欄位 | 格式 | 說明 |
|------|------|------|
| `IP` | `%s` | 新 IP 位址 |
| `Mask` | `%s` | 子網路遮罩 |
| `Gateway` | `%s` | 閘道 |
| `AutoIP` | `%d` | 0=手動 / 1=DHCP |
| `DNS1` | `%s` | DNS 1（可選） |
| `DNS2` | `%s` | DNS 2（可選） |

### 回應格式

```
DBP/1.0 200 OK
```

### 觸發函數鏈（exe 中提取）

```
set_terminal()  →  透過 setTcpSocket 連線  →  slot_setOnConnected()
                →  發送 SET DBP/1.0 + 參數  →  slot_setOnTcpRead() 接收確認
```

---

## 注意事項

1. **TCP 埠號**：exe 中未見硬編碼埠號，建議用 Wireshark 抓包確認。
2. **SET Body 格式**：GET 解析用 `sscanf("IP: %s", ...)`，合理推測 SET 發送也是對稱的 `"IP: 192.168.1.200\n"` 純文字格式，但需抓包驗證。
3. **SET 命令可能需附帶** `CSeq` 序列號和設備 `MAC` 來定位目標設備。

# Multi-zone Side-car PoC — 程式碼

GT-SIP-GW 組播多監聽區（multi-zone）**自研 side-car** 概念驗證程式碼。
完整評估與計畫見上層 [`docs/組播多監聽區-自研可行性評估與PoC計畫.md`](../組播多監聽區-自研可行性評估與PoC計畫.md)。

> 狀態：P0–P2 + P3 核心（2026-07-21）＋ **P4 規模/重啟/codec** ＋ **P5 REST 控制面＋device-web 對接**（2026-07-22）已在真機 `192.168.0.70`（Goke GK7205V200 / OHLinux 4.9.37）驗證通過。P4 數據：16 區 VmRSS 44KB / CPU ≈0.6%；reboot 自動恢復；G.722/G.711U PT 透傳混切 relay 面全過；現場聽測定案：**termapp 按 `MULTICAST_CODEC` config 解碼、不理 PT**，G.722/G.711U 皆原生支援、全環境統一單一 codec 即可。P5：mzrelay3 真實 IGMP join＋自帶 REST `:8090`，device-web 真頁面「載入 16 區→儲存→免重啟熱套用→GET 一致」閉環實測通過。**P7（2026-07-22）**：自建 **mzweb**（相容層＋原廠 websetsip 源碼最小 patch）收攏控制面到 `:80`——19 路由 200+JSON+GBK、內嵌頁、zones 轉呼 mzrelay3 loopback、reboot 自啟全數真機通過；現場發現並順帶修好 .70 的 **rogue-hbi_web 缺陷**（原 `/etc/sipweb/sipweb` 是只回 403 的空殼）。詳見 [`p7-acceptance.md`](p7-acceptance.md)。mzweb 源碼在 `src/mzweb/`。

## 檔案

| 檔案 | 說明 |
|---|---|
| `src/mzrelay.c` | **P1** 單區透明中繼：join 一個組播 group（或收單播 port）→ 原樣轉發 RTP 到 termapp 聽的 group。證明 side-car 可透明插在 termapp 前。 |
| `src/mzrelay2.c` | **P2** 多區優先權仲裁：監聽 N 區、只轉發最高優先權 active 區（單流不混音）、高優先權即時搶佔、靜默逾時恢復；**對外 RTP header 重寫**（固定 SSRC / 連續 seq-ts / 切換 marker）讓 termapp 看到單一連續流。 |
| `src/mztone.c` | 設備**本機** RTP G.722 送流器：讀 raw G.722，按 20ms/160B 打 RTP（50pps, PT9）送 UDP，供零丟包測試源。 |
| `src/mzctl.py` | 佈署 helper：透過 root SSH（`root@:9521`，pty 餵密碼 `BcastTerm2`）put 檔案 / 執行命令 / 背景啟動。 |
| `src/mzrelay3.c` | **P5** 產品形態雛形：16 區表存 `/opt/mzzones.json`、**真實 IGMP join**、自帶 REST（zones GET/POST＋E001 驗證＋佔位列規則＋`/auth/login` Bearer＋CORS）、POST 熱套用 re-join 免重啟、原子持久化；同優先權先到先播。 |
| `src/S21mzrelay` | **P4/P5** 開機自啟 init 腳本（放 `/etc/init.d/`；rcS 不帶參數呼叫→預設 start，guarded＋背景化不阻塞開機；現拉 mzrelay3）。 |
| `src/mzrelay.conf.example` | **P4** mzrelay2 版 conf 範例（16 區 port 列表，保留供重現 P4 壓測）。 |
| `src/mzrelay3.conf.example` | **P5** mzrelay3 版 conf（放 `/opt/mzrelay.conf`：`dst_grp dst_port ttl ifaddr silence_ms rest_port zones.json`）。 |
| `src/p4scale.sh` | **P4** 16 區規模壓測腳本（輪播覆蓋＋搶佔＋RSS/fd/CPU 量測，裝置端執行）。 |
| `src/p4codec.sh` | **P4** codec 邊界測試腳本（G.722 基線／純 G.711U／混用搶佔，盯 termapp 存活）。 |

## 交叉編譯（macOS + Docker，靜態非 PIE armv7）

```bash
cd src
docker run --rm --platform linux/amd64 -v "$PWD":/src -w /src --entrypoint gcc \
  muslcc/x86_64:arm-linux-musleabi -march=armv7-a -static -no-pie -fno-pie -O2 -o mzrelay  mzrelay.c
# 同法編 mzrelay2.c / mztone.c
file mzrelay   # → ELF 32-bit LSB executable, ARM, statically linked
```
> 用 musl 靜態繞過設備 uClibc 版本相依，**免原廠 SDK**。

## 佈署與執行（測試機 `192.168.0.70`）

```bash
# 佈署
python3 src/mzctl.py put mzrelay2 /tmp/mzrelay2

# P2 兩區示例：zone port5001 prio2（低）、port5002 prio1（高）→ termapp group 239.192.1.1:2000
python3 src/mzctl.py bg '/tmp/mzrelay2 239.192.1.1 2000 16 192.168.0.70 2000 5001 2 5002 1'

# 設備本機零丟包送流
python3 src/mzctl.py bg '/tmp/mztone /tmp/z2low.g722 127.0.0.1 5001 1 22'   # 低優先 loop
python3 src/mzctl.py sh '/tmp/mztone /tmp/emerg.g722 127.0.0.1 5002 0 5'    # 高優先 5s 插播

# 觀察仲裁 log（SWITCH / SILENT 事件）
python3 src/mzctl.py sh 'cat /tmp/mz.log'
```

測試音源用 macOS `say` + `ffmpeg` 產生（raw G.722）：
```bash
say -v Meijia -o z2low.aiff "區域二，優先權低。一，二，三，四，五。"
ffmpeg -i z2low.aiff -ar 16000 -ac 1 -f g722 z2low.g722
```

## 命令列

- `mzrelay  <src_grp> <src_port> <dst_grp> <dst_port> [ttl] [ifaddr]`（src 非組播則不 join、收單播）
- `mzrelay2 <dst_grp> <dst_port> <ttl> <ifaddr> <silence_ms> <zone_port> <zone_prio> [<zone_port> <zone_prio> ...]`（prio 小=高）
- `mztone   <payload_file> <dst_ip> <dst_port> [loop:1|0] [dur_sec:0=inf] [pt:9]`（pt 0＝G.711U/PCMU raw mulaw；預設 9＝G.722）

## 持久部署（P4.2 驗證過的開機自啟）

```bash
python3 src/mzctl.py put src/mzrelay3 /opt/mzrelay3                # /opt 在 jffs2，活得過斷電（/tmp 是 tmpfs 重啟即清）
python3 src/mzctl.py put src/mzrelay3.conf.example /opt/mzrelay.conf
python3 src/mzctl.py put src/S21mzrelay /etc/init.d/S21mzrelay
python3 src/mzctl.py sh 'chmod +x /opt/mzrelay3 /etc/init.d/S21mzrelay; sync'
# 16 區表之後全走 REST 管理（/opt/mzzones.json 由 mzrelay3 自行持久化）：
#   瀏覽器開 device-web/index.html，設備位址填 http://<device>:8090 登入即可
```

## 佈署自動化與維運 runbook（P6）

一鍵腳本 `src/mzdeploy.sh`（mac 端，經 mzctl.py root SSH；`MZHOST` 可換設備）：

```bash
./mzdeploy.sh status     # 健康檢查：程序 + 檔案完整性 + REST zones 摘要
./mzdeploy.sh deploy     # 佈署/升級 mzrelay3（既有版自動備份 .prev；zones 設定不動）
./mzdeploy.sh rollback   # 還原 .prev 前版並重啟 daemon
./mzdeploy.sh redeploy   # 災難重佈（整包 rom 升級把 /opt 抹掉後）
```

**原廠韌體升級共存**（實測依據：升級=替換 `/opt/termapp`+reboot，見 firmware SSH 升級 memory）：

| 升級方式 | 對 side-car 影響 | 處置 |
|---|---|---|
| **app 替換**（只換 `/opt/termapp`） | `/opt/mzrelay3`、`/opt/mzzones.json`、`/etc/init.d/S21mzrelay` 皆不受影響；reboot 後 S21 照常拉起 | 免動作；升級後跑 `./mzdeploy.sh status` 確認即可。若原廠升級重置 termapp 的組播收聽 group，對齊 `/opt/mzrelay.conf` 的 dst 參數 |
| **整包 rom**（rootfs 重刷） | 三檔全滅（含 zones 表） | 升級**前**備份：`python3 mzctl.py sh 'cat /opt/mzzones.json' > mzzones.backup.json`；升級後 `./mzdeploy.sh redeploy`，再 put 回 mzzones.json 或經 device-web 重新配置 |

已實測：`killall + rm /opt/mzrelay3` 模擬抹除 → `deploy` 一鍵恢復、zones 設定完好；`rollback` 還原 `.prev` 後 daemon 正常、REST 回報一致。

## 後續（見評估文件 §六）
P4–P6 全部完成。真實部署剩：G.711U 現場聽覺確認、（可選）REST token 產品化（隨機 token/對接原廠帳號體系）、與原廠需求單路線的取捨決策（評估文件 §八）。真實部署各區改 IGMP join 真實組播 group（取代 PoC 的單播 port），termapp 改聽專屬中繼 group（改 config 一個值、非改 binary）。

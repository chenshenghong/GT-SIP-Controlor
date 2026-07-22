# Multi-zone Side-car PoC — 程式碼

GT-SIP-GW 組播多監聽區（multi-zone）**自研 side-car** 概念驗證程式碼。
完整評估與計畫見上層 [`docs/組播多監聽區-自研可行性評估與PoC計畫.md`](../組播多監聽區-自研可行性評估與PoC計畫.md)。

> 狀態：P0–P2 + P3 核心（2026-07-21）＋ **P4 規模/重啟/codec**（2026-07-22）已在真機 `192.168.0.70`（Goke GK7205V200 / OHLinux 4.9.37）驗證通過。P4 數據：16 區 VmRSS 44KB / CPU ≈0.6%；reboot 自動恢復；G.722/G.711U PT 透傳混切 relay 面全過（G.711U 出聲待現場聽覺確認）。

## 檔案

| 檔案 | 說明 |
|---|---|
| `src/mzrelay.c` | **P1** 單區透明中繼：join 一個組播 group（或收單播 port）→ 原樣轉發 RTP 到 termapp 聽的 group。證明 side-car 可透明插在 termapp 前。 |
| `src/mzrelay2.c` | **P2** 多區優先權仲裁：監聽 N 區、只轉發最高優先權 active 區（單流不混音）、高優先權即時搶佔、靜默逾時恢復；**對外 RTP header 重寫**（固定 SSRC / 連續 seq-ts / 切換 marker）讓 termapp 看到單一連續流。 |
| `src/mztone.c` | 設備**本機** RTP G.722 送流器：讀 raw G.722，按 20ms/160B 打 RTP（50pps, PT9）送 UDP，供零丟包測試源。 |
| `src/mzctl.py` | 佈署 helper：透過 root SSH（`root@:9521`，pty 餵密碼 `BcastTerm2`）put 檔案 / 執行命令 / 背景啟動。 |
| `src/S21mzrelay` | **P4** 開機自啟 init 腳本（放 `/etc/init.d/`；rcS 不帶參數呼叫→預設 start，guarded＋背景化不阻塞開機）。 |
| `src/mzrelay.conf.example` | **P4** 16 區設定範例（放 `/opt/mzrelay.conf`，內容即 mzrelay2 的完整參數列）。 |
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
python3 src/mzctl.py put src/mzrelay2 /opt/mzrelay2                # /opt 在 jffs2，活得過斷電（/tmp 是 tmpfs 重啟即清）
python3 src/mzctl.py put src/mzrelay.conf.example /opt/mzrelay.conf
python3 src/mzctl.py put src/S21mzrelay /etc/init.d/S21mzrelay
python3 src/mzctl.py sh 'chmod +x /opt/mzrelay2 /etc/init.d/S21mzrelay; sync'
```

## 後續（見評估文件 §六）
P5 config+device-web 對接、P6 韌體升級共存+佈署自動化+維運（開機自啟已在 P4.2 完成）。真實部署各區改 IGMP join 真實組播 group（取代 PoC 的單播 port），termapp 改聽專屬中繼 group（改 config 一個值、非改 binary）。

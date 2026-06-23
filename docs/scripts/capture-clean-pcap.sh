#!/usr/bin/env bash
# =============================================================
# 產生「乾淨、可被 Wireshark 開啟」的標準 pcap 抓包
# (注意：Windows 的 pktmon 匯出的 pcapng 非標準、封包不完整，請勿使用)
# 在「與設備同網段的 Linux 主機」執行（需 root / sudo）：
#   sudo bash capture-clean-pcap.sh 192.168.0.147
# 產出 /tmp/device_http_clean.pcap，用 Wireshark 開、Follow TCP Stream
# 可見一半回應 Server: lgw_web (200)、一半 Server: hbi_web (403)。
# =============================================================
IP="${1:-192.168.0.147}"
OUT="/tmp/device_http_clean.pcap"
IFACE=$(ip route get "$IP" | grep -oP 'dev \K\S+' | head -1)
echo "抓包介面=$IFACE  目標=$IP (同網段直連, 無代理)"

rm -f "$OUT"
tcpdump -i "$IFACE" -s 0 -w "$OUT" "host $IP and tcp port 80" 2>/dev/null &
TPID=$!
sleep 1
ok=0; bad=0
for i in $(seq 1 20); do
  code=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' --max-time 6 "http://$IP/get/device/volume" 2>/dev/null)
  if [ "$code" = "200" ]; then ok=$((ok+1)); else bad=$((bad+1)); fi
  sleep 0.3
done
sleep 1
kill -INT "$TPID" 2>/dev/null; sleep 1
chmod 644 "$OUT" 2>/dev/null
echo "curl 直連結果: 200=$ok  非200=$bad"
echo "封包數 $(tcpdump -nr "$OUT" 2>/dev/null | wc -l) , 檔案 $OUT"
echo "設備回的 Server 標頭:"
tcpdump -nr "$OUT" -A 2>/dev/null | tr -dc '[:print:]\n' | grep -oE 'Server: (lgw_web|hbi_web)_1\.0\.1' | sort | uniq -c

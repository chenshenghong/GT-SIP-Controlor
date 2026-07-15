#!/bin/bash
# macOS：雙擊即可在「終端機」啟動測試代理（若無法雙擊，先 chmod +x 本檔）
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "[錯誤] 找不到 Node.js，請先安裝 LTS 版：https://nodejs.org/"
  read -n1 -r -p "按任意鍵關閉…"
  exit 1
fi

read -r -p "請輸入設備 IP（直接按 Enter 使用 192.168.0.146）: " IP
IP="${IP:-192.168.0.146}"
PORT=8080

echo
echo "============================================================"
echo " 代理啟動中…"
echo " 瀏覽器開：http://localhost:${PORT}/"
echo " 登入頁「設備位址」留空，帳密 admin / 123456"
echo " 停止：按 Ctrl + C，或直接關閉這個視窗"
echo "============================================================"
echo
node dev-proxy.mjs "$IP" "$PORT"

echo
echo "（代理已結束）"

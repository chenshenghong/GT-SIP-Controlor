#!/bin/sh
# ─────────────────────────────────────────────────────────────────────
# make-embed.sh — 把 ../index.html 壓成 gzip 並產生可 #include 的 C 標頭
#   產出：web_index_gz.h  (static const unsigned char web_index_gz[] + _len)
#   韌體端 #include 後，由 request_get_index() 直接回傳（見 serve_index.c）。
#
# 用法：  sh make-embed.sh
#   每次 index.html 有更新，重跑一次、覆蓋 web_index_gz.h、重新編譯韌體即可。
#   gzip -n 不寫入檔名/時間戳 → 相同輸入產生相同輸出（可重現）。
# 需求：  gzip、xxd（vim 內附）
# ─────────────────────────────────────────────────────────────────────
set -e
here=$(cd "$(dirname "$0")" && pwd)
src="$here/../index.html"
out="$here/web_index_gz.h"

[ -f "$src" ] || { echo "找不到 $src"; exit 1; }

tmpd=$(mktemp -d)
trap 'rm -rf "$tmpd"' EXIT

# 1) gzip（-9 最高壓縮、-n 去掉名稱/時間戳以利可重現）
gzip -9 -n -c "$src" > "$tmpd/web_index_gz"
gzlen=$(wc -c < "$tmpd/web_index_gz" | tr -d ' ')

# 2) xxd -i 產生 C 陣列（在 tmpd 內執行 → 陣列名稱乾淨為 web_index_gz）
body=$( cd "$tmpd" && xxd -i web_index_gz )

# 3) 加上 include guard 與 const，組成最終標頭
{
  echo "/* 自動產生 by make-embed.sh — 請勿手動編輯。來源：device-web/index.html */"
  echo "/* 內容：gzip 壓縮的設備內建管理網頁；解開即為完整 HTML（UTF-8）。      */"
  echo "#ifndef WEB_INDEX_GZ_H"
  echo "#define WEB_INDEX_GZ_H"
  echo "$body" \
     | sed 's/^unsigned char web_index_gz\[\]/static const unsigned char web_index_gz[]/' \
     | sed 's/^unsigned int web_index_gz_len/static const unsigned int web_index_gz_len/'
  echo "#endif /* WEB_INDEX_GZ_H */"
} > "$out"

rawlen=$(wc -c < "$src" | tr -d ' ')
echo "✓ 產生 $out"
echo "  原始 HTML : ${rawlen} bytes"
echo "  gzip 後   : ${gzlen} bytes"

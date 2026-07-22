#!/bin/sh
# 在 x86_64 linux 容器內執行 build/test_* 全部（musl 靜態，alpine 可跑）。
# 任一 build/test_* 或 http_test.py 失敗（含二進位缺檔的 FileNotFoundError）→ 整腳本非零退出。
# test_webapi 排除出 for-loop：它是阻塞 server，由 http_test.py 內部 Popen 啟動。
cd "$(dirname "$0")/.." || exit 1
exec docker run --rm --platform linux/amd64 -v "$PWD":/src -w /src python:3.12-alpine sh -c '
  rc=0
  for t in build/test_*; do
    [ -x "$t" ] || continue
    case "$t" in build/test_webapi) continue;; esac
    echo "== $t"
    if ! "$t"; then echo "FAIL: $t"; rc=1; fi
  done
  if [ -f tests/http_test.py ]; then
    echo "== tests/http_test.py"
    if ! python3 tests/http_test.py; then echo "FAIL: tests/http_test.py"; rc=1; fi
  fi
  [ "$rc" -eq 0 ] && echo "ALL HOST TESTS PASSED" || echo "HOST TESTS FAILED"
  exit "$rc"
'

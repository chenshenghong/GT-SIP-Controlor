#!/bin/sh
# 在 x86_64 linux 容器內執行 build/test_* 全部（musl 靜態，alpine 可跑）。
# 任一 build/test_* 或 *_test.py 失敗（含二進位缺檔的 FileNotFoundError）→ 整腳本非零退出。
# test_webapi / test_webapi_tls 排除出 for-loop：兩者皆為阻塞 server（event_loop_run），
# 分別由 http_test.py / https_test.py 內部 Popen 啟動並驅動，直接跑會卡死 loop。
cd "$(dirname "$0")/.." || exit 1
exec docker run --rm --platform linux/amd64 -v "$PWD":/src -w /src python:3.12-alpine sh -c '
  rc=0
  for t in build/test_*; do
    [ -x "$t" ] || continue
    case "$t" in build/test_webapi|build/test_webapi_tls) continue;; esac
    echo "== $t"
    if ! "$t"; then echo "FAIL: $t"; rc=1; fi
  done
  if [ -f tests/http_test.py ]; then
    echo "== tests/http_test.py"
    if ! python3 tests/http_test.py; then echo "FAIL: tests/http_test.py"; rc=1; fi
  fi
  if [ -x build/mzweb-x86 ] && [ -f tests/test_txio_routes.py ]; then
    echo "== tests/test_txio_routes.py"
    if ! python3 tests/test_txio_routes.py; then echo "FAIL: tests/test_txio_routes.py"; rc=1; fi
  fi
  if [ -x build/mzweb-x86 ] && [ -f tests/test_txio_settx.py ]; then
    echo "== tests/test_txio_settx.py"
    if ! python3 tests/test_txio_settx.py; then echo "FAIL: tests/test_txio_settx.py"; rc=1; fi
  fi
  if [ -x build/mzweb-x86 ] && [ -f tests/test_txio_io.py ]; then
    echo "== tests/test_txio_io.py"
    if ! python3 tests/test_txio_io.py; then echo "FAIL: tests/test_txio_io.py"; rc=1; fi
  fi
  if [ -x build/test_webapi_tls ] && [ -f tests/https_test.py ]; then
    echo "== tests/https_test.py"
    if ! python3 tests/https_test.py; then echo "FAIL: tests/https_test.py"; rc=1; fi
  fi
  if [ -x build/test_webapi_tls ] && [ -f tests/redirect_test.py ]; then
    echo "== tests/redirect_test.py"
    if ! python3 tests/redirect_test.py; then echo "FAIL: tests/redirect_test.py"; rc=1; fi
  fi
  [ "$rc" -eq 0 ] && echo "ALL HOST TESTS PASSED" || echo "HOST TESTS FAILED"
  exit "$rc"
'

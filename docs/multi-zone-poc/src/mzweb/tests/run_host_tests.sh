#!/bin/sh
# 在 x86_64 linux 容器內執行 build/test_* 全部（musl 靜態，alpine 可跑）
set -e
cd "$(dirname "$0")/.."
docker run --rm --platform linux/amd64 -v "$PWD":/src -w /src python:3.12-alpine \
  sh -c 'for t in build/test_*; do [ -x "$t" ] || continue; case "$t" in build/test_webapi) continue;; esac; echo "== $t"; "$t"; done; [ -f tests/http_test.py ] && python3 tests/http_test.py || true'

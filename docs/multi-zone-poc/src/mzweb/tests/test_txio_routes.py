#!/usr/bin/env python3
"""Task 2 整合測試：txio_inject.py 注入的 3 條新路由（/set/multicast/tx、/get/io/config、
/set/io/config）已掛入 build/websetsip.c 的 dispatch，且過 mzweb_check_token token gate。

在 musl 容器內執行：
  make x86-mzweb
  docker run --rm --platform linux/amd64 -v "$PWD":/src -w /src \
      python:3.12-alpine python3 tests/test_txio_routes.py

啟動/login 模式照 test_zones.py 複製：websetsip 啟動要讀 /etc/ifcfg-eth0 的 SN
（缺檔/缺 SN 會 return，靜默不啟動）；/etc/ifcfg-sip 缺檔時 init_sip_web_set_svr
自建預設（WEB_USER=admin / WEB_PASSWORD=123456）。login 回應為 GBK body 且 token
尾帶未跳脫換行 \\n（REFERENCE.md §四.3 off-by-one）→ 不可用嚴格 utf-8 json.loads，
改以 latin1 解位元組＋strict=False 寬鬆解析；token 為純 ASCII hex，strip() 去尾
換行後才是 32 字元有效 token。

六斷言（brief Step 1）：
  1. 無 token POST /set/multicast/tx → HTTP 401、body 含 "A003"
  2. 無 token GET  /get/io/config    → HTTP 401、body 含 "A003"
  3. 無 token POST /set/io/config    → HTTP 401、body 含 "A003"
  4. 帶有效 token POST /set/multicast/tx（任意 body）→ HTTP 200、body 含 "success"（stub）
  5. 不存在路由 GET /no/such → 404（dispatch 未破壞既有 fallthrough）
  6. 既有路由仍活：帶 token GET /get/sip/config → 200（迴歸）
"""
import subprocess, time, urllib.request, urllib.error, json, sys

# fixtures：websetsip 啟動要讀 /etc/ifcfg-eth0 的 SN（缺檔/缺 SN 會 return，靜默不啟動）。
open("/etc/ifcfg-eth0", "w").write("SN=P7TEST\n")
# /etc/ifcfg-sip 缺檔時 init_sip_web_set_svr 自建預設（WEB_USER=admin / WEB_PASSWORD=123456）。

p = subprocess.Popen(["build/mzweb-x86"])
time.sleep(1)


def login():
    req = urllib.request.Request(
        "http://127.0.0.1:80/auth/login",
        data=json.dumps({"username": "admin", "password": "123456"}).encode())
    raw = urllib.request.urlopen(req, timeout=5).read()
    b = json.loads(raw.decode("latin1"), strict=False)   # GBK body + 未跳脫 \n → 寬鬆解析
    tok = (b.get("token") or b.get("data", {}).get("token") or "")
    return tok.strip()   # 去尾換行 → 32 字元 hex


try:
    tok = login()
    assert tok and len(tok) == 32, repr(tok)
    H = {"Authorization": "Bearer " + tok}

    # 1) 無 token POST /set/multicast/tx → 401 + A003
    req = urllib.request.Request("http://127.0.0.1:80/set/multicast/tx", data=b'{}')
    try:
        urllib.request.urlopen(req, timeout=5)
        raise AssertionError("expected 401")
    except urllib.error.HTTPError as e:
        assert e.code == 401, e.code
        assert b"A003" in e.read()
    print("[1] no-token POST /set/multicast/tx -> 401 A003 OK")

    # 2) 無 token GET /get/io/config → 401 + A003
    try:
        urllib.request.urlopen("http://127.0.0.1:80/get/io/config", timeout=5)
        raise AssertionError("expected 401")
    except urllib.error.HTTPError as e:
        assert e.code == 401, e.code
        assert b"A003" in e.read()
    print("[2] no-token GET /get/io/config -> 401 A003 OK")

    # 3) 無 token POST /set/io/config → 401 + A003
    req = urllib.request.Request("http://127.0.0.1:80/set/io/config", data=b'{}')
    try:
        urllib.request.urlopen(req, timeout=5)
        raise AssertionError("expected 401")
    except urllib.error.HTTPError as e:
        assert e.code == 401, e.code
        assert b"A003" in e.read()
    print("[3] no-token POST /set/io/config -> 401 A003 OK")

    # 4) 帶有效 token POST /set/multicast/tx（任意 body）→ 200 + success（stub）
    req = urllib.request.Request("http://127.0.0.1:80/set/multicast/tx", data=b'{}', headers=H)
    raw = urllib.request.urlopen(req, timeout=5).read()
    assert b"success" in raw, raw
    print("[4] with-token POST /set/multicast/tx -> 200 success OK")

    # 5) 不存在路由 GET /no/such → 404（dispatch 未破壞既有 fallthrough）
    try:
        urllib.request.urlopen("http://127.0.0.1:80/no/such", timeout=5)
        raise AssertionError("expected 404")
    except urllib.error.HTTPError as e:
        assert e.code == 404, e.code
    print("[5] unknown route /no/such -> 404 OK")

    # 6) 既有路由仍活：帶 token GET /get/sip/config → 200（迴歸）
    req = urllib.request.Request("http://127.0.0.1:80/get/sip/config", headers=H)
    resp = urllib.request.urlopen(req, timeout=5)
    assert resp.status == 200, resp.status
    print("[6] existing route GET /get/sip/config still 200 OK")

    print("txio_routes OK")
except Exception:
    sys.stdout.flush()
    raise
finally:
    p.kill()

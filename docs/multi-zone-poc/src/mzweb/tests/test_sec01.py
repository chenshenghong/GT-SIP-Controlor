#!/usr/bin/env python3
"""T5 SEC-01 容器測試：6 個原廠免 token GET（/get/device/status、/get/device/volume、
/get/sip/config、/get/call/status、/get/network/config、/system/info）改為需 Bearer token，
重用 T7(P7) 已定義的 mzweb_check_token（zones 路由同款）。

在 musl 容器內執行：
  make x86-mzweb
  docker run --rm --platform linux/amd64 -v "$PWD":/src -w /src \
      python:3.12-alpine python3 tests/test_sec01.py

編碼/狀態碼備註（與 test_zones.py 一致）：
  - login body 是 GBK + token 尾帶未跳脫 \\n（REFERENCE.md §四.3 off-by-one）→ latin1 解位元組
    ＋ json.loads(strict=False)，token strip() 後才是 32 字元 hex。
  - mzweb_check_token 驗證失敗時**恆送 HTTP 401**（非原廠舊路由的恆 200 慣例——見 P7 patch
    內 mzweb_check_token 註解：zones/此處重用同一驗證閘門，故失敗一律走 401 + body 內 A003 JSON，
    非 200）。故無 token 案例需以 HTTPError 撈 body；帶 token（驗證通過）案例才會落回各 handler
    原本的恆 200 行為。
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


PATHS = ["/get/device/status", "/get/device/volume", "/get/sip/config",
         "/get/call/status", "/get/network/config", "/system/info"]

try:
    tok = login()
    assert tok and len(tok) == 32, repr(tok)
    H = {"Authorization": "Bearer " + tok}

    for path in PATHS:
        # 無 token → mzweb_check_token 擋下，401 + body 含 A003
        try:
            urllib.request.urlopen("http://127.0.0.1:80" + path, timeout=5)
            raise AssertionError(f"{path} 無 token 未擋")
        except urllib.error.HTTPError as e:
            assert e.code == 401, (path, e.code)
            body = e.read().decode("latin1")
            assert "A003" in body, f"{path} 無 token 未擋: {body[:80]}"

        # 帶 token → 驗證通過，落回原 handler（恆 200，body 不含 A003）
        req = urllib.request.Request(
            "http://127.0.0.1:80" + path, headers=H)
        b2 = urllib.request.urlopen(req, timeout=5).read().decode("latin1")
        assert "A003" not in b2, f"{path} 帶 token 仍擋: {b2[:80]}"

    assert p.poll() is None, "server died"
    print("sec01 OK")
except Exception:
    sys.stdout.flush()
    raise
finally:
    p.kill()

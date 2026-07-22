#!/usr/bin/env python3
"""S-T11 整合測試：跑「真正的」build/mzweb-x86（非 test_webapi_tls 假殼），驗證
init_sip_web_set_svr 的完整開機流程——憑證 bootstrap + 同時起 :443(TLS) 與 :80(301 gate)。

在 musl/alpine 容器內執行（需 root 綁 :80/:443 特權埠）：
  make x86-mzweb
  docker run --rm --platform linux/amd64 -v "$PWD":/src -w /src \
      python:3.12-alpine python3 tests/test_integration.py

驗證鏈（brief Step 2）：
  1) 開機時 mzcert_ensure 產出 /etc/sipweb/mz.{crt,key}（key 權限 0600）。
  2) https(:443) login → 取得 32 字元 hex token。
  3) https(:443) GET /get/device/status 帶 Bearer token → 200（落回 handler，body 不含 A003）。
  4) http(:80) GET → 301 Moved Permanently + Location: https://… + 安全標頭（X-Frame-Options）。

編碼備註（同 test_sec01.py）：login body 為 GBK + token 尾帶未跳脫 \\n（off-by-one）→
latin1 解位元組 + json.loads(strict=False)，token strip() 後才是 32 字元 hex。
"""
import subprocess, time, ssl, socket, os, stat, urllib.request, urllib.error, json, sys

CRT = "/etc/sipweb/mz.crt"
KEY = "/etc/sipweb/mz.key"
DEV_IP = "127.0.0.1"   # 連本機；device_ip 讀自 /etc/ifcfg-eth0 IPADDR → 憑證 SAN=IP

# --- fixtures：init_sip_web_set_svr 讀 /etc/ifcfg-eth0 的 SN（缺→靜默不啟動）與 IPADDR
#     （S-T11：憑證 SAN 用）。mzcert 寫檔前 /etc/sipweb 目錄須存在。 ---
os.makedirs("/etc/sipweb", exist_ok=True)
# 全新開機情境：確保無殘留憑證，逼 mzcert_ensure 真正自簽（驗證 keygen bootstrap）。
for f in (CRT, KEY):
    try: os.remove(f)
    except FileNotFoundError: pass
open("/etc/ifcfg-eth0", "w").write("SN=P7TEST\nIPADDR=%s\nNETMASK=255.255.255.0\nGATEWAY=127.0.0.1\n" % DEV_IP)

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE
https = urllib.request.build_opener(urllib.request.HTTPSHandler(context=ctx))


def wait_tls_ready(port=443, timeout=30):
    """輪詢等 :443 就緒——首開 RSA-2048 keygen 在容器內需數秒；init 同步完成後才起 loop。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection((DEV_IP, port), timeout=2) as s:
                with ctx.wrap_socket(s, server_hostname=DEV_IP):
                    return True
        except Exception:
            time.sleep(0.5)
    return False


def https_login():
    req = urllib.request.Request(
        "https://%s:443/auth/login" % DEV_IP,
        data=json.dumps({"username": "admin", "password": "123456"}).encode())
    raw = https.open(req, timeout=8).read()
    b = json.loads(raw.decode("latin1"), strict=False)
    tok = (b.get("token") or b.get("data", {}).get("token") or "")
    return tok.strip()


p = subprocess.Popen(["build/mzweb-x86"])
try:
    assert wait_tls_ready(), "TLS :443 未在時限內就緒（keygen/bootstrap 失敗？）"

    # 1) 憑證 bootstrap：mzcert_ensure 已自簽產檔，私鑰 0600。
    assert os.path.exists(CRT) and os.path.exists(KEY), "憑證未產生"
    mode = stat.S_IMODE(os.stat(KEY).st_mode)
    assert mode == 0o600, "私鑰權限非 0600: %o" % mode
    print("bootstrap OK: cert self-signed, key mode 0600")

    # 2) https login → token
    tok = https_login()
    assert tok and len(tok) == 32, "https login token 異常: %r" % tok
    print("https login OK: token=%s..." % tok[:8])
    H = {"Authorization": "Bearer " + tok}

    # 3) https GET 帶 token → 200，落回 handler（body 不含 A003）
    req = urllib.request.Request("https://%s:443/get/device/status" % DEV_IP, headers=H)
    r = https.open(req, timeout=8)
    body = r.read().decode("latin1")
    assert r.status == 200, "https GET 非 200: %s" % r.status
    assert "A003" not in body, "https GET 帶 token 仍被擋: %s" % body[:80]
    # 無 token → 401 + A003（驗證閘門仍生效）
    try:
        https.open("https://%s:443/get/device/status" % DEV_IP, timeout=8)
        raise AssertionError("https GET 無 token 未擋")
    except urllib.error.HTTPError as e:
        assert e.code == 401 and b"A003" in e.read(), "無 token 未回 401/A003"
    print("https GET(with token) OK: 200; no-token -> 401")

    # 4) http :80 → 301 → https + 安全標頭（用原始 socket 直接看 301，不跟隨轉址）
    with socket.create_connection((DEV_IP, 80), timeout=5) as s:
        s.send(b"GET /get/device/status HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n" % DEV_IP.encode())
        d = b""
        while True:
            ch = s.recv(4096)
            if not ch: break
            d += ch
    assert b"301 Moved Permanently" in d, ("預期 301: %r" % d[:120])
    assert b"Location: https://" in d and b"/get/device/status" in d, ("Location 缺 https/path: %r" % d[:200])
    assert b"X-Frame-Options: SAMEORIGIN" in d, ("301 缺安全標頭: %r" % d[:200])
    print("http :80 -> 301 https OK: %s" % d.split(b"\r\n", 1)[0].decode("latin1"))

    assert p.poll() is None, "server died"
    print("integration OK")
except Exception:
    sys.stdout.flush()
    raise
finally:
    p.kill()

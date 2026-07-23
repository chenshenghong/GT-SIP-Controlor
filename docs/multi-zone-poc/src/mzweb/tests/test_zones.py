#!/usr/bin/env python3
"""P7 T7 容器測試：patched websetsip.c（zones 轉呼＋GET / 內嵌頁）＋相容層 = build/mzweb-x86。

在 musl 容器內執行：
  make x86-mzweb
  docker run --rm --platform linux/amd64 -v "$PWD":/src -w /src \
      python:3.12-alpine python3 tests/test_zones.py

六斷言（見下）。編碼備註（與 smoke_orig.py 一致）：原廠 login/舊路由回應是 **GBK** body，
且 login token 尾帶未跳脫換行 \\n（REFERENCE.md §四.3 off-by-one）→ 不可用嚴格 utf-8
json.loads。故 login 與舊路由回應改以 latin1 解位元組（永不失敗）＋ strict=False 寬鬆解析；
token 為純 ASCII hex，strip() 去尾換行後才是 32 字元有效 token（mzweb_check_token 逐字
複製原廠 len == strlen(now_token) - 1 比對）。zones 回應由假 mzrelay3 送出（純 ASCII JSON），
一般解析即可。"""
import subprocess, time, urllib.request, urllib.error, json, sys

# fixtures：websetsip 啟動要讀 /etc/ifcfg-eth0 的 SN（缺檔/缺 SN 會 return，靜默不啟動）。
open("/etc/ifcfg-eth0", "w").write("SN=P7TEST\n")
# /etc/ifcfg-sip 缺檔時 init_sip_web_set_svr 自建預設（WEB_USER=admin / WEB_PASSWORD=123456）。

relay = subprocess.Popen(["python3", "tests/fake_mzrelay3.py"])
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

    # 1) GET zones 需 token：無 token → mzweb_check_token 回 401（zones 為受權 API，用真實 HTTP 狀態）
    try:
        urllib.request.urlopen("http://127.0.0.1:80/get/sip/multicast/zones", timeout=5)
        raise AssertionError("expected auth error")
    except urllib.error.HTTPError as e:
        assert e.code == 401, e.code   # 真機已實證：無 token 回 401

    # 2) GET zones 帶 token → 轉呼 mzrelay3 成功，16 筆
    r = json.loads(urllib.request.urlopen(
        urllib.request.Request("http://127.0.0.1:80/get/sip/multicast/zones", headers=H),
        timeout=5).read())
    assert len(r["zones"]) == 16, r

    # 3) POST zones 帶 token → echo 回 16
    req = urllib.request.Request(
        "http://127.0.0.1:80/set/sip/multicast/zones",
        data=json.dumps({"zones": [{"zone_id": i + 1} for i in range(16)]}).encode(),
        headers=H)
    r = json.loads(urllib.request.urlopen(req, timeout=5).read())
    assert r["status"] == "success" and r["echo_zones"] == 16, r

    # 4) 前綴碰撞：舊 /set/sip/multicast 不可誤入 zones handler。
    #    無 termapp → 舊 handler 走自身邏輯（回 GBK 錯誤 body，恆 HTTP 200），關鍵是回應內
    #    「絕不含 echo_zones」（那是 zones handler/假 relay 的專屬欄位）。直接在原始位元組上判斷，
    #    避免 GBK body 觸發 json 解碼例外。
    req = urllib.request.Request("http://127.0.0.1:80/set/sip/multicast", data=b'{}', headers=H)
    try:
        raw = urllib.request.urlopen(req, timeout=5).read()
        assert b"echo_zones" not in raw, "prefix collision! old route hit zones handler"
    except urllib.error.HTTPError as e:
        assert b"echo_zones" not in e.read(), "prefix collision! old route hit zones handler"

    # 5) GET / → 內嵌頁（gzip HTML，Content-Encoding: gzip）
    resp = urllib.request.urlopen("http://127.0.0.1:80/", timeout=5)
    assert resp.headers.get("Content-Encoding") == "gzip" and len(resp.read()) > 1000

    # 6) mzrelay3 離線 → 503 且不 crash（且不寫任何檔）
    relay.kill()
    time.sleep(0.3)
    try:
        urllib.request.urlopen(urllib.request.Request(
            "http://127.0.0.1:80/get/sip/multicast/zones", headers=H), timeout=10)
        raise AssertionError("expected 503")
    except urllib.error.HTTPError as e:
        assert e.code == 503, e.code
    assert p.poll() is None, "server died"

    print("zones OK")
except Exception:
    sys.stdout.flush()
    raise
finally:
    p.kill()
    relay.poll() is None and relay.kill()

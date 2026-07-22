#!/usr/bin/env python3
"""T6 整合閘門 smoke：未修改原廠 websetsip.c ＋ 自研相容層（T1–T5）連編出的
build/mzweb-x86-orig，在 musl 容器內起服務、跑三條關鍵路徑，確立「相容層行為基準」。

在 python:3.12-alpine（musl）容器內執行：
  docker run --rm --platform linux/amd64 -v "$PWD":/src -w /src \
      python:3.12-alpine python3 tests/smoke_orig.py

斷言以「實際容器執行的原廠碼回應」為準（非假設的 JSON 形狀）——實測要點：
  1) 原廠**恆回 HTTP 200 OK**，錯誤以 body 內 error_code 表示（非 HTTP 4xx/5xx）。
     故 /get/call/status 不會拋 HTTPError；改以「回得來＋body 帶 E008＋server 存活」斷言。
  2) login body 是 **GBK** 編碼（message 含中文），且 token 尾帶未跳脫的換行 \\n
     （REFERENCE.md §四.3 的 off-by-one）→ 不能用嚴格 utf-8 json.loads：
     以 latin1 解位元組（永不失敗）＋ json.loads(strict=False)（容許控制字元），
     token 為純 ASCII hex，strip() 去尾換行後才是 32 字元的有效 token。
  3) verify 比對 strlen(now_token)-1 → Bearer 必須帶 strip 後的 32 hex（見 websetsip.c:456）。
"""
import subprocess, time, urllib.request, urllib.error, json, sys

# fixtures：websetsip 啟動要讀 /etc/ifcfg-eth0 的 SN（缺檔/缺 SN 會 return，靜默不啟動）。
open("/etc/ifcfg-eth0", "w").write("SN=P7TEST\n")
# /etc/ifcfg-sip 缺檔時 init_sip_web_set_svr 自建預設（WEB_USER=admin / WEB_PASSWORD=123456）。

p = subprocess.Popen(["build/mzweb-x86-orig"])
time.sleep(1)
try:
    # 1) 登入拿 token（預設 admin/123456）。走相容層：webapi 解析 + cjson parse + keyvaluefile 讀帳密。
    req = urllib.request.Request(
        "http://127.0.0.1:80/auth/login",
        data=json.dumps({"username": "admin", "password": "123456"}).encode(),
    )
    raw = urllib.request.urlopen(req, timeout=5).read()
    body = json.loads(raw.decode("latin1"), strict=False)   # GBK body + 未跳脫 \n → 寬鬆解析
    assert body.get("status") == "success", raw
    token = (body.get("token") or body.get("data", {}).get("token") or "").strip()
    assert token and len(token) == 32, (repr(token), raw)

    # 2) 帶 token 的 verify（相容層 get_http_head 擷取 Authorization）。原廠恆回 200；斷言 body 為 success。
    req = urllib.request.Request(
        "http://127.0.0.1:80/auth/verify",
        headers={"Authorization": "Bearer " + token},
    )
    vraw = urllib.request.urlopen(req, timeout=5).read()
    vbody = json.loads(vraw.decode("latin1"), strict=False)
    assert vbody.get("status") == "success", vraw

    # 3) 無 termapp 環境：/get/call/status 應回錯誤（E008 類：sip 進程不可達）而非 crash/hang。
    #    原廠恆回 200（錯誤在 body），故不預期 HTTPError；容錯保留 except，主斷言為 body+存活。
    try:
        craw = urllib.request.urlopen("http://127.0.0.1:80/get/call/status", timeout=5).read()
        cbody = json.loads(craw.decode("latin1"), strict=False)
        assert cbody.get("status") == "error" and cbody.get("error_code") == "E008", craw
    except urllib.error.HTTPError:
        pass  # 若未來版本改回 HTTP 4xx，亦視為「未 crash」通過

    time.sleep(0.2)
    assert p.poll() is None, "server died"
    print("smoke_orig OK")
except Exception:
    sys.stdout.flush()
    raise
finally:
    p.kill()

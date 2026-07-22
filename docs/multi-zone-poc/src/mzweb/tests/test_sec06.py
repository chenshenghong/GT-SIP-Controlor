#!/usr/bin/env python3
"""T10/SEC-06: 改密複雜度(>=8 且英數混合，不合回 E001)＋改密成功清除現行 token
（舊 token 之後呼叫回 A003）＋新密碼以 mzhash_make 存雜湊(可用新密碼登入)。

在 musl 容器內執行：
  make x86-mzweb
  docker run --rm --platform linux/amd64 -v "$PWD":/src -w /src \
      python:3.12-alpine python3 tests/test_sec06.py
"""
import subprocess, time, urllib.request, json, re
open("/etc/ifcfg-eth0","w").write("SN=P7TEST\n")
open("/etc/ifcfg-sip","w").write("WEB_USER=admin\nWEB_PASSWORD=123456\n")
p=subprocess.Popen(["build/mzweb-x86"]); time.sleep(1)
base="http://127.0.0.1:80"
def login(pw):
    r=urllib.request.Request(base+"/auth/login",data=json.dumps({"username":"admin","password":pw}).encode())
    return re.search(r'"token":\s*"([0-9a-f]+)',urllib.request.urlopen(r,timeout=5).read().decode("latin1"))
def chpw(tok,old,new):
    r=urllib.request.Request(base+"/auth/change_password",data=json.dumps({"old_password":old,"new_password":new}).encode(),
        headers={"Authorization":"Bearer "+tok})
    return urllib.request.urlopen(r,timeout=5).read().decode("latin1")
try:
    tok=login("123456").group(1)
    assert "E001" in chpw(tok,"123456","short")          # <8 拒
    assert "E001" in chpw(tok,"123456","allletters")     # 無數字拒
    r=chpw(tok,"123456","GoodPass123")                    # 合法
    assert "success" in r, r
    # 改密後舊 token 失效（mzweb_check_token 對受權 API 回 401，body 帶 A003）
    try:
        urllib.request.urlopen(urllib.request.Request(base+"/get/device/status",headers={"Authorization":"Bearer "+tok}),timeout=5)
        raise AssertionError("改密後舊 token 未失效")
    except urllib.error.HTTPError as e:
        b=e.read().decode("latin1")
        assert "A003" in b, f"改密後舊 token 未失效: {b}"
    # 新密碼可登入
    assert login("GoodPass123") is not None
    print("sec06 OK")
finally:
    p.kill()

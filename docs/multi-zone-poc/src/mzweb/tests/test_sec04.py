#!/usr/bin/env python3
"""T8/SEC-04: WEB_PASSWORD 舊明文首登成功＋就地升級為 sha256$ 雜湊＋升級後仍可用原密碼登入。

在 musl 容器內執行：
  make x86-mzweb
  docker run --rm --platform linux/amd64 -v "$PWD":/src -w /src \
      python:3.12-alpine python3 tests/test_sec04.py
"""
import subprocess, time, urllib.request, json, re
open("/etc/ifcfg-eth0","w").write("SN=P7TEST\n")
open("/etc/ifcfg-sip","w").write("WEB_USER=admin\nWEB_PASSWORD=123456\n")  # 舊明文
p=subprocess.Popen(["build/mzweb-x86"]); time.sleep(1)
def login(pw):
    r=urllib.request.Request("http://127.0.0.1:80/auth/login",data=json.dumps({"username":"admin","password":pw}).encode())
    return urllib.request.urlopen(r,timeout=5).read().decode("latin1")
try:
    # 舊明文首登成功
    assert '"token"' in login("123456")
    # 就地升級：ifcfg-sip 的 WEB_PASSWORD 變 sha256$
    pw=open("/etc/ifcfg-sip").read()
    assert "WEB_PASSWORD=sha256$" in pw, f"未升級雜湊: {pw}"
    assert "WEB_PASSWORD=123456" not in pw
    # 升級後仍能用原密碼登入
    assert '"token"' in login("123456")
    print("sec04 OK")
finally:
    p.kill()

#!/usr/bin/env python3
"""T7 SEC-02: /get/sip/config 密碼欄遮蔽為 ********。

在 musl 容器內執行：
  make x86-mzweb
  docker run --rm --platform linux/amd64 -v "$PWD":/src -w /src \
      python:3.12-alpine python3 tests/test_sec02.py

fixtures：/etc/ifcfg-sip 需先有非空 PRIMARY_PASSWORD（原廠 init 不會自動補這個 key，
故本測試主動種一個真實密碼），才能驗證「就算 PRIMARY_PASSWORD 非空，回應仍恆為
********（不讀實際值）」——若不種值，PRIMARY_PASSWORD==NULL 時輸出恆為空字串，
測試對「遮蔽」這件事就毫無鑑別力。
"""
import subprocess, time, urllib.request, json, re, sys

open("/etc/ifcfg-eth0", "w").write("SN=P7TEST\n")

REAL_PASSWORD = "s3cr3t-p@ss"
with open("/etc/ifcfg-sip", "wb") as f:
    f.write(b"WEB_USER=admin\n")
    f.write(b"WEB_PASSWORD=123456\n")
    f.write(b"WEB_PORT=80\n")
    f.write(("PRIMARY_PASSWORD=" + REAL_PASSWORD + "\n").encode("latin1"))
    f.write(b"PRIMARY_SERVER_ADDRESS=10.0.0.5\n")

p = subprocess.Popen(["build/mzweb-x86"])
time.sleep(1)


def login():
    r = urllib.request.Request(
        "http://127.0.0.1:80/auth/login",
        data=json.dumps({"username": "admin", "password": "123456"}).encode())
    return re.search(r'"token":\s*"([0-9a-f]+)',
                      urllib.request.urlopen(r, timeout=5).read().decode("latin1")).group(1)


try:
    tok = login()
    H = {"Authorization": "Bearer " + tok}
    b = urllib.request.urlopen(
        urllib.request.Request("http://127.0.0.1:80/get/sip/config", headers=H),
        timeout=5).read().decode("gbk", "replace")
    d = json.loads(b)

    # 找所有 password 欄，皆須為 ********（不論 /etc/ifcfg-sip 內實際值為何）
    def walk(o):
        if isinstance(o, dict):
            for k, v in o.items():
                if k == "password":
                    assert v == "********", f"密碼未遮蔽: {v}"
                walk(v)

    walk(d)
    assert REAL_PASSWORD not in b, "回應內仍洩漏真實密碼明文"
    print("sec02 OK")
finally:
    p.kill()

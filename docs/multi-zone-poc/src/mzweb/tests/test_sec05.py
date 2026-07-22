"""T9/SEC-05: 登入失敗鎖定 -- 連續 5 次錯密碼鎖定 5 分鐘（LOCK_MS 可 -D 縮短測試用），回 A005。

在 musl 容器內執行：
  make x86-mzweb
  docker run --rm --platform linux/amd64 -v "$PWD":/src -w /src \
      python:3.12-alpine python3 tests/test_sec05.py
"""
import subprocess, time, urllib.request, json
open("/etc/ifcfg-eth0","w").write("SN=P7TEST\n")
open("/etc/ifcfg-sip","w").write("WEB_USER=admin\nWEB_PASSWORD=123456\n")
p=subprocess.Popen(["build/mzweb-x86"]); time.sleep(1)
def login(pw):
    r=urllib.request.Request("http://127.0.0.1:80/auth/login",data=json.dumps({"username":"admin","password":pw}).encode())
    return urllib.request.urlopen(r,timeout=5).read().decode("latin1")
try:
    for _ in range(5): login("wrong")     # 5 次錯
    b=login("wrong")                        # 第 6 次應鎖定
    assert "A005" in b, f"未鎖定: {b[:80]}"
    b2=login("123456")                      # 鎖定期內即使對也 A005
    assert "A005" in b2, f"鎖定期內正確密碼未擋: {b2[:80]}"
    print("sec05 OK")
finally:
    p.kill()

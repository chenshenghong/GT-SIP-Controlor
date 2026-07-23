"""T9/SEC-05: 登入失敗鎖定 -- 連續 5 次錯密碼鎖定（LOCK_MS 可 -D 縮短測試用），回 A005；
鎖定到期後應重置失敗計數，給使用者全新 5 次機會（SEC-05-fix），而非殘留計數導致實質
永久鎖定。

在 musl 容器內執行：
  make x86-mzweb-sec05
  docker run --rm --platform linux/amd64 -v "$PWD":/src -w /src \
      python:3.12-alpine python3 tests/test_sec05.py

本測試打 build/mzweb-x86-sec05（非 x86-mzweb）—— Makefile 的 TESTDEF_sec05 把 LOCK_MS
覆蓋為 1500ms，讓「鎖定到期」這件事能在測試視窗內驗證，免等 production 預設的 5 分鐘。
production x86-mzweb/arm-mzweb 仍用 patch 內建 LOCK_MS=300000，不受影響。

SEC-05-fix 鑑別力設計：修前 s_login_fail 只在登入成功時歸零，鎖定到期本身不重置 --
到期後第一次再打錯密碼會沿用殘留計數（5），++ 立刻又 >=5 觸發鎖定，回 A005（而非期望
的乾淨 A001），使用者陷入「除非登入成功否則永久鎖定」的迴圈。本測試在鎖定到期＋sleep
後打「一次」錯密碼，斷言回 A001（非 A005）：修前必失敗，修後計數已歸零故通過；再連續
錯到 5 次，斷言又回到 A005（新一輪鎖定仍正常觸發）。
"""
import subprocess, time, urllib.request, json

LOCK_MS = 1500
LOCK_S = LOCK_MS / 1000.0

open("/etc/ifcfg-eth0", "w").write("SN=P7TEST\n")
open("/etc/ifcfg-sip", "w").write("WEB_USER=admin\nWEB_PASSWORD=123456\n")
p = subprocess.Popen(["build/mzweb-x86-sec05"]); time.sleep(1)


def login(pw):
    r = urllib.request.Request(
        "http://127.0.0.1:80/auth/login",
        data=json.dumps({"username": "admin", "password": pw}).encode(),
    )
    return urllib.request.urlopen(r, timeout=5).read().decode("latin1")


try:
    for _ in range(5):
        login("wrong")  # 5 次錯：第 5 次已觸發鎖定
    b = login("wrong")  # 鎖定中再打錯：仍 A005
    assert "A005" in b, f"未鎖定: {b[:80]}"
    b2 = login("123456")  # 鎖定期內即使對也 A005
    assert "A005" in b2, f"鎖定期內正確密碼未擋: {b2[:80]}"

    # --- SEC-05-fix：鎖定到期後應重置失敗計數，給全新 5 次機會 ---
    time.sleep(LOCK_S + 0.5)  # 等超過縮短的 LOCK_MS，讓鎖定到期
    b3 = login("wrong")  # 到期後第一次錯：修前殘留計數(5)++ 立刻再鎖=A005；修後歸零=A001
    assert "A001" in b3 and "A005" not in b3, f"到期後未重置計數(仍鎖定): {b3[:80]}"

    for _ in range(3):
        login("wrong")  # 計數 1(b3) -> 2 -> 3 -> 4，尚未達 5，不應鎖定
    b5 = login("wrong")  # 第 5 次（新一輪）應再次觸發鎖定
    assert "A005" in b5, f"重置後連 5 次錯應再次鎖定: {b5[:80]}"

    print("sec05 OK")
finally:
    p.kill()

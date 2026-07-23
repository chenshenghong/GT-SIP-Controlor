#!/usr/bin/env python3
"""Task 5 整合測試：GET/POST /get|set/io/config（出廠預設＋原子寫＋SIGHUP 通知）。

啟動/login 模式照 test_txio_routes.py 複製。MZIO_JSON 等路徑用預設 /opt、/tmp、
/var/run（容器內以 root 執行，皆可寫）。

七條斷言（brief Step 1）：
  1. /opt/mzio.json 不存在時 GET /get/io/config → 200；io_config 為 6 列；
     id=2 列 gpio=="GPIO5_5"、mode=="input"、action.type=="multicast_ptt"、state==0；
     id=1 列 gpio==""、mode=="disabled"
  2. 寫 /tmp/mzio_state = '{"2":1}' 後 GET → id=2 列 state==1（合併即時值）
  3. POST 單列（id=2）→ 200 success；/opt/mzio.json 中 id=2 的 debounce_ms==50；
     其餘 5 列保留預設；gpio 欄仍 "GPIO5_5"（伺服器端擁有）
  4. POST 含 "gpio":"HACK" 與 "state":1 → 200；檔內 gpio 不變、無 state 欄（忽略唯讀欄）
  5. POST debounce_ms=999 → 200 error E001 'IO配置非法'；檔案未變（整包拒收）
  6. POST 後 SIGHUP：pidfile 指向 dummy python 子程序，收到 SIGHUP 寫 marker 檔
  7. GET 回應整包可過 json.loads（GBK decode 後）
"""
import json
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request

MZIO_JSON = "/opt/mzio.json"
MZIO_STATE = "/tmp/mzio_state"
MZIO_PIDFILE = "/var/run/mzio.pid"
MARKER = "/tmp/mzio_sighup_marker"

# fixtures：websetsip 啟動要讀 /etc/ifcfg-eth0 的 SN（缺檔/缺 SN 會 return，靜默不啟動）。
open("/etc/ifcfg-eth0", "w").write("SN=P7TEST\n")
# /etc/ifcfg-sip 缺檔時 init_sip_web_set_svr 自建預設（WEB_USER=admin / WEB_PASSWORD=123456）。

for path in (MZIO_JSON, MZIO_STATE, MZIO_PIDFILE, MARKER):
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass

p = subprocess.Popen(["build/mzweb-x86"])
time.sleep(1)


def login():
    req = urllib.request.Request(
        "http://127.0.0.1:80/auth/login",
        data=json.dumps({"username": "admin", "password": "123456"}).encode())
    raw = urllib.request.urlopen(req, timeout=5).read()
    b = json.loads(raw.decode("latin1"), strict=False)
    tok = (b.get("token") or b.get("data", {}).get("token") or "")
    return tok.strip()


def get_io(headers):
    req = urllib.request.Request("http://127.0.0.1:80/get/io/config", headers=headers)
    try:
        raw = urllib.request.urlopen(req, timeout=5).read()
        return 200, raw
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def post_io(payload_bytes, headers):
    req = urllib.request.Request(
        "http://127.0.0.1:80/set/io/config", data=payload_bytes, headers=headers,
        method="POST")
    try:
        raw = urllib.request.urlopen(req, timeout=5).read()
        return 200, raw
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def rows_by_id(body):
    return {row["id"]: row for row in body["io_config"]}


dummy = None
try:
    tok = login()
    assert tok and len(tok) == 32, repr(tok)
    H = {"Authorization": "Bearer " + tok, "Content-Type": "application/json"}

    # 1) /opt/mzio.json 不存在 -> GET 回出廠預設 6 列
    code, raw = get_io(H)
    assert code == 200, (code, raw)
    body = json.loads(raw.decode("gbk"))
    assert len(body["io_config"]) == 6, body["io_config"]
    rows = rows_by_id(body)
    assert rows[2]["gpio"] == "GPIO5_5", rows[2]
    assert rows[2]["mode"] == "input", rows[2]
    assert rows[2]["action"]["type"] == "multicast_ptt", rows[2]
    assert rows[2]["state"] == 0, rows[2]
    assert rows[1]["gpio"] == "", rows[1]
    assert rows[1]["mode"] == "disabled", rows[1]
    print("[1] GET without mzio.json -> factory defaults (6 rows) OK")

    # 2) 寫 /tmp/mzio_state = {"2":1} -> GET id=2 state==1（合併即時值）
    with open(MZIO_STATE, "w") as f:
        f.write('{"2":1}')
    code, raw = get_io(H)
    assert code == 200, (code, raw)
    body = json.loads(raw.decode("gbk"))
    rows = rows_by_id(body)
    assert rows[2]["state"] == 1, rows[2]
    print("[2] GET merges live state from mzio_state OK")

    # 3) POST 單列(id=2) -> 200 success；mzio.json 中 id=2 debounce_ms==50；其餘 5 列保留預設
    payload3 = json.dumps({"io_config": [{
        "id": 2, "mode": "input", "contact": "NO", "trigger": "level",
        "debounce_ms": 50, "action": {"type": "multicast_ptt", "param": "500"},
    }]}).encode()
    code, raw = post_io(payload3, H)
    assert code == 200, (code, raw)
    assert b"success" in raw, raw
    with open(MZIO_JSON, "r", encoding="gbk") as f:
        on_disk = json.loads(f.read())
    disk_rows = rows_by_id(on_disk)
    assert disk_rows[2]["debounce_ms"] == 50, disk_rows[2]
    assert disk_rows[2]["gpio"] == "GPIO5_5", disk_rows[2]
    assert len(on_disk["io_config"]) == 6, on_disk["io_config"]
    for i in (1, 3, 4, 5, 6):
        assert disk_rows[i]["mode"] == "disabled", disk_rows[i]
    print("[3] POST single row merges onto defaults; gpio server-owned OK")

    # 4) POST 含 gpio="HACK" 與 state=1 -> 200；檔內 gpio 不變、無 state 欄
    payload4 = json.dumps({"io_config": [{
        "id": 2, "gpio": "HACK", "state": 1, "mode": "output", "contact": "NC",
        "trigger": "edge", "debounce_ms": 40, "action": {"type": "hangup", "param": ""},
    }]}).encode()
    code, raw = post_io(payload4, H)
    assert code == 200, (code, raw)
    assert b"success" in raw, raw
    with open(MZIO_JSON, "r", encoding="gbk") as f:
        on_disk = json.loads(f.read())
    disk_rows = rows_by_id(on_disk)
    assert disk_rows[2]["gpio"] == "GPIO5_5", disk_rows[2]
    assert "state" not in disk_rows[2], disk_rows[2]
    assert disk_rows[2]["mode"] == "output", disk_rows[2]
    print("[4] POST ignores read-only gpio/state fields OK")

    # 5) POST debounce_ms=999 -> 200 error E001 IO配置非法；檔案未變
    before_mtime = os.path.getmtime(MZIO_JSON)
    with open(MZIO_JSON, "rb") as f:
        before_bytes = f.read()
    bad_io_msg = ("IO" + "\xc5\xe4\xd6\xc3\xb7\xc7\xb7\xa8").encode("latin1")
    payload5 = json.dumps({"io_config": [{
        "id": 2, "mode": "input", "contact": "NO", "trigger": "level",
        "debounce_ms": 999, "action": {"type": "multicast_ptt", "param": "500"},
    }]}).encode()
    code, raw = post_io(payload5, H)
    assert code == 200, (code, raw)
    assert b"E001" in raw, raw
    assert bad_io_msg in raw, raw
    with open(MZIO_JSON, "rb") as f:
        after_bytes = f.read()
    assert after_bytes == before_bytes, "file must be unchanged on validation failure"
    assert os.path.getmtime(MZIO_JSON) == before_mtime
    print("[5] POST invalid debounce_ms -> E001, file unchanged (all-or-nothing) OK")

    # 6) POST 後 SIGHUP 通知：pidfile 指向 dummy python 子程序
    dummy_script = (
        "import signal, sys, time\n"
        "def handler(signum, frame):\n"
        "    open('%s', 'w').write('hup')\n"
        "    sys.exit(0)\n"
        "signal.signal(signal.SIGHUP, handler)\n"
        "signal.pause()\n"
    ) % MARKER
    dummy = subprocess.Popen([sys.executable, "-c", dummy_script])
    time.sleep(0.3)
    with open(MZIO_PIDFILE, "w") as f:
        f.write(str(dummy.pid))
    payload6 = json.dumps({"io_config": [{
        "id": 2, "mode": "input", "contact": "NO", "trigger": "level",
        "debounce_ms": 60, "action": {"type": "multicast_ptt", "param": "500"},
    }]}).encode()
    code, raw = post_io(payload6, H)
    assert code == 200, (code, raw)
    assert b"success" in raw, raw
    deadline = time.time() + 5
    while time.time() < deadline and not os.path.exists(MARKER):
        time.sleep(0.1)
    assert os.path.exists(MARKER), "SIGHUP marker file not created"
    dummy.wait(timeout=5)
    dummy = None
    print("[6] POST success -> pidfile process receives SIGHUP OK")

    # 7) GET 回應整包可過 json.loads（GBK decode 後）
    code, raw = get_io(H)
    assert code == 200, (code, raw)
    body = json.loads(raw.decode("gbk"))
    assert "io_config" in body and len(body["io_config"]) == 6, body
    print("[7] GET response is valid GBK-decoded JSON OK")

    print("txio_io OK")
except Exception:
    sys.stdout.flush()
    raise
finally:
    p.kill()
    if dummy is not None:
        dummy.kill()

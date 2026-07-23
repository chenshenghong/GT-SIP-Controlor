#!/usr/bin/env python3
"""Task 3 整合測試：POST /set/multicast/tx 完整行為（alpine 容器內）。

前置：/etc/ifcfg-sip 種子含 MULTICAST_ADDRESS=239.0.0.1、MULTICAST_PORT=8000
（RX 設定，供 MTX-06 迴授防護測項）。

fake sip.sdk：另起一條 thread 跑 unix stream server bind /tmp/sip.sdk，記錄收到
的 bytes 並回一段 >4 bytes 的回覆（mzsdk_send 等回覆才算成功，見 mzsdk.c）。

十條斷言照 brief Step 1（001-010）。
"""
import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

SDK_PATH = "/tmp/sip.sdk"
IFCFG = "/etc/ifcfg-sip"

# fixtures：websetsip 啟動要讀 /etc/ifcfg-eth0 的 SN（缺檔/缺 SN 會 return，靜默不啟動）。
open("/etc/ifcfg-eth0", "w").write("SN=P7TEST\n")
# /etc/ifcfg-sip 種子：WEB_USER/WEB_PASSWORD（供 login）＋ RX 設定（供迴授防護測項）。
open(IFCFG, "w").write(
    "WEB_USER=admin\n"
    "WEB_PASSWORD=123456\n"
    "MULTICAST_ADDRESS=239.0.0.1\n"
    "MULTICAST_PORT=8000\n"
)


class FakeSipSdk:
    """threading unix stream server bind /tmp/sip.sdk，記錄收到的指令 bytes。"""

    def __init__(self, path):
        self.path = path
        self.received = []
        self.lock = threading.Lock()
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.bind(path)
        self.sock.listen(8)
        self.sock.settimeout(0.5)
        self.stop_flag = False
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self):
        while not self.stop_flag:
            try:
                conn, _ = self.sock.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            try:
                data = conn.recv(4096)
                with self.lock:
                    self.received.append(data)
                # mzsdk_send 等 >4 bytes 回覆才算成功
                conn.send(b"OK-ACK-1234")
            finally:
                conn.close()

    def count(self):
        with self.lock:
            return len(self.received)

    def last(self):
        with self.lock:
            return self.received[-1] if self.received else b""

    def stop(self):
        self.stop_flag = True
        self.thread.join(timeout=2)
        self.sock.close()
        try:
            os.unlink(self.path)
        except FileNotFoundError:
            pass


sdk = FakeSipSdk(SDK_PATH)
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


def post_settx(payload_bytes, headers):
    req = urllib.request.Request(
        "http://127.0.0.1:80/set/multicast/tx", data=payload_bytes, headers=headers,
        method="POST")
    try:
        raw = urllib.request.urlopen(req, timeout=5).read()
        return 200, raw
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def read_ifcfg():
    with open(IFCFG, "r", encoding="latin1") as f:
        return f.read()


try:
    tok = login()
    assert tok and len(tok) == 32, repr(tok)
    H = {"Authorization": "Bearer " + tok, "Content-Type": "application/json"}

    # 1) 合法 payload → 200 success；四 key 落盤；fake sdk 收到 set_sip_multicast_tx
    payload = json.dumps({
        "multicast_address": "225.1.1.1",
        "multicast_port": 9000,
        "enabled": True,
        "audio_codec": "G.722",
    }).encode()
    code, raw = post_settx(payload, H)
    assert code == 200, (code, raw)
    assert b"success" in raw, raw
    cfg = read_ifcfg()
    assert "MULTICAST_TX_ADDRESS=225.1.1.1" in cfg, cfg
    assert "MULTICAST_TX_PORT=9000" in cfg, cfg
    assert "MULTICAST_TX_ENABLED=true" in cfg, cfg
    assert "MULTICAST_TX_CODEC=G.722" in cfg, cfg
    time.sleep(0.3)
    assert sdk.count() == 1, sdk.count()
    assert b"set_sip_multicast_tx" in sdk.last(), sdk.last()
    print("[1] valid payload -> 200 success, 4 keys persisted, sdk notified OK")

    # 2) 同 payload 重送（值未變）→ 200；fake sdk 未再收到指令（save_flag 語意）
    before = sdk.count()
    code, raw = post_settx(payload, H)
    assert code == 200, (code, raw)
    assert b"success" in raw, raw
    time.sleep(0.3)
    assert sdk.count() == before, (sdk.count(), before)
    print("[2] resend unchanged payload -> 200, no re-notify (save_flag) OK")

    # 3) address 非組播 → E001 非法组播地址
    bad_addr_msg = "\xb7\xc7\xb7\xa8\xd7\xe9\xb2\xa5\xb5\xd8\xd6\xb7".encode("latin1")
    payload3 = json.dumps({
        "multicast_address": "192.168.1.1",
        "multicast_port": 9000,
        "enabled": True,
        "audio_codec": "G.722",
    }).encode()
    code, raw = post_settx(payload3, H)
    assert code == 200, (code, raw)
    assert b"E001" in raw, raw
    assert bad_addr_msg in raw, raw
    print("[3] non-multicast address -> E001 non-legal address OK")

    # 4) port 0 與 65535 → E001 非法组播端口
    bad_port_msg = "\xb7\xc7\xb7\xa8\xd7\xe9\xb2\xa5\xb6\xcb\xbf\xda".encode("latin1")
    for bad_port in (0, 65535):
        payload4 = json.dumps({
            "multicast_address": "225.1.1.1",
            "multicast_port": bad_port,
            "enabled": True,
            "audio_codec": "G.722",
        }).encode()
        code, raw = post_settx(payload4, H)
        assert code == 200, (code, raw)
        assert b"E001" in raw, raw
        assert bad_port_msg in raw, raw
    print("[4] port 0 and 65535 -> E001 non-legal port OK")

    # 5) audio_codec "OPUS" → E001 非法音频编码
    bad_codec_msg = "\xb7\xc7\xb7\xa8\xd2\xf4\xc6\xb5\xb1\xe0\xc2\xeb".encode("latin1")
    payload5 = json.dumps({
        "multicast_address": "225.1.1.1",
        "multicast_port": 9000,
        "enabled": True,
        "audio_codec": "OPUS",
    }).encode()
    code, raw = post_settx(payload5, H)
    assert code == 200, (code, raw)
    assert b"E001" in raw, raw
    assert bad_codec_msg in raw, raw
    print("[5] audio_codec OPUS -> E001 non-legal codec OK")

    # 6) 缺 enabled 欄 → E001 JSON字符串存在键值缺失
    misskey_msg = (
        "JSON" + "\xd7\xd6\xb7\xfb\xb4\xae\xb4\xe6\xd4\xda\xbc\xfc\xd6\xb5\xc8\xb1\xca\xa7"
    ).encode("latin1")
    payload6 = json.dumps({
        "multicast_address": "225.1.1.1",
        "multicast_port": 9000,
        "audio_codec": "G.722",
    }).encode()
    code, raw = post_settx(payload6, H)
    assert code == 200, (code, raw)
    assert b"E001" in raw, raw
    assert misskey_msg in raw, raw
    print("[6] missing enabled key -> E001 missing key OK")

    # 7) enabled 給字串 "true" → E001 JSON字符串存在键值类型非指定类型
    badtype_msg = (
        "JSON" + "\xd7\xd6\xb7\xfb\xb4\xae\xb4\xe6\xd4\xda\xbc\xfc\xd6\xb5\xc0\xe0\xd0\xcd"
        "\xb7\xc7\xd6\xb8\xb6\xa8\xc0\xe0\xd0\xcd"
    ).encode("latin1")
    payload7 = json.dumps({
        "multicast_address": "225.1.1.1",
        "multicast_port": 9000,
        "enabled": "true",
        "audio_codec": "G.722",
    }).encode()
    code, raw = post_settx(payload7, H)
    assert code == 200, (code, raw)
    assert b"E001" in raw, raw
    assert badtype_msg in raw, raw
    print("[7] enabled as string -> E001 bad type OK")

    # 8) 迴授防護：address=239.0.0.1、port=8000（==RX）、enabled=true → E001 发送地址与接收地址相同
    loopback_msg = (
        "\xb7\xa2\xcb\xcd\xb5\xd8\xd6\xb7\xd3\xeb\xbd\xd3\xca\xd5\xb5\xd8\xd6\xb7\xcf\xe0\xcd\xac"
    ).encode("latin1")
    payload8 = json.dumps({
        "multicast_address": "239.0.0.1",
        "multicast_port": 8000,
        "enabled": True,
        "audio_codec": "G.722",
    }).encode()
    before = sdk.count()
    code, raw = post_settx(payload8, H)
    assert code == 200, (code, raw)
    assert b"E001" in raw, raw
    assert loopback_msg in raw, raw
    time.sleep(0.3)
    assert sdk.count() == before, (sdk.count(), before)
    print("[8] loopback address+port with enabled=true -> E001 loopback OK")

    # 9) 迴授防護例外：同位址但 enabled=false → 200 success（只擋「啟動」）
    payload9 = json.dumps({
        "multicast_address": "239.0.0.1",
        "multicast_port": 8000,
        "enabled": False,
        "audio_codec": "G.722",
    }).encode()
    code, raw = post_settx(payload9, H)
    assert code == 200, (code, raw)
    assert b"success" in raw, raw
    print("[9] loopback address+port with enabled=false -> 200 success OK")

    # 10) body 空 → E001 JSON字符串为空
    empty_msg = ("JSON" + "\xd7\xd6\xb7\xfb\xb4\xae\xce\xaa\xbf\xd5").encode("latin1")
    code, raw = post_settx(b"", H)
    assert code == 200, (code, raw)
    assert b"E001" in raw, raw
    assert empty_msg in raw, raw
    print("[10] empty body -> E001 empty JSON OK")

    print("txio_settx OK")
except Exception:
    sys.stdout.flush()
    raise
finally:
    p.kill()
    sdk.stop()

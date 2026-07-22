import subprocess, time, urllib.request, urllib.error, socket, json, sys
p = subprocess.Popen(["build/test_webapi"])
time.sleep(0.5)
try:
    # 1) 正常 POST＋Authorization
    req = urllib.request.Request("http://127.0.0.1:18080/echo", data=b'{"x":1}',
                                 headers={"Authorization": "Bearer abcdef"})
    r = json.loads(urllib.request.urlopen(req, timeout=5).read())
    assert r == {"auth_len": 13, "body_len": 7, "is_get": 0}, r
    # 2) GET
    r = json.loads(urllib.request.urlopen("http://127.0.0.1:18080/echo", timeout=5).read())
    assert r["is_get"] == 1 and r["auth_len"] == 0, r
    # 3) 未知路由 → 404
    try:
        urllib.request.urlopen("http://127.0.0.1:18080/nope", timeout=5)
        raise AssertionError("expected 404")
    except urllib.error.HTTPError as e:
        assert e.code == 404
    # 4) 超長 URL → 拒絕（連線關閉或 4xx，不 crash）
    try:
        urllib.request.urlopen("http://127.0.0.1:18080/" + "a" * 4096, timeout=5)
    except Exception:
        pass
    # 5) 客戶端斷線不殺 server（SIGPIPE）：半途關 socket 後 server 仍活著
    s = socket.create_connection(("127.0.0.1", 18080)); s.send(b"GET /echo HTTP/1.1\r\n"); s.close()
    time.sleep(0.2)
    assert p.poll() is None, "server died (SIGPIPE?)"
    # 6) server 仍能服務
    r = json.loads(urllib.request.urlopen("http://127.0.0.1:18080/echo", timeout=5).read())
    assert r["is_get"] == 1
    print("webapi OK")
finally:
    p.kill()

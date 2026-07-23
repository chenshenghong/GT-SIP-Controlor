import subprocess, time, urllib.request, urllib.error, socket, json


def read_all(s, timeout=5):
    """讀到 EOF（server 回應後 Connection: close 主動關）或逾時。"""
    s.settimeout(timeout)
    data = b""
    while True:
        try:
            chunk = s.recv(4096)
        except socket.timeout:
            break
        if not chunk:
            break
        data += chunk
    return data


def parse_json_body(data):
    i = data.find(b"\r\n\r\n")
    assert i >= 0, ("no header terminator in response", data)
    return json.loads(data[i + 4:])


def send_segments(segments, port=18080, sleep=0.05):
    """用 raw socket 分段送出，每段之間 sleep，模擬跨 TCP segment。回傳完整回應 bytes。"""
    s = socket.create_connection(("127.0.0.1", port), timeout=5)
    try:
        for seg in segments:
            s.sendall(seg if isinstance(seg, bytes) else seg.encode())
            time.sleep(sleep)
        return read_all(s)
    finally:
        s.close()


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

    # --- partial-read 狀態機鑑別（urllib 一次送完測不到跨 segment；以下逐段送）---

    # (a) request line / headers / body 全部跨多次 send，結果須與一次送完等價。
    #     若跨段累積壞掉（如 hdr_end / url 視圖不持久化），這裡會解析錯或 crash。
    resp = send_segments([
        "POST /ec",
        "ho HTTP/1.1\r\nAuthor",
        "ization: Bearer abcdef\r\nContent-Length: 7\r\n\r\n",
        '{"x":',   # body 也拆兩段
        '1}',
    ])
    r = parse_json_body(resp)
    assert r == {"auth_len": 13, "body_len": 7, "is_get": 0}, ("partial (a)", r)

    # (b) header 終止的 \r\n\r\n 剛好跨 send 邊界（拆在 \r\n\r | \n）。
    resp = send_segments([
        "POST /echo HTTP/1.1\r\nAuthorization: Bearer abcdef\r\nContent-Length: 7\r\n\r",
        "\n",
        '{"x":1}',
    ])
    r = parse_json_body(resp)
    assert r == {"auth_len": 13, "body_len": 7, "is_get": 0}, ("partial (b)", r)

    # (c) 惡意 Content-Length：負值 & 超大值 → server 不 crash（關連線或回錯皆可）。
    #     負值 -5：parse_uint 遇 '-' 立即停 → content_len=0，正常派送。
    resp = send_segments([
        "POST /echo HTTP/1.1\r\nAuthorization: Bearer abcdef\r\nContent-Length: -5\r\n\r\n",
    ])
    # 可能回 body_len=0 的 JSON；不強制內容，只要不 crash。
    #     超大值 999999：parse_uint 夾住 > MAX_BODY → 邊界檢查關連線（無回應）。
    try:
        send_segments([
            "POST /echo HTTP/1.1\r\nContent-Length: 999999\r\n\r\n",
        ])
    except Exception:
        pass
    assert p.poll() is None, "server died on malicious Content-Length"
    # 惡意請求後 server 仍能正常服務
    r = json.loads(urllib.request.urlopen("http://127.0.0.1:18080/echo", timeout=5).read())
    assert r["is_get"] == 1, ("post-malicious service", r)

    # --- Critical-1 鑑別：slow-loris（沉默半條 header 占滿連線）須被週期 timer 回收 ---
    # test_webapi 以 -DIDLE_MS=1000 -DSWEEP_MS=250 建置。開滿 MAX_CONNS=4 條連線各送 1 byte
    # 後保持沉默不關 → 若無 timer 驅動的 sweep，這些 slot 永不釋放，新連線恆被拒（DoS）。
    loris = []
    for _ in range(4):
        ls = socket.create_connection(("127.0.0.1", 18080), timeout=5)
        ls.sendall(b"G")   # 半條 request line，之後沉默
        loris.append(ls)
    time.sleep(0.3)
    # 等待略長於 IDLE_MS(1s) + 一個 sweep 週期，讓 timer 回收 4 個沉默連線。
    time.sleep(2.0)
    # slot 已釋放 → 新請求可被正常服務。未修 Critical-1 時此斷言會 timeout / 失敗。
    r = json.loads(urllib.request.urlopen("http://127.0.0.1:18080/echo", timeout=5).read())
    assert r["is_get"] == 1, ("slow-loris recovery", r)
    for ls in loris:
        try:
            ls.close()
        except Exception:
            pass
    assert p.poll() is None, "server died during slow-loris test"

    print("webapi OK")
finally:
    p.kill()

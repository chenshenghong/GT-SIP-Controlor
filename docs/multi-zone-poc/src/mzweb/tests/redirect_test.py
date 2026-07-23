import subprocess, time, socket
p=subprocess.Popen(["build/test_webapi_tls"]); time.sleep(1.5)
try:
    # :80 對任意路徑回 301 → https（假設 test 殼同時起 :80，見 Step3）
    with socket.create_connection(("127.0.0.1",8080),timeout=5) as s:
        s.send(b"GET /get/device/status HTTP/1.1\r\nHost:127.0.0.1:8080\r\nConnection: close\r\n\r\n")
        d=s.recv(2048)
    assert b"301" in d and b"Location: https://" in d and b"/get/device/status" in d, d
    assert b"X-Frame-Options: SAMEORIGIN" in d, d

    # Critical-fix regression：Host 值內嵌裸 \n 夾帶偽 Set-Cookie header（HTTP response
    # splitting）。未修版 parse_request 逐行掃描僅認嚴格 \r\n 為行終止，裸 \n 不斷行、
    # 併入該 header 值 → send_redirect 把整段（含偽 Set-Cookie）原樣塞進 Location，
    # 注入的偽標頭會被寬鬆解析的瀏覽器/快取/代理當成獨立標頭收下。修復後 server 偵測
    # Host 值含控制字元 → 改用 getsockname 兜底 IP，注入內容絕不進 Location。
    with socket.create_connection(("127.0.0.1",8080),timeout=5) as s:
        s.send(b"GET /a HTTP/1.1\r\nHost: 127.0.0.1\nSet-Cookie: sess=evil\r\nConnection: close\r\n\r\n")
        d2=s.recv(2048)
    assert b"301" in d2, d2
    loc_start = d2.find(b"Location:")
    assert loc_start >= 0, d2
    loc_end = d2.find(b"\r\n", loc_start)
    loc_line = d2[loc_start:loc_end if loc_end >= 0 else len(d2)]
    assert b"Set-Cookie" not in loc_line and b"\n" not in loc_line[len(b"Location: "):], d2
    assert b"Set-Cookie: sess=evil" not in d2, d2
    print("redirect OK")
finally:
    p.kill()

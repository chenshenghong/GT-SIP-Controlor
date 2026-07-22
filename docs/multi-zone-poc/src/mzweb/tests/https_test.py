import subprocess, time, ssl, socket

p=subprocess.Popen(["build/test_webapi_tls"]); time.sleep(1.5)  # 首開 keygen 需時間
try:
    ctx=ssl.create_default_context(); ctx.check_hostname=False; ctx.verify_mode=ssl.CERT_NONE
    # 1) 一次送完整請求：TLS handshake + 明文 HTTP over TLS
    with socket.create_connection(("127.0.0.1",8443),timeout=8) as s:
        with ctx.wrap_socket(s,server_hostname="127.0.0.1") as ss:
            ss.send(b"GET /echo HTTP/1.1\r\nHost:x\r\nConnection: close\r\n\r\n")
            data=b""
            while True:
                c=ss.recv(4096)
                if not c: break
                data+=c
    assert b"200 OK" in data and b'"ok":1' in data, data
    # 2) 分段送（非阻塞 handshake + partial read 在 TLS 上仍成立）
    with socket.create_connection(("127.0.0.1",8443),timeout=8) as s:
        with ctx.wrap_socket(s,server_hostname="127.0.0.1") as ss:
            ss.send(b"GET /ec"); time.sleep(0.05); ss.send(b"ho HTTP/1.1\r\nHost:x\r\nConnection: close\r\n\r\n")
            d=ss.recv(4096)
    assert b"200 OK" in d, d

    # 3) Critical 鑑別：大回應（512KB）＋客戶端故意暫停讀取 → 傳輸層送出緩衝填滿、TLS
    #    ssl_write 回 WANT_WRITE。舊版 tls_send_all 在此原地空轉 → 100% CPU、event_loop_step
    #    永不返回、整個 poll loop 凍結。修正後靠 POLLOUT 事件驅動排空，loop 不凍結。
    #    斷言 (a)：暫停期間另開連線打 /echo 仍即時回應（證明 loop 沒被凍結）；
    #    斷言 (b)：恢復讀取後大回應仍能完整收齊（Content-Length 對得上）。
    big_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    # 關鍵：SO_RCVBUF 必須在 connect 之前設，才會固定（縮小）TCP 接收視窗；connect 後才設
    # 對已協商的視窗無效，kernel 會把整個 body 收進客戶端 recv buffer → server 永不阻塞、測不到。
    big_sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 2048)
    big_sock.settimeout(8)
    big_sock.connect(("127.0.0.1",8443))
    big_ss = ctx.wrap_socket(big_sock, server_hostname="127.0.0.1")
    try:
        big_ss.send(b"GET /big HTTP/1.1\r\nHost:x\r\nConnection: close\r\n\r\n")
        time.sleep(1.0)  # 故意不讀，讓 server 卡在 WANT_WRITE（未修版此時已 busy-spin 凍結）

        # (a) 暫停期間，另一條 TLS 連線打 /echo：loop 若被凍結，這裡 handshake/recv 會 timeout。
        with socket.create_connection(("127.0.0.1",8443),timeout=5) as s2:
            with ctx.wrap_socket(s2,server_hostname="127.0.0.1") as ss2:
                ss2.send(b"GET /echo HTTP/1.1\r\nHost:x\r\nConnection: close\r\n\r\n")
                d2=b""
                while True:
                    ch=ss2.recv(4096)
                    if not ch: break
                    d2+=ch
        assert b'"ok":1' in d2, ("loop frozen during big slow-read (echo starved)", d2)

        # (b) 恢復讀取 → 大回應完整收齊。
        big=b""
        while True:
            ch=big_ss.recv(65536)
            if not ch: break
            big+=ch
    finally:
        try: big_ss.close()
        except Exception: pass
    j=big.find(b"\r\n\r\n")
    assert j>=0, ("no header terminator in big response", big[:200])
    body_len=len(big)-(j+4)
    assert body_len==2*1024*1024, ("big response truncated", body_len)

    print("https OK")
finally:
    p.kill()

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

    # 4) Important 鑑別：寫出面 slow-loris 回收（out_deadline 硬牆，與 last_io 解耦）。
    #    開滿 MAX_CONNS=4 條 TLS 連線各請求 /big（2MiB 大回應），握手完成後永久停止讀取 →
    #    server 整段緩衝、傳輸層填滿即卡 out_pending。未修（無 out_deadline）版：對端不讀 →
    #    last_io 凍結，但 IDLE_MS(10s) 於本測試窗(~5.5s)內不觸發（測試特意設 IDLE_MS≫OUT_TIMEOUT_MS）
    #    → 4 slot 被占死 → 新連線恆被拒（管理面 DoS）。修正後：out_deadline(=開始緩衝時 +
    #    OUT_TIMEOUT_MS 4s，不隨 n>0 刷新) 於 SWEEP 週期強制回收 → slot 釋放。
    attackers = []
    for _ in range(4):
        a = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        a.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 2048)  # 小接收視窗 → server 早卡 WANT_WRITE（同 case 3；2048 足夠完成握手）
        a.settimeout(8)
        a.connect(("127.0.0.1", 8443))
        ass = ctx.wrap_socket(a, server_hostname="127.0.0.1")     # 握手在此完成
        ass.send(b"GET /big HTTP/1.1\r\nHost:x\r\nConnection: close\r\n\r\n")
        attackers.append(ass)                                     # 之後永久不 recv → 占住 out_pending slot
    try:
        # (a) 佔滿證明：4 slot 全占 → 第 5 條連線 server accept 後因無 slot 立即被關 → 握手/收讀失敗。
        blocked = False
        try:
            with socket.create_connection(("127.0.0.1", 8443), timeout=3) as s5:
                with ctx.wrap_socket(s5, server_hostname="127.0.0.1") as ss5:
                    ss5.send(b"GET /echo HTTP/1.1\r\nHost:x\r\nConnection: close\r\n\r\n")
                    if not ss5.recv(64):
                        blocked = True                             # 立刻 EOF = slot 滿被關
        except Exception:
            blocked = True                                         # 握手期間被 reset 亦屬佔滿
        assert blocked, "expected 5th conn to be refused while 4 /big slots are occupied"

        # (b) 等待略長於 OUT_TIMEOUT_MS(4s) + 一個 SWEEP 週期(0.25s)，讓 out_deadline 回收 4 條占死的 conn。
        time.sleep(5.5)

        # (c) 回收證明：out_deadline 釋放 slot 後，另開 4 條新連線打 /echo 全部成功（4 slot 沒被永久占住）。
        #     未修版此處會逐一握手失敗/timeout（slot 仍被 out_pending 占死）。
        for _ in range(4):
            with socket.create_connection(("127.0.0.1", 8443), timeout=5) as s6:
                with ctx.wrap_socket(s6, server_hostname="127.0.0.1") as ss6:
                    ss6.send(b"GET /echo HTTP/1.1\r\nHost:x\r\nConnection: close\r\n\r\n")
                    d6 = b""
                    while True:
                        ch = ss6.recv(4096)
                        if not ch: break
                        d6 += ch
            assert b'"ok":1' in d6, ("write-slowloris recovery: echo failed after out_deadline reclaim", d6)
    finally:
        for ass in attackers:
            try: ass.close()
            except Exception: pass

    print("https OK")
finally:
    p.kill()

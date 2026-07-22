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
    print("https OK")
finally:
    p.kill()

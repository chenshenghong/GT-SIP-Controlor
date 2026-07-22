import subprocess, time, socket
p=subprocess.Popen(["build/test_webapi_tls"]); time.sleep(1.5)
try:
    # :80 對任意路徑回 301 → https（假設 test 殼同時起 :80，見 Step3）
    with socket.create_connection(("127.0.0.1",8080),timeout=5) as s:
        s.send(b"GET /get/device/status HTTP/1.1\r\nHost:127.0.0.1:8080\r\nConnection: close\r\n\r\n")
        d=s.recv(2048)
    assert b"301" in d and b"Location: https://" in d and b"/get/device/status" in d, d
    assert b"X-Frame-Options: SAMEORIGIN" in d, d
    print("redirect OK")
finally:
    p.kill()

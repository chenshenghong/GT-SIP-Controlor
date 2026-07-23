#!/usr/bin/env python3
"""S-T11 整合測試：跑「真正的」build/mzweb-x86（非 test_webapi_tls 假殼），驗證
init_sip_web_set_svr 的完整開機流程——憑證 bootstrap + 同時起 :443(TLS) 與 :80(301 gate)。

在 musl/alpine 容器內執行（需 root 綁 :80/:443 特權埠）：
  make x86-mzweb
  docker run --rm --platform linux/amd64 -v "$PWD":/src -w /src \
      python:3.12-alpine python3 tests/test_integration.py

驗證鏈（brief Step 2 ＋ Task 11 對抗審查補強）：
  A) 開機 mzcert_ensure 產出 /etc/sipweb/mz.{crt,key}（key 權限 0600）。
  A) 憑證 SAN 斷言：TLS 取 DER，斷言 SAN 的 iPAddress GeneralName（tag 87 04 <IP4>）
     ＝ device_ip（讀自 /etc/ifcfg-eth0 IPADDR）。這是本 task 招牌（IPADDR→SAN）的真驗證。
  A) https(:443) login → 32 字元 hex token；帶 token GET → 200（body 不含 A003）；無 token → 401。
  A) http(:80) GET → 301 Moved Permanently + Location: https://… + 安全標頭（X-Frame-Options）。
  B) fail-open（mzcert_ensure 失敗）：SN 在、IPADDR 空 → device_ip="" → mzcert_parse_ipv4 失敗
     → init_web_listen_tls early return、s_tls_ready 維持 0。斷言：:443 無 listener、
     :80 login 回 200 明文（API 可用）、回應無 Location: https://（未 301）。證明 fail-open 不 brick。
  C) Important-2 brick 回歸：憑證 bootstrap 正常但 :443 埠已被占 → bind(:443) 失敗。修後
     s_tls_ready 維持 0 → :80 回 200 明文、無 301（未 brick）。未修版此情境 s_tls_ready 已 1
     → :80 301 到被拒的 :443 → 每個請求都磚化——本測試對「s_tls_ready 移位」有鑑別力。

編碼備註（同 test_sec01.py）：login body 為 GBK + token 尾帶未跳脫 \\n（off-by-one）→
latin1 解位元組 + json.loads(strict=False)，token strip() 後才是 32 字元 hex。
"""
import subprocess, time, ssl, socket, os, stat, urllib.request, urllib.error, json, sys

CRT = "/etc/sipweb/mz.crt"
KEY = "/etc/sipweb/mz.key"
DEV_IP = "127.0.0.1"   # 連本機；device_ip 讀自 /etc/ifcfg-eth0 IPADDR → 憑證 SAN=IP

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE
https = urllib.request.build_opener(urllib.request.HTTPSHandler(context=ctx))

LOGIN_BODY = json.dumps({"username": "admin", "password": "123456"}).encode()


def write_ifcfg(with_ip):
    """SN 必在（缺→init_sip_web_set_svr 靜默不啟動）。with_ip 控制 IPADDR 是否存在——
    無 IPADDR → init 讀出 device_ip=""，逼 mzcert_ensure 走 fail-open 路徑。"""
    txt = "SN=P7TEST\n"
    if with_ip:
        txt += "IPADDR=%s\n" % DEV_IP
    txt += "NETMASK=255.255.255.0\nGATEWAY=127.0.0.1\n"
    open("/etc/ifcfg-eth0", "w").write(txt)


def fresh_certs():
    """全新開機情境：清殘留憑證，逼 mzcert_ensure 真正自簽（驗證 keygen bootstrap）。"""
    os.makedirs("/etc/sipweb", exist_ok=True)
    for f in (CRT, KEY):
        try:
            os.remove(f)
        except FileNotFoundError:
            pass


def wait_port(port, timeout, tls):
    """輪詢等指定埠就緒（tls=True 需能完成 TLS 握手）。回 True/False。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection((DEV_IP, port), timeout=2) as s:
                if tls:
                    with ctx.wrap_socket(s, server_hostname=DEV_IP):
                        return True
                else:
                    return True
        except Exception:
            time.sleep(0.3)
    return False


def get_cert_der(port=443):
    """取伺服器憑證 DER（binary_form 不需驗證即可取得，故 CERT_NONE 下仍有效）。"""
    with socket.create_connection((DEV_IP, port), timeout=5) as s:
        with ctx.wrap_socket(s, server_hostname=DEV_IP) as ss:
            return ss.getpeercert(binary_form=True)


def https_login():
    req = urllib.request.Request("https://%s:443/auth/login" % DEV_IP, data=LOGIN_BODY)
    raw = https.open(req, timeout=8).read()
    b = json.loads(raw.decode("latin1"), strict=False)
    return (b.get("token") or b.get("data", {}).get("token") or "").strip()


def http_raw(path, method="GET", body=None, port=80):
    """裸 socket 打明文 :80，回完整回應 bytes（含 status line/headers，看是否 301）。"""
    with socket.create_connection((DEV_IP, port), timeout=5) as s:
        head = "%s %s HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n" % (method, path, DEV_IP)
        if body is not None:
            head += "Content-Length: %d\r\n" % len(body)
        req = head.encode() + b"\r\n" + (body or b"")
        s.send(req)
        d = b""
        while True:
            ch = s.recv(4096)
            if not ch:
                break
            d += ch
    return d


def plaintext_login_token(d):
    """從明文 :80 login 回應 bytes 取 token（同 GBK/off-by-one 解法）。"""
    body = d.split(b"\r\n\r\n", 1)[1]
    b = json.loads(body.decode("latin1"), strict=False)
    return (b.get("token") or b.get("data", {}).get("token") or "").strip()


# ============================ Phase A：正常 TLS 上線 ============================
def phase_a_main():
    write_ifcfg(with_ip=True)
    fresh_certs()
    p = subprocess.Popen(["build/mzweb-x86"])
    try:
        assert wait_port(443, 30, tls=True), "TLS :443 未在時限內就緒（keygen/bootstrap 失敗？）"

        # 1) 憑證 bootstrap：自簽產檔，私鑰 0600。
        assert os.path.exists(CRT) and os.path.exists(KEY), "憑證未產生"
        mode = stat.S_IMODE(os.stat(KEY).st_mode)
        assert mode == 0o600, "私鑰權限非 0600: %o" % mode
        print("[A] bootstrap OK: cert self-signed, key mode 0600")

        # 2) SAN 斷言：DER 內須含 iPAddress GeneralName＝device_ip。
        #    mbedTLS 把 SAN IP 寫成 context-specific tag 7：`87 04 <a b c d>`（見 mzcert.c）。
        #    鑑別力：device_ip 為空時 mzcert_generate 直接失敗、根本無憑證/無 :443（Phase A 到不了此步）；
        #    若 SAN 綁錯 IP 或漏 SAN，此 6-byte 針序列即找不到 → 斷言失敗。
        der = get_cert_der()
        ip_bytes = bytes(int(x) for x in DEV_IP.split("."))
        needle = b"\x87\x04" + ip_bytes
        assert needle in der, "憑證 SAN 未含 device IP %s（needle=%s 不在 DER）" % (DEV_IP, needle.hex())
        print("[A] SAN OK: cert SAN iPAddress == %s (der needle %s)" % (DEV_IP, needle.hex()))

        # 3) https login → token；帶 token GET → 200；無 token → 401 + A003。
        tok = https_login()
        assert tok and len(tok) == 32, "https login token 異常: %r" % tok
        H = {"Authorization": "Bearer " + tok}
        req = urllib.request.Request("https://%s:443/get/device/status" % DEV_IP, headers=H)
        r = https.open(req, timeout=8)
        body = r.read().decode("latin1")
        assert r.status == 200, "https GET 非 200: %s" % r.status
        assert "A003" not in body, "https GET 帶 token 仍被擋: %s" % body[:80]
        try:
            https.open("https://%s:443/get/device/status" % DEV_IP, timeout=8)
            raise AssertionError("https GET 無 token 未擋")
        except urllib.error.HTTPError as e:
            assert e.code == 401 and b"A003" in e.read(), "無 token 未回 401/A003"
        print("[A] https login/token gate OK: 200 with token; 401 without")

        # 4) http :80 → 301 → https + 安全標頭（裸 socket 直接看 301，不跟隨轉址）。
        d = http_raw("/get/device/status", "GET")
        assert b"301 Moved Permanently" in d, "預期 301: %r" % d[:120]
        assert b"Location: https://" in d and b"/get/device/status" in d, "Location 缺 https/path: %r" % d[:200]
        assert b"X-Frame-Options: SAMEORIGIN" in d, "301 缺安全標頭: %r" % d[:200]
        print("[A] http :80 -> 301 https OK: %s" % d.split(b"\r\n", 1)[0].decode("latin1"))

        assert p.poll() is None, "server died"
    finally:
        p.kill()
        p.wait()


# ================= Phase B：fail-open（mzcert_ensure 失敗，不 brick） =================
def phase_b_fail_open():
    # SN 在但 IPADDR 空 → device_ip="" → mzcert_parse_ipv4("") 失敗 → mzcert_ensure 失敗。
    write_ifcfg(with_ip=False)
    fresh_certs()   # 無殘留憑證，確保走 generate 路徑（會因空 IP 失敗）
    p = subprocess.Popen(["build/mzweb-x86"])
    try:
        assert wait_port(80, 15, tls=False), "fail-open 下 :80 未就緒（server 未起？）"
        # :443 不該有 listener（init_web_listen_tls 已 early return）。
        assert not wait_port(443, 3, tls=True), "fail-open 下 :443 竟可 TLS 握手（未 fail-open？）"
        # :80 login → 200 明文、且回應無 301 轉址。
        d = http_raw("/auth/login", "POST", LOGIN_BODY)
        status = d.split(b"\r\n", 1)[0]
        assert b"200" in status, "fail-open :80 login 非 200: %r" % status
        assert b"Location: https://" not in d and b"301" not in status, "fail-open 竟 301 轉址: %r" % d[:200]
        tok = plaintext_login_token(d)
        assert tok and len(tok) == 32, "fail-open 明文 login token 異常: %r" % tok
        assert p.poll() is None, "fail-open 下 server 竟死亡（應降級續活）"
        print("[B] fail-open OK: :443 無 listener；:80 login 200 明文、無 301（s_tls_ready=0 語意成立）")
    finally:
        p.kill()
        p.wait()


# ============ Phase C：Important-2 brick 回歸（:443 bind 失敗仍不 brick） ============
def phase_c_bind_fail_no_brick():
    # 憑證 bootstrap 正常（IPADDR 在），但先占住 :443 令 mzweb 的 bind(:443) 失敗。
    write_ifcfg(with_ip=True)
    fresh_certs()
    squat = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    squat.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    squat.bind(("0.0.0.0", 443))
    squat.listen(8)
    p = subprocess.Popen(["build/mzweb-x86"])
    try:
        assert wait_port(80, 15, tls=False), ":80 未就緒"
        # 修後：cert OK 但 bind(:443) 失敗 → s_tls_ready 維持 0 → :80 明文、不 301。
        # 未修版：s_tls_ready 已在 bind 前設 1 → :80 301 到被 squat 占著（非 mzweb TLS）的 :443
        #         → 客戶端跟隨即失敗 → 設備 brick。此處直接驗 :80 未 301。
        d = http_raw("/auth/login", "POST", LOGIN_BODY)
        status = d.split(b"\r\n", 1)[0]
        assert b"200" in status, "bind 失敗時 :80 非 200（可能已 brick／301）: %r" % status
        assert b"Location: https://" not in d and b"301" not in status, \
            "Important-2 brick：:443 bind 失敗卻仍 301（s_tls_ready 未正確維持 0）: %r" % d[:200]
        tok = plaintext_login_token(d)
        assert tok and len(tok) == 32, "bind 失敗時明文 login token 異常: %r" % tok
        assert p.poll() is None, "server 竟死亡"
        print("[C] brick 回歸 OK: :443 bind 失敗 → :80 續 200 明文、無 301（未 brick）")
    finally:
        p.kill()
        p.wait()
        squat.close()


if __name__ == "__main__":
    try:
        phase_a_main()
        phase_b_fail_open()
        phase_c_bind_fail_no_brick()
        print("integration OK")
    except Exception:
        sys.stdout.flush()
        raise

# mzweb v6.1.2 安全強化（P0＋P1）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 P7 mzweb（`docs/multi-zone-poc/src/mzweb/`）從「重現 v2.1.1 不安全行為」提升到符合《設備Web安全強化需求單 v6.1.2》P0＋P1：HTTPS（mbedTLS 靜態、設備端自簽 SAN=IP）、GET 加 token、密碼遮蔽/雜湊、登入鎖定、改密複雜度、cJSON escape、FW JSON 修正。

**Architecture:** 靜態 vendor mbedTLS 進 mzweb（同 cJSON 套路，muslcc 靜態 armv7 單一二進位）。webapi.c 加 `:443` 非阻塞 TLS 終結（handshake 整合進既有 poll event loop，不阻塞單執行緒）＋`:80`→301＋安全標頭。新 `mzcert` 模組設備端自簽（Grandstream 業界做法）。鑑權/資料強化與 FW 修正走既有 `websetsip-p7.patch` 擴充，回應改 cJSON 建構。

**Tech Stack:** C（musl static armv7）、mbedTLS（vendor pin）、cJSON（已 vendor）、Docker muslcc、python3 測試 harness、真機 `192.168.0.70`（root SSH :9521，經 `mzctl.py`）。

## Global Constraints

- 承接 P7 mzweb 全部 Global Constraints（見 `docs/superpowers/plans/2026-07-22-p7-mzweb-websetsip.md`）：GBK 原始碼直編不加 `-finput-charset`；相容層簽名不可改；資源邊界（併發 4/URL 2KB/headers 8KB/body 32KB/idle 30s）；原廠碼經 `websetsip-p7.patch` 進版控（`docs/firmware-reference/websetsip.c` 不進版控）。
- 交叉編譯：muslcc `arm-linux-musleabi`（真機 armv7）＋`x86_64-linux-musl`（容器測試），`-static -no-pie -fno-pie -O2 -I.`。
- **mbedTLS 精簡 config**（26MB RAM）：只開 TLS 1.2＋RSA/AES-GCM/SHA-256、`x509` 憑證產生（`MBEDTLS_X509_CRT_WRITE_C`/`MBEDTLS_PEM_WRITE_C`/`MBEDTLS_RSA_C`）、關不需模組；量測靜態體積與 RSS。
- **TLS 非阻塞硬條款**：TLS handshake 多輪往返**不可阻塞** poll event loop（單執行緒單核 Goke）；用 mbedTLS 非阻塞 BIO（`MBEDTLS_ERR_SSL_WANT_READ/WRITE` 回 poll），每 conn 帶 TLS 狀態機，比照既有 partial-read 狀態機。
- **憑證（設備端自簽，Grandstream 業界做法）**：RSA-2048 自簽、**SAN=IP 必要**（現代瀏覽器只認 SAN）、`daysValid=3650`、私鑰 `chmod 600` 存 `/etc/sipweb/`（持久分區）；首開背景產生、改 IP 重簽；憑證未就緒前 `:80` 不 301（避免無處可轉）。
- **CMS 已 https-first＋token-on-all**（`deviceApi.ts`）；SEC-01/03 對 CMS 透明，本計畫不改 CMS。
- 原廠 handler 精確位置（`docs/firmware-reference/websetsip.utf8.c`）：`get_token_string`@60、`request_login_cmd`@151（WEB_PASSWORD 比對@207-208）、`request_change_password_cmd`@316（比對@395、寫@404）、`request_get_device_status`@514（FW-01@572、FW-02@580）、`request_get_sip_config`@790（PRIMARY_PASSWORD@797/862、BACKUP_PASSWORD@805/869）；dispatch 6 個免 token GET @2721/2733/2739/2775/2781/2799。
- 工作目錄 `docs/multi-zone-poc/src/mzweb/`；每 task 結尾 commit，訊息尾附 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`；commit 只 `git add docs/multi-zone-poc/src/mzweb`，不夾帶工作樹既有變更。
- 真機驗收（T12）替換 .70 前沿用 P7 mzdeploy 備份/rollback；.70 現已跑 P7 mzweb（明文），本階段升級為 HTTPS 版。

---

### Task 1: Vendor mbedTLS＋精簡 config＋靜態 armv7 建置 smoke

**Files:**
- Create: `docs/multi-zone-poc/src/mzweb/mbedtls/`（vendor 原始碼子集）、`mbedtls_config.h`（精簡）
- Modify: `docs/multi-zone-poc/src/mzweb/Makefile`
- Test: `docs/multi-zone-poc/src/mzweb/tests/test_mbedtls_smoke.c`

**Interfaces:**
- Produces: Makefile 可把 mbedTLS 靜態編入 mzweb 目標；`MBEDTLS_CONFIG_FILE` 指向精簡 config。後續 task 可 `#include "mbedtls/ssl.h"` 等。

- [ ] **Step 1: Vendor mbedTLS（pin 版本）**

```bash
cd docs/multi-zone-poc/src/mzweb
curl -fsSL -o /tmp/mbedtls.tar.gz https://github.com/Mbed-TLS/mbedtls/releases/download/mbedtls-3.6.2/mbedtls-3.6.2.tar.bz2 || \
  curl -fsSL -o /tmp/mbedtls.tar.gz https://github.com/Mbed-TLS/mbedtls/archive/refs/tags/mbedtls-3.6.2.tar.gz
mkdir -p mbedtls && tar xf /tmp/mbedtls.tar.gz -C mbedtls --strip-components=1
# 只保留 library/ include/ 供靜態編；移除 tests/programs/docs 減體積
rm -rf mbedtls/tests mbedtls/programs mbedtls/docs mbedtls/.git*
```
> 若下載失敗回報 BLOCKED（vendor 依賴）。pin `mbedtls-3.6.2`（LTS）。

- [ ] **Step 2: 精簡 config `mbedtls_config.h`**

```c
/* mzweb 精簡 mbedTLS config：只開 TLS1.2 server + RSA/AES-GCM/SHA-256 + x509 憑證產生。 */
#ifndef MZWEB_MBEDTLS_CONFIG_H
#define MZWEB_MBEDTLS_CONFIG_H
#define MBEDTLS_SSL_PROTO_TLS1_2
#define MBEDTLS_SSL_SRV_C
#define MBEDTLS_SSL_TLS_C
#define MBEDTLS_RSA_C
#define MBEDTLS_PKCS1_V15
#define MBEDTLS_AES_C
#define MBEDTLS_GCM_C
#define MBEDTLS_SHA256_C
#define MBEDTLS_SHA224_C
#define MBEDTLS_MD_C
#define MBEDTLS_PK_C
#define MBEDTLS_PK_PARSE_C
#define MBEDTLS_PK_WRITE_C
#define MBEDTLS_X509_USE_C
#define MBEDTLS_X509_CRT_PARSE_C
#define MBEDTLS_X509_CRT_WRITE_C
#define MBEDTLS_X509_CREATE_C
#define MBEDTLS_PEM_PARSE_C
#define MBEDTLS_PEM_WRITE_C
#define MBEDTLS_BASE64_C
#define MBEDTLS_OID_C
#define MBEDTLS_ASN1_PARSE_C
#define MBEDTLS_ASN1_WRITE_C
#define MBEDTLS_BIGNUM_C
#define MBEDTLS_CTR_DRBG_C
#define MBEDTLS_ENTROPY_C
#define MBEDTLS_CIPHER_C
#define MBEDTLS_ECP_C
#define MBEDTLS_ECDH_C
#define MBEDTLS_KEY_EXCHANGE_ECDHE_RSA_ENABLED
#define MBEDTLS_KEY_EXCHANGE_RSA_ENABLED
#define MBEDTLS_SSL_CIPHERSUITES MBEDTLS_TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256, MBEDTLS_TLS_RSA_WITH_AES_128_GCM_SHA256
#define MBEDTLS_NO_PLATFORM_ENTROPY   /* uClibc/musl：無 /dev/hwrng 假設，用 /dev/urandom */
#define MBEDTLS_ENTROPY_HARDWARE_ALT  /* 由 mzcert 提供 /dev/urandom entropy callback */
#include "mbedtls/check_config.h"
#endif
```
> 實作時以 `mbedtls/check_config.h` 編譯驗證相依閉合；缺哪個相依補哪個（如 ECP 需 `MBEDTLS_ECP_DP_SECP256R1_ENABLED`）。目標是能編、能 TLS1.2 server handshake、能寫自簽 x509。

- [ ] **Step 3: Makefile 加 mbedTLS 靜態編**

```makefile
# 追加到既有 Makefile
MBEDTLS_SRC = $(wildcard mbedtls/library/*.c)
MBEDTLS_INC = -Imbedtls/include -I. -DMBEDTLS_CONFIG_FILE='"mbedtls_config.h"'
COMPAT += $(MBEDTLS_SRC)
CFLAGS += $(MBEDTLS_INC)
```
> mbedTLS library 全量編（config 關掉的模組多數自成無符號）；若體積過大再挑檔。

- [ ] **Step 4: 寫 smoke 測試（能 init TLS＋entropy）**

`tests/test_mbedtls_smoke.c`：
```c
#include <stdio.h>
#include "mbedtls/ssl.h"
#include "mbedtls/ctr_drbg.h"
#include "mbedtls/entropy.h"
#include "mbedtls/x509_crt.h"
int main(void){
    mbedtls_ssl_config conf; mbedtls_ssl_config_init(&conf);
    mbedtls_ctr_drbg_context drbg; mbedtls_ctr_drbg_init(&drbg);
    mbedtls_x509write_cert crt; mbedtls_x509write_crt_init(&crt);  /* 驗證憑證產生模組編入 */
    printf("mbedtls smoke OK\n");
    mbedtls_ssl_config_free(&conf); mbedtls_ctr_drbg_free(&drbg);
    return 0;
}
```
Makefile 加 `COMPAT_TEST_mbedtls_smoke = $(MBEDTLS_SRC)`。

- [ ] **Step 5: 跑失敗→實作→通過**

Run: `make host-mbedtls_smoke`（首輪若 config 相依缺會編譯失敗）→ 修 config 至閉合 → `docker run --rm --platform linux/amd64 -v "$PWD":/src -w /src python:3.12-alpine build/test_mbedtls_smoke` → 印 `mbedtls smoke OK`。
Expected: `mbedtls smoke OK`。

- [ ] **Step 6: 驗證 arm 靜態編＋量體積**

Run: `make clean && make arm-mzweb 2>&1 | tail; file build/mzweb-arm; ls -la build/mzweb-arm`
Expected: `ELF 32-bit LSB executable, ARM, statically linked`；記錄體積（估 <1.5MB）。**注意** arm-mzweb 依賴 T3+ 的 TLS wiring 尚未存在——本 task 若 arm-mzweb 因後續程式碼未就緒編不過，只需確認 `host-mbedtls_smoke` 綠＋mbedTLS 原始碼能被 muslcc 編（可另建純 mbedTLS 靜態 lib 目標驗證），arm 整合留到 T11。

- [ ] **Step 7: Commit**

```bash
git add docs/multi-zone-poc/src/mzweb
git commit -m "feat(mzweb): T1 vendor mbedTLS 3.6.2＋精簡 config＋靜態編 smoke"
```

---

### Task 2: mzcert — 設備端自簽憑證（SAN=IP）產生／載入

**Files:**
- Create: `docs/multi-zone-poc/src/mzweb/mzcert.c`、`mzcert.h`
- Modify: `Makefile`
- Test: `tests/test_mzcert.c`

**Interfaces:**
- Produces:
```c
/* mzcert.h */
/* 若 crt/key 不存在則以 SAN=ip 自簽產生（RSA-2048, 3650 天）並寫檔(key chmod 600)；已存在則不動。回 0 成功。 */
int mzcert_ensure(const char* crt_path, const char* key_path, const char* ip);
/* 載入 crt/key 到 mbedTLS 結構供 ssl_conf 用。回 0 成功。 */
int mzcert_load(const char* crt_path, const char* key_path,
                mbedtls_x509_crt* crt_out, mbedtls_pk_context* key_out,
                mbedtls_ctr_drbg_context* drbg);
/* 刪除 crt/key（改 IP 重簽用）。 */
void mzcert_invalidate(const char* crt_path, const char* key_path);
```

- [ ] **Step 1: 寫測試**

`tests/test_mzcert.c`：
```c
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "mbedtls/x509_crt.h"
#include "mbedtls/ctr_drbg.h"
#include "mbedtls/entropy.h"
#include "mzcert.h"
int main(void){
    unlink("/tmp/mz.crt"); unlink("/tmp/mz.key");
    assert(mzcert_ensure("/tmp/mz.crt","/tmp/mz.key","192.168.0.70")==0);
    /* 檔存在 */
    FILE* f=fopen("/tmp/mz.key","r"); assert(f); fclose(f);
    /* 載入解析成功 */
    mbedtls_x509_crt crt; mbedtls_x509_crt_init(&crt);
    mbedtls_pk_context key; mbedtls_pk_init(&key);
    mbedtls_entropy_context ent; mbedtls_entropy_init(&ent);
    mbedtls_ctr_drbg_context drbg; mbedtls_ctr_drbg_init(&drbg);
    mbedtls_ctr_drbg_seed(&drbg,mbedtls_entropy_func,&ent,(const unsigned char*)"mzcert",6);
    assert(mzcert_load("/tmp/mz.crt","/tmp/mz.key",&crt,&key,&drbg)==0);
    /* 憑證含 SAN=IP：dump subject alt name 應含 192.168.0.70 */
    char buf[2048]; mbedtls_x509_crt_info(buf,sizeof(buf),"",&crt);
    assert(strstr(buf,"192.168.0.70")!=NULL);
    printf("mzcert OK\n");
    return 0;
}
```
Makefile 加 `COMPAT_TEST_mzcert = mzcert.c $(MBEDTLS_SRC)`。

- [ ] **Step 2: 跑確認失敗**

Run: `make host-mzcert`
Expected: FAIL（mzcert.h 不存在）。

- [ ] **Step 3: 實作 mzcert.c**

要點（完整寫出、不留 stub）——用 mbedTLS `x509write`：
- entropy：`/dev/urandom`（uClibc/musl 皆有）→ `mbedtls_ctr_drbg_seed`。
- keygen：`mbedtls_pk_setup(RSA)` + `mbedtls_rsa_gen_key(2048, 65537)`。
- cert：`mbedtls_x509write_crt_set_subject_name("CN=GT-SIP-GW,O=Guangtian Information,C=TW")`、`set_issuer_name`（同 subject＝自簽）、`set_serial`、`set_validity("20260101000000","20360101000000")`、`set_md_alg(SHA256)`、`set_basic_constraints(is_ca=0)`。
- **SAN=IP**：`mbedtls_x509write_crt_set_subject_alternative_name`（3.6 API；填 `MBEDTLS_X509_SAN_IP_ADDRESS`＋4 bytes IP）；若該 API 不可用則手刻 GeneralNames DER（見 SEC-03 文件 `30 06 87 04 <a b c d>`）。
- 寫檔：`mbedtls_x509write_crt_pem` → crt_path；`mbedtls_pk_write_key_pem` → key_path 後 `chmod(key_path, 0600)`。
- `mzcert_ensure`：兩檔皆存在則 return 0（不重簽）；否則產生。
- `mzcert_load`：`mbedtls_x509_crt_parse_file` + `mbedtls_pk_parse_keyfile`。

`mzcert.h` 如 Interfaces。

- [ ] **Step 4: 跑確認通過**

Run: `make host-mzcert && docker run --rm --platform linux/amd64 -v "$PWD":/src -w /src python:3.12-alpine build/test_mzcert`
Expected: `mzcert OK`（憑證產生、載入、SAN 含 IP）。額外用 openssl 交叉驗（mac 有）：`openssl x509 -in /tmp/mz.crt -noout -text | grep -A1 "Subject Alternative Name"` 應見 `IP Address:192.168.0.70`。

- [ ] **Step 5: Commit**

```bash
git add docs/multi-zone-poc/src/mzweb
git commit -m "feat(mzweb): T2 mzcert 設備端自簽憑證(SAN=IP, RSA-2048, mbedTLS x509write)"
```

---

### Task 3: webapi TLS 層 — :443 非阻塞 handshake＋TLS read/write

**Files:**
- Modify: `docs/multi-zone-poc/src/mzweb/webapi.c`、`webapi.h`
- Test: `tests/test_webapi_tls.c`（server 殼）＋`tests/https_test.py`

**Interfaces:**
- Consumes: T2 `mzcert_ensure`/`mzcert_load`；既有 event loop `ev_reg_fd`/`ev_unreg_fd`/`event_loop_step`、conn 結構、`http_callback`。
- Produces:
```c
/* webapi.h 擴充 */
void init_web_listen_tls(int https_port, http_callback_fn cb, struct event_loop* loop,
                         const char* crt_path, const char* key_path, const char* ip);
/* web_snd_data 對 TLS conn 改走 mbedtls_ssl_write（內部依 conn->is_tls 分流；簽名不變） */
```
- conn 結構加：`int is_tls; mbedtls_ssl_context ssl; int hs_done;`（TLS 狀態）。

- [ ] **Step 1: 寫測試（TLS server 殼＋python https 客戶端）**

`tests/test_webapi_tls.c`（:8443 起 TLS echo，重用 T5 的 cb 概念）：
```c
#include <stdio.h>
#include "event.h"
#include "webapi.h"
static int cb(void* client, void* hh, int type, const char* content, int clen){
    char* url; int ul; get_http_url(hh,&url,&ul);
    if(type==APP_REQUEST_CMD && ul==5 && strncmp("/echo",url,ul)==0){
        const char* body="{\"ok\":1}";
        char resp[256]; int n=snprintf(resp,sizeof(resp),
          "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 8\r\nConnection: close\r\n\r\n%s",body);
        web_snd_data(client,resp,n);
    }
    return 0;
}
int main(void){
    struct event_loop* l=get_main_event_loop();
    init_web_listen_tls(8443, cb, l, "/tmp/mzt.crt","/tmp/mzt.key","127.0.0.1");
    printf("tls listening 8443\n"); fflush(stdout);
    event_loop_run(l); return 0;
}
```
`tests/https_test.py`：
```python
import subprocess, time, ssl, socket, json
p=subprocess.Popen(["build/test_webapi_tls"]); time.sleep(1.5)  # 首開 keygen 需時間
try:
    ctx=ssl.create_default_context(); ctx.check_hostname=False; ctx.verify_mode=ssl.CERT_NONE
    with socket.create_connection(("127.0.0.1",8443),timeout=8) as s:
        with ctx.wrap_socket(s,server_hostname="127.0.0.1") as ss:
            ss.send(b"GET /echo HTTP/1.1\r\nHost:x\r\nConnection: close\r\n\r\n")
            data=b""
            while True:
                c=ss.recv(4096)
                if not c: break
                data+=c
    assert b"200 OK" in data and b'"ok":1' in data, data
    # 分段送(非阻塞 handshake+partial read 在 TLS 上仍成立)
    with socket.create_connection(("127.0.0.1",8443),timeout=8) as s:
        with ctx.wrap_socket(s,server_hostname="127.0.0.1") as ss:
            ss.send(b"GET /ec"); time.sleep(0.05); ss.send(b"ho HTTP/1.1\r\nHost:x\r\nConnection: close\r\n\r\n")
            d=ss.recv(4096)
    assert b"200 OK" in d
    print("https OK")
finally:
    p.kill()
```
Makefile 加 `COMPAT_TEST_webapi_tls = event.c webapi.c socketbase.c mzcert.c $(MBEDTLS_SRC)`；測試前先 `mzcert_ensure` 產 /tmp/mzt.crt（可在 main 開頭呼叫或 https_test.py 前置）。

- [ ] **Step 2: 跑確認失敗**

Run: `make host-webapi_tls`
Expected: FAIL（`init_web_listen_tls` 未定義）。

- [ ] **Step 3: 實作 webapi.c TLS 層（完整、不留 stub）**

結構（整合進既有 poll 迴圈）：
- `init_web_listen_tls`：`mzcert_ensure` → `mzcert_load` → 建 `mbedtls_ssl_config`（`MBEDTLS_SSL_IS_SERVER`、`mbedtls_ssl_conf_own_cert`、`mbedtls_ssl_conf_rng`）；`:443` listen fd 註冊進 event loop（同既有 :80 listen）。
- accept 新 TLS conn：`conn->is_tls=1`；`mbedtls_ssl_setup(&conn->ssl,&conf)`；`mbedtls_ssl_set_bio(&conn->ssl, conn, ssl_send_cb, ssl_recv_cb, NULL)`——BIO callback 用**非阻塞** `send`/`recv`，回 `MBEDTLS_ERR_SSL_WANT_READ/WRITE` 當 EAGAIN。
- `on_tls_conn_readable`：若 `!hs_done` → `mbedtls_ssl_handshake`，回 WANT_READ/WRITE 就 return（等下次 poll，**不阻塞**），回 0 則 `hs_done=1`；handshake 完成後才走既有 HTTP 解析（recv 改 `mbedtls_ssl_read` 累積）。
- `web_snd_data`：`if(c->is_tls) mbedtls_ssl_write(&c->ssl,...)` 迴圈到寫完（WANT_WRITE 重試）；否則既有 `send(MSG_NOSIGNAL)`。
- `conn_close`：TLS conn 先 `mbedtls_ssl_close_notify` + `mbedtls_ssl_free`，再 `ev_unreg_fd`+`close`。
- **資源邊界＋idle timeout 沿用**（TLS conn 也計入 MAX_CONNS=4、idle sweep）。handshake 逾時（如 10s 未完成）也走 idle 關閉，防 TLS slow-loris。

**逐段寫完，特別是非阻塞 handshake 的 WANT_READ/WRITE 回 poll 迴圈這段。**

- [ ] **Step 4: 跑確認通過**

Run: `make host-webapi_tls && docker run --rm --platform linux/amd64 -v "$PWD":/src -w /src python:3.12-alpine sh -c 'python3 tests/https_test.py'`
Expected: `https OK`（TLS handshake＋分段 partial-read 皆過）。

- [ ] **Step 5: Commit**

```bash
git add docs/multi-zone-poc/src/mzweb
git commit -m "feat(mzweb): T3 webapi :443 非阻塞 TLS 終結(mbedTLS handshake 整合 poll loop)"
```

---

### Task 4: :80→301 轉址＋安全回應標頭

**Files:**
- Modify: `docs/multi-zone-poc/src/mzweb/webapi.c`
- Test: `tests/redirect_test.py`（擴充既有 http/https 測試）

**Interfaces:**
- Consumes: T3 TLS 層；既有 :80 listener。
- Produces: `:80` 對所有路徑回 `301 Location: https://<Host><path>`（憑證就緒後）；所有回應（301＋TLS）帶安全標頭。以 file-scope flag `s_tls_ready` gate 301（未就緒不轉）。

- [ ] **Step 1: 寫測試**

`tests/redirect_test.py`：
```python
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
```
> test 殼（test_webapi_tls）需同時起 :8080(http 301) 與 :8443(https)；Step3 調整殼。

- [ ] **Step 2: 跑確認失敗**

Run: `make host-webapi_tls && docker run ... python3 tests/redirect_test.py`
Expected: FAIL（:80 尚未 301、無安全標頭）。

- [ ] **Step 3: 實作**

- webapi.c 加 `s_tls_ready`（T3 handshake 就緒/憑證載入成功時設 1）。
- `:80` 的 `http_callback` 路徑：`if(s_tls_ready)` → 直接回 `HTTP/1.1 301 Moved Permanently\r\nLocation: https://<Host><url>\r\n` ＋安全標頭 ＋`Connection: close`，**不 dispatch 到路由**；`!s_tls_ready` → 暫維持既有 http 服務（首開窗口）。
- 安全標頭 helper `append_security_headers(char* buf)`：`X-Frame-Options: SAMEORIGIN`、`X-Content-Type-Options: nosniff`、`X-XSS-Protection: 1; mode=block`——所有回應（含 TLS 路由回應、301、404）套用。
- test 殼加 `:8080` http listener（301）＋`:8443` https，供 redirect_test.py。

- [ ] **Step 4: 跑確認通過**

Run: `make host-webapi_tls && docker run ... sh -c 'python3 tests/redirect_test.py && python3 tests/https_test.py'`
Expected: `redirect OK`＋`https OK`。

- [ ] **Step 5: Commit**

```bash
git add docs/multi-zone-poc/src/mzweb
git commit -m "feat(mzweb): T4 :80→301 強制 https＋安全回應標頭(X-Frame-Options 等)"
```

---

### Task 5: Patch SEC-01 — 6 個 GET 加 token 驗證

**Files:**
- Modify: `docs/multi-zone-poc/src/mzweb/websetsip-p7.patch`
- Test: `tests/test_sec01.py`（容器起 mzweb-x86）

**Interfaces:**
- Consumes: T7(P7) 的 `mzweb_check_token(client, http_head)`（驗 token 回 0/失敗自回 A003 並回 -1）。
- Produces: dispatch @2721/2733/2739/2775/2781/2799 的 6 個 GET 在呼叫 handler 前加 `if(mzweb_check_token(client, http_head)!=0) break;`。

- [ ] **Step 1: 寫容器測試**

`tests/test_sec01.py`（沿用 P7 test 起 mzweb-x86 + fixtures）：
```python
import subprocess, time, urllib.request, urllib.error, json
open("/etc/ifcfg-eth0","w").write("SN=P7TEST\n")
p=subprocess.Popen(["build/mzweb-x86"]); time.sleep(1)
def login():
    r=urllib.request.Request("http://127.0.0.1:80/auth/login",
        data=json.dumps({"username":"admin","password":"123456"}).encode())
    b=urllib.request.urlopen(r,timeout=5).read().decode("latin1")
    import re; return re.search(r'"token":\s*"([0-9a-f]+)',b).group(1)
try:
    tok=login()
    for path in ["/get/device/status","/get/device/volume","/get/sip/config",
                 "/get/call/status","/get/network/config","/system/info"]:
        # 無 token → A003(body 內), HTTP 仍 200
        b=urllib.request.urlopen("http://127.0.0.1:80"+path,timeout=5).read().decode("latin1")
        assert "A003" in b, f"{path} 無 token 未擋: {b[:80]}"
        # 帶 token → 不含 A003
        r=urllib.request.Request("http://127.0.0.1:80"+path,headers={"Authorization":"Bearer "+tok})
        b2=urllib.request.urlopen(r,timeout=5).read().decode("latin1")
        assert "A003" not in b2, f"{path} 帶 token 仍擋"
    print("sec01 OK")
finally:
    p.kill()
```
> 注意：本階段 mzweb 仍 http（TLS 整合在 T11），故 test 打 :80。

- [ ] **Step 2: 跑確認失敗**

Run: `make x86-mzweb && docker run ... python3 tests/test_sec01.py`
Expected: FAIL（GET 無 token 未回 A003）。

- [ ] **Step 3: 擴充 patch**

在 6 個 GET dispatch 分支（@2721 等）的 `strncmp(...)==0` 之後、呼叫 `request_get_*` 之前插入：
```c
if (mzweb_check_token(client, http_head) != 0) break;
```
> `mzweb_check_token` 已在 T7 patch 定義（驗 token、失敗自回 A003＋回 -1）。注意 http_callback 的這些 GET 分支原本簽名只傳 `client`（無 http_head）——需確認 dispatch scope 有 `http_head`（有，`get_http_url` 就用它）。

產 patch：`diff -u` 更新 `websetsip-p7.patch`；`make clean && make x86-mzweb` 重放成功。

- [ ] **Step 4: 跑確認通過**

Run: `make x86-mzweb && docker run ... python3 tests/test_sec01.py`
Expected: `sec01 OK`。

- [ ] **Step 5: Commit**

```bash
git add docs/multi-zone-poc/src/mzweb
git commit -m "feat(mzweb): T5 SEC-01 6 個 GET 端點加 Bearer token 驗證(重用 mzweb_check_token)"
```

---

### Task 6: Patch SEC-09＋FW-01/02 — get_device_status／get_sip_config 改 cJSON 建構

**Files:**
- Modify: `docs/multi-zone-poc/src/mzweb/websetsip-p7.patch`
- Test: `tests/test_sec09_fw.py`

**Interfaces:**
- Consumes: 已 vendor 的 cJSON（`cjson.h`）。
- Produces: `request_get_device_status`（@514）與 `request_get_sip_config`（@790）回應改用 `cJSON_CreateObject`/`AddStringToObject`/`AddNumberToObject`/`cJSON_PrintUnformatted` 建構（自動 escape），`device_info`/`network_info` 為 root 同層（FW-02）、`broadcast_volume` key 正確（FW-01）。

- [ ] **Step 1: 寫測試**

`tests/test_sec09_fw.py`：
```python
import subprocess, time, urllib.request, json, re
open("/etc/ifcfg-eth0","w").write("SN=P7TEST\n")
# 種一個含特殊字元的 SIP 密碼(SEC-09 escape 驗證)
p=subprocess.Popen(["build/mzweb-x86"]); time.sleep(1)
def login():
    r=urllib.request.Request("http://127.0.0.1:80/auth/login",data=json.dumps({"username":"admin","password":"123456"}).encode())
    return re.search(r'"token":\s*"([0-9a-f]+)',urllib.request.urlopen(r,timeout=5).read().decode("latin1")).group(1)
try:
    tok=login(); H={"Authorization":"Bearer "+tok}
    # FW-01/02: /get/device/status 為合法 JSON、device_info/network_info 在 root 同層
    b=urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:80/get/device/status",headers=H),timeout=5).read().decode("gbk","replace")
    d=json.loads(b)  # 必須可直接 parse(不需 cleanDirtyJSON)
    assert "device_info" in d and "network_info" in d, "device_info/network_info 不在 root(FW-02 未修)"
    assert "broadcast_volume" in json.dumps(d), "broadcast_volume key 缺(FW-01 未修)"
    print("sec09_fw OK")
finally:
    p.kill()
```

- [ ] **Step 2: 跑確認失敗**

Run: `make x86-mzweb && docker run ... python3 tests/test_sec09_fw.py`
Expected: FAIL（json.loads 炸 or device_info 不在 root）。

- [ ] **Step 3: 擴充 patch**

- `request_get_device_status`：把 @572-580 那段手打格式字串的 `snprintf` 整段改為 cJSON 建構——建 root、`sip_status`（含 primary/backup/multicast_status）、`device_info`（root 同層、含 `broadcast_volume`/`microphone_volume`/model/versions）、`network_info`（root 同層），`cJSON_PrintUnformatted` 後 `web_snd_data`。**三層物件正確閉合，device_info/network_info 為 root 直屬。**
- `request_get_sip_config`：同法改 cJSON 建構（primary_line/backup_line/parameters/codecs 各物件），自動 escape 特殊字元。
> 保持回應**欄位名與結構**與原輸出一致（除 FW 修正）；用 `cJSON_PrintUnformatted` 避免空白差異。回應仍 `charset=GBK`（GBK 字節由 config 值原樣進 cJSON string，cJSON escape 只處理 `"`/`\`/控制字元，不改 GBK 高位元組——驗證 CMS 端 GBK decode 仍正常）。

產 patch、重放。

- [ ] **Step 4: 跑確認通過**

Run: `make x86-mzweb && docker run ... python3 tests/test_sec09_fw.py`
Expected: `sec09_fw OK`。

- [ ] **Step 5: Commit**

```bash
git add docs/multi-zone-poc/src/mzweb
git commit -m "feat(mzweb): T6 SEC-09＋FW-01/02 get_device_status/get_sip_config 改 cJSON 建構(合法 JSON+escape)"
```

---

### Task 7: Patch SEC-02 — get_sip_config 密碼遮蔽

**Files:**
- Modify: `docs/multi-zone-poc/src/mzweb/websetsip-p7.patch`
- Test: `tests/test_sec02.py`

**Interfaces:**
- Consumes: T6 的 cJSON 化 `request_get_sip_config`。
- Produces: `PRIMARY_PASSWORD`/`BACKUP_PASSWORD` 欄輸出恆為 `********`（不論實際值）。

- [ ] **Step 1: 寫測試**

`tests/test_sec02.py`：
```python
import subprocess, time, urllib.request, json, re
open("/etc/ifcfg-eth0","w").write("SN=P7TEST\n")
p=subprocess.Popen(["build/mzweb-x86"]); time.sleep(1)
def login():
    r=urllib.request.Request("http://127.0.0.1:80/auth/login",data=json.dumps({"username":"admin","password":"123456"}).encode())
    return re.search(r'"token":\s*"([0-9a-f]+)',urllib.request.urlopen(r,timeout=5).read().decode("latin1")).group(1)
try:
    tok=login(); H={"Authorization":"Bearer "+tok}
    b=urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:80/get/sip/config",headers=H),timeout=5).read().decode("gbk","replace")
    d=json.loads(b)
    # 找所有 password 欄，皆須為 ********
    def walk(o):
        if isinstance(o,dict):
            for k,v in o.items():
                if k=="password": assert v=="********", f"密碼未遮蔽: {v}"
                walk(v)
    walk(d)
    print("sec02 OK")
finally:
    p.kill()
```
> fixtures 需先讓 /etc/ifcfg-sip 有非空 PRIMARY_PASSWORD（可在測試前 echo 一個，或原廠 init 預設）。

- [ ] **Step 2: 跑確認失敗**

Run: `make x86-mzweb && docker run ... python3 tests/test_sec02.py`
Expected: FAIL（回明文密碼）。

- [ ] **Step 3: 擴充 patch**

在 T6 cJSON 化的 `request_get_sip_config` 中，`primary_line`/`backup_line` 的 `password` 欄一律 `cJSON_AddStringToObject(line, "password", "********")`（不讀 `PRIMARY_PASSWORD`/`BACKUP_PASSWORD` 實際值）。產 patch、重放。

- [ ] **Step 4: 跑確認通過**

Run: `make x86-mzweb && docker run ... python3 tests/test_sec02.py`
Expected: `sec02 OK`。

- [ ] **Step 5: Commit**

```bash
git add docs/multi-zone-poc/src/mzweb
git commit -m "feat(mzweb): T7 SEC-02 get_sip_config 密碼欄遮蔽為 ********"
```

---

### Task 8: Patch SEC-04 — WEB_PASSWORD 雜湊＋就地遷移

**Files:**
- Modify: `docs/multi-zone-poc/src/mzweb/websetsip-p7.patch`
- Create: `docs/multi-zone-poc/src/mzweb/mzhash.c`、`mzhash.h`（SHA-256+salt helper）
- Modify: `Makefile`
- Test: `tests/test_mzhash.c`＋`tests/test_sec04.py`

**Interfaces:**
- Produces:
```c
/* mzhash.h */
/* 產生 "sha256$<hex-salt>$<hex-hash>"（salt 16 bytes 隨機）寫入 out(需 ≥96 bytes)。 */
void mzhash_make(const char* password, char* out, int out_sz);
/* 驗證 password 對 stored；stored 為 sha256$… 走雜湊比對，否則(舊明文)走明文比對。回 1 符合。 */
int mzhash_verify(const char* password, const char* stored);
/* stored 是否為舊明文格式(無 sha256$ 前綴)。 */
int mzhash_is_legacy(const char* stored);
```
- 用 mbedTLS `mbedtls_sha256`＋`mbedtls_ctr_drbg` 產 salt。

- [ ] **Step 1: 寫 mzhash 單元測試**

`tests/test_mzhash.c`：
```c
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "mzhash.h"
int main(void){
    char h[128]; mzhash_make("123456",h,sizeof(h));
    assert(strncmp(h,"sha256$",7)==0);
    assert(mzhash_verify("123456",h)==1);
    assert(mzhash_verify("wrong",h)==0);
    assert(mzhash_verify("123456","123456")==1);        /* 舊明文相容 */
    assert(mzhash_is_legacy("123456")==1);
    assert(mzhash_is_legacy(h)==0);
    printf("mzhash OK\n");
    return 0;
}
```
Makefile 加 `COMPAT_TEST_mzhash = mzhash.c $(MBEDTLS_SRC)`。

- [ ] **Step 2: 跑確認失敗** → `make host-mzhash` FAIL。

- [ ] **Step 3: 實作 mzhash.c**（`mbedtls_sha256(salt||password)`；hex 編碼；salt 由 ctr_drbg）。

- [ ] **Step 4: mzhash 測試通過** → `make host-mzhash && docker run ... build/test_mzhash` → `mzhash OK`。

- [ ] **Step 5: 寫 SEC-04 端到端容器測試**

`tests/test_sec04.py`：
```python
import subprocess, time, urllib.request, json, re
open("/etc/ifcfg-eth0","w").write("SN=P7TEST\n")
open("/etc/ifcfg-sip","w").write("WEB_USER=admin\nWEB_PASSWORD=123456\n")  # 舊明文
p=subprocess.Popen(["build/mzweb-x86"]); time.sleep(1)
def login(pw):
    r=urllib.request.Request("http://127.0.0.1:80/auth/login",data=json.dumps({"username":"admin","password":pw}).encode())
    return urllib.request.urlopen(r,timeout=5).read().decode("latin1")
try:
    # 舊明文首登成功
    assert '"token"' in login("123456")
    # 就地升級：ifcfg-sip 的 WEB_PASSWORD 變 sha256$
    pw=open("/etc/ifcfg-sip").read()
    assert "WEB_PASSWORD=sha256$" in pw, f"未升級雜湊: {pw}"
    assert "WEB_PASSWORD=123456" not in pw
    # 升級後仍能用原密碼登入
    assert '"token"' in login("123456")
    print("sec04 OK")
finally:
    p.kill()
```

- [ ] **Step 6: 擴充 patch（login 用 mzhash_verify＋就地遷移）**

`request_login_cmd`（@207-208 的比對）改為 `mzhash_verify(pass_word, WEB_PASSWORD)`；驗證成功後若 `mzhash_is_legacy(WEB_PASSWORD)` → `mzhash_make(pass_word, newhash)` → `modify_key_value(kv,"WEB_PASSWORD",newhash)` + `write_keyvalue_file`（就地升級）。patch 檔頭 include `mzhash.h`。Makefile 的 mzweb 目標 COMPAT 加 `mzhash.c`。

- [ ] **Step 7: 跑確認通過** → `make x86-mzweb && docker run ... python3 tests/test_sec04.py` → `sec04 OK`。

- [ ] **Step 8: Commit**

```bash
git add docs/multi-zone-poc/src/mzweb
git commit -m "feat(mzweb): T8 SEC-04 WEB_PASSWORD SHA-256+salt 雜湊＋舊明文就地遷移"
```

---

### Task 9: Patch SEC-05 — 登入失敗鎖定（A005）

**Files:**
- Modify: `docs/multi-zone-poc/src/mzweb/websetsip-p7.patch`
- Test: `tests/test_sec05.py`

**Interfaces:**
- Consumes: event loop `mn_now`（毫秒）判鎖定時間。
- Produces: `request_login_cmd` 失敗計數：連續失敗 5 次鎖 5 分（300000ms），鎖定期內回 `A005`，成功歸零。

- [ ] **Step 1: 寫測試**

`tests/test_sec05.py`：
```python
import subprocess, time, urllib.request, json
open("/etc/ifcfg-eth0","w").write("SN=P7TEST\n")
open("/etc/ifcfg-sip","w").write("WEB_USER=admin\nWEB_PASSWORD=123456\n")
p=subprocess.Popen(["build/mzweb-x86"]); time.sleep(1)
def login(pw):
    r=urllib.request.Request("http://127.0.0.1:80/auth/login",data=json.dumps({"username":"admin","password":pw}).encode())
    return urllib.request.urlopen(r,timeout=5).read().decode("latin1")
try:
    for _ in range(5): login("wrong")     # 5 次錯
    b=login("wrong")                        # 第 6 次應鎖定
    assert "A005" in b, f"未鎖定: {b[:80]}"
    b2=login("123456")                      # 鎖定期內即使對也 A005
    assert "A005" in b2, f"鎖定期內正確密碼未擋: {b2[:80]}"
    print("sec05 OK")
finally:
    p.kill()
```
> 測試用可把鎖定門檻時間縮短編譯（`-DLOCK_MS=…`）或只驗「鎖定觸發」不驗「解鎖」（解鎖需等 5 分，真機驗）。

- [ ] **Step 2: 跑確認失敗** → FAIL（無鎖定）。

- [ ] **Step 3: 擴充 patch**

`request_login_cmd` 前加 file-scope 失敗狀態（單一計數即可，PoC 不分來源 IP——原廠單 session 模型；註明生產化可加 per-IP）：`static int s_login_fail; static unsigned long long s_lock_until;`。進入時 `if(mn_now < s_lock_until) → 回 A005`；密碼錯 `if(++s_login_fail>=5){ s_lock_until = mn_now + LOCK_MS; }` 回 A005/A001；成功 `s_login_fail=0; s_lock_until=0;`。`LOCK_MS` 用 `#ifndef LOCK_MS #define LOCK_MS 300000 #endif`（測試可 -D 縮短）。錯誤碼回覆格式比照原廠 A00x。

- [ ] **Step 4: 跑確認通過** → `sec05 OK`。

- [ ] **Step 5: Commit**

```bash
git add docs/multi-zone-poc/src/mzweb
git commit -m "feat(mzweb): T9 SEC-05 登入失敗 5 次鎖定 5 分(A005)"
```

---

### Task 10: Patch SEC-06 — 改密複雜度＋清 token

**Files:**
- Modify: `docs/multi-zone-poc/src/mzweb/websetsip-p7.patch`
- Test: `tests/test_sec06.py`

**Interfaces:**
- Consumes: T8 `mzhash_make`（改密也存雜湊）。
- Produces: `request_change_password_cmd` 加新密碼 ≥8＋含英文與數字（不合回 E001）；改密成功後 `memset(now_token,0,…)` 清除 token（舊 token 呼叫回 A003），且新密碼以 `mzhash_make` 存雜湊。

- [ ] **Step 1: 寫測試**

`tests/test_sec06.py`：
```python
import subprocess, time, urllib.request, json, re
open("/etc/ifcfg-eth0","w").write("SN=P7TEST\n")
open("/etc/ifcfg-sip","w").write("WEB_USER=admin\nWEB_PASSWORD=123456\n")
p=subprocess.Popen(["build/mzweb-x86"]); time.sleep(1)
base="http://127.0.0.1:80"
def login(pw):
    r=urllib.request.Request(base+"/auth/login",data=json.dumps({"username":"admin","password":pw}).encode())
    return re.search(r'"token":\s*"([0-9a-f]+)',urllib.request.urlopen(r,timeout=5).read().decode("latin1"))
def chpw(tok,old,new):
    r=urllib.request.Request(base+"/auth/change_password",data=json.dumps({"old_password":old,"new_password":new}).encode(),
        headers={"Authorization":"Bearer "+tok})
    return urllib.request.urlopen(r,timeout=5).read().decode("latin1")
try:
    tok=login("123456").group(1)
    assert "E001" in chpw(tok,"123456","short")          # <8 拒
    assert "E001" in chpw(tok,"123456","allletters")     # 無數字拒
    r=chpw(tok,"123456","GoodPass123")                    # 合法
    assert "success" in r, r
    # 改密後舊 token 失效
    b=urllib.request.urlopen(urllib.request.Request(base+"/get/device/status",headers={"Authorization":"Bearer "+tok}),timeout=5).read().decode("latin1")
    assert "A003" in b, "改密後舊 token 未失效"
    # 新密碼可登入
    assert login("GoodPass123") is not None
    print("sec06 OK")
finally:
    p.kill()
```

- [ ] **Step 2: 跑確認失敗** → FAIL。

- [ ] **Step 3: 擴充 patch**

`request_change_password_cmd`（@395 比對後、@404 寫入前）：舊密碼比對改 `mzhash_verify`；新密碼檢查 `strlen(new_pd)>=8 && has_alpha && has_digit`，不合回 E001；合法則 `mzhash_make(new_pd, h)` → `modify_key_value(kv,"WEB_PASSWORD",h)` → write；成功後 `memset(s_http_sip_set->now_token,0,sizeof(...))` 清 token。

- [ ] **Step 4: 跑確認通過** → `sec06 OK`。

- [ ] **Step 5: Commit**

```bash
git add docs/multi-zone-poc/src/mzweb
git commit -m "feat(mzweb): T10 SEC-06 改密複雜度(≥8 英數)＋成功清除現行 token"
```

---

### Task 11: 整合 arm 建置＋憑證 bootstrap（背景 keygen＋:80 301 gating）

**Files:**
- Modify: `docs/multi-zone-poc/src/mzweb/websetsip-p7.patch`（main/init 掛憑證 bootstrap＋改 IP 重簽）、`Makefile`
- Test: 容器整合 + arm 建置

**Interfaces:**
- Consumes: T1–T10 全部。
- Produces: mzweb 開機流程——`init_web_listen_tls(443,…)`＋`:80`（301 gate）；憑證 bootstrap：讀 /etc/ifcfg-eth0 的 IP → `mzcert_ensure`（背景/首開）→ 就緒設 `s_tls_ready`；改 IP 流程（`/set/network/config` 成功後）`mzcert_invalidate`（下次重啟重簽）。

- [ ] **Step 1: patch 掛 TLS 啟動＋憑證 bootstrap**

- `init_sip_web_set_svr`（原 `init_web_listen` 呼叫點 @3015 附近）：改為同時起 `:80`（既有，加 301 gate）＋`init_web_listen_tls(443, http_callback, loop, "/etc/sipweb/mz.crt","/etc/sipweb/mz.key", <device_ip>)`。device_ip 讀 `/etc/ifcfg-eth0` 的 `IP`（同原廠讀 SN 模式）。
- 憑證 bootstrap：啟動時 `mzcert_ensure`（若 keygen 慢，可先起 :80 服務、憑證就緒後才設 `s_tls_ready` 啟 301 與 :443——避免首開無法連）。
- `/set/network/config` handler 成功改 IP 後：`mzcert_invalidate("/etc/sipweb/mz.crt","/etc/sipweb/mz.key")`（下次重啟以新 IP 重簽）。

- [ ] **Step 2: 容器整合驗證（http→仍需先確認 x86 https 全鏈）**

Run: `make x86-mzweb`；容器起 mzweb-x86（會產憑證、起 :443+:80）；跑一支整合腳本：https login→GET(帶token)→:80 得 301→安全標頭。
Expected: 全鏈綠（可整併 https_test.py + test_sec01.py 的 https 版）。

- [ ] **Step 3: arm 建置**

Run: `make clean && make arm-mzweb && file build/mzweb-arm && ls -la build/mzweb-arm`
Expected: `ELF 32-bit LSB executable, ARM, statically linked`；記錄體積（估 <1.5MB）。

- [ ] **Step 4: Commit**

```bash
git add docs/multi-zone-poc/src/mzweb
git commit -m "feat(mzweb): T11 整合 TLS 啟動＋憑證 bootstrap(背景 keygen/改IP重簽)＋arm 建置"
```

---

### Task 12: 真機驗收（.70）— HTTPS 全項＋CMS＋reboot

**Files:**
- Modify: `docs/multi-zone-poc/p7-acceptance.md`（加安全強化驗收段）、`docs/multi-zone-poc/src/mzdeploy.sh`（憑證持久化/rollback）
- Create: `docs/multi-zone-poc/mzweb-security-acceptance.md`

**Interfaces:**
- Consumes: T11 `build/mzweb-arm`（HTTPS 版）。

- [ ] **Step 1: 部署 HTTPS 版 mzweb 到 .70**

`./mzdeploy.sh mzweb-install`（備份現行 P7 mzweb→.orig 已存在則保留；置換為 HTTPS 版）；首開等憑證產生（觀察 keygen 時間）。
Expected: `status` 綠。

- [ ] **Step 2: SEC-03 驗收**

```bash
curl -k -s -D- https://192.168.0.70/get/device/status -H "Authorization: Bearer <tok>" | head
curl -s -D- http://192.168.0.70/get/device/status | grep -E "301|Location: https|X-Frame-Options"
openssl s_client -connect 192.168.0.70:443 </dev/null 2>/dev/null | openssl x509 -noout -text | grep -A1 "Subject Alternative Name"
```
Expected: https 可登入操作；http 回 301→https＋安全標頭；憑證 SAN 含 `IP Address:192.168.0.70`。

- [ ] **Step 3: SEC-01/02/04/05/06＋FW 真機驗收**

逐項（帶 token curl over https）：6 GET 無 token→A003；`/get/sip/config` 密碼 `********`；`/get/device/status` 合法 JSON（`python3 -c 'json.loads(...)'`）；`/etc/ifcfg-sip` 的 `WEB_PASSWORD` 為 `sha256$`；連 5 次錯密碼→A005；改密 <8/無數字→E001、成功後舊 token→A003。
Expected: 全過，逐項記入驗收文件。

- [ ] **Step 4: CMS 實連（HTTPS）**

CMS（已 https-first）連 .70：登入/狀態/SIP/組播/網路頁全功能（走 https）。
Expected: 通過（API 契約已驗，CMS 應用層由使用者確認）。

- [ ] **Step 5: reboot 存活＋改 IP 重簽**

reboot → 等恢復 → https 自動起、憑證仍在。改 IP（測試環境許可時）→ 重啟 → 新 SAN。
Expected: HTTPS＋憑證 reboot 恢復；改 IP 重簽 SAN 更新。

- [ ] **Step 6: 文件收尾＋memory**

寫 `mzweb-security-acceptance.md`；更新評估文件與 memory（mzweb 達 v6.1.2 P0+P1）。

- [ ] **Step 7: Commit**

```bash
git add docs/multi-zone-poc docs/組播多監聽區-自研可行性評估與PoC計畫.md
git commit -m "feat(mzweb): v6.1.2 安全強化 P0+P1 真機驗收全過(HTTPS/token/雜湊/鎖定/CMS/reboot)"
```

---

## Self-Review 紀錄

- **Spec coverage**：SEC-01→T5；SEC-02→T7；SEC-03→T1-T4,T11（vendor/憑證/TLS層/301/bootstrap）；FW-01/02→T6；SEC-04→T8；SEC-05→T9；SEC-06→T10；SEC-09→T6。P2（SEC-07/08）明列非目標（SEC-01 已對 /system/info 加 token）。無缺口。
- **Placeholder scan**：T3 webapi TLS 層與 T6/T8 patch 為「結構＋API 指示＋逐段寫完不留 stub」，因原廠碼不進版控無法貼完整 diff，已給精確 mbedTLS/cJSON API 呼叫序列與 handler 行號，非 TBD。
- **Type consistency**：`mzcert_ensure/load/invalidate`（T2 定義=T3/T11 用）；`mzhash_make/verify/is_legacy`（T8 定義=T8/T10 用）；`init_web_listen_tls`（T3 產=T11 用）；`mzweb_check_token`（P7 T7 產=T5 用）；`s_tls_ready`（T4 定義=T3/T11 用）。一致。
- **範圍註記**：SEC-03（TLS）與 patch 級 SEC-01/02/04/05/06/09 性質不同，計畫已分別成 task（T1-T4 TLS/憑證 vs T5-T10 patch），T11 整合、T12 真機——單一計畫、清楚邊界。

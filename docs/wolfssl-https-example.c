/* wolfssl-https-example.c — GT-SIP-GW 设备 HTTPS 参考实作（配套 SEC-03）
 *
 * 设备 rootfs 自带 wolfSSL（无 openssl 命令行）。本文件示范两件事：
 *   ① gen_self_signed()  —— 用 wolfCrypt 在设备端首开/改 IP 时自签证书（SAN=IP，产 DER）
 *   ② https_ctx_setup()  —— 用 wolfSSL 把证书/私钥载入 TLS context，供服务端 wrap socket
 *
 * 这是 API 正确的参考骨架，非可独立编译的完整程序：①需链 wolfSSL；
 * ②serve 部分要接到现有 web 服务的 accept() 循环（见 init_web_listen 说明）。
 *
 * ── 编译/链接（设备工具链）──────────────────────────────────────────────
 *   cc ... wolfssl-https-example.c -lwolfssl
 *
 * ── wolfSSL 必须开的编译选项（决定走「路 A」还是「路 B」）──────────────
 *   ① 自签证书（路 A）需要：
 *        ./configure --enable-keygen --enable-certgen --enable-certext
 *      对应宏：WOLFSSL_KEY_GEN / WOLFSSL_CERT_GEN / WOLFSSL_CERT_EXT(含 WOLFSSL_ALT_NAMES)
 *      先确认：grep -E 'WOLFSSL_KEY_GEN|WOLFSSL_CERT_GEN|WOLFSSL_CERT_EXT|WOLFSSL_ALT_NAMES' \
 *               /usr/include/wolfssl/options.h
 *   ② 若上面没开 → 走「路 B」：B-1 重编 wolfSSL 加上述选项；
 *      或 B-2 在产线 PC 用 openssl 预生成 PEM 证书烧入，设备端只跑下面 ② 载入
 *      （载入时把 WOLFSSL_FILETYPE_ASN1 改成 WOLFSSL_FILETYPE_PEM）。
 * ─────────────────────────────────────────────────────────────────────── */

#include <wolfssl/options.h>
#include <wolfssl/ssl.h>
#include <wolfssl/wolfcrypt/asn_public.h>   /* Cert, wc_InitCert, wc_MakeSelfCert */
#include <wolfssl/wolfcrypt/rsa.h>          /* RsaKey, wc_MakeRsaKey, wc_RsaKeyToDer */
#include <wolfssl/wolfcrypt/random.h>
#include <sys/stat.h>
#include <string.h>
#include <stdio.h>

#define WEB_CRT "/etc/ifcfg-web.crt"        /* 持久分区；本例存 DER */
#define WEB_KEY "/etc/ifcfg-web.key"

/* ── ① 设备端自签（路 A） ───────────────────────────────────────────────
 * 由 a.b.c.d 组出「GeneralNames 序列：iPAddress[7] 4 bytes」的 DER：
 *   30 06 87 04 <a> <b> <c> <d>
 * 手刻这段 DER 跨 wolfSSL 版本最稳，不依赖高阶 SAN setter。
 */
static int build_ip_san(unsigned char out[8], const char* ip) {
    unsigned int a, b, c, d;
    if (sscanf(ip, "%u.%u.%u.%u", &a, &b, &c, &d) != 4) return -1;
    out[0] = 0x30; out[1] = 0x06; out[2] = 0x87; out[3] = 0x04;
    out[4] = (unsigned char)a; out[5] = (unsigned char)b;
    out[6] = (unsigned char)c; out[7] = (unsigned char)d;
    return 8;
}

/* 首开 / 改 IP 时调用：自签证书 + 私钥写入持久分区（DER 格式）。
 * 需 WOLFSSL_KEY_GEN / WOLFSSL_CERT_GEN / WOLFSSL_ALT_NAMES。回传 0 成功。*/
int gen_self_signed(const char* ip, const char* crt_path, const char* key_path) {
    WC_RNG rng;
    RsaKey key;
    Cert   cert;
    unsigned char derCert[2048], derKey[2048], san[8];
    int    certSz, keySz, ret;
    FILE*  f;

    if ((ret = wc_InitRng(&rng)) != 0) return ret;
    if ((ret = wc_InitRsaKey(&key, NULL)) != 0) { wc_FreeRng(&rng); return ret; }
    if ((ret = wc_MakeRsaKey(&key, 2048, 65537, &rng)) != 0) goto out;  /* WOLFSSL_KEY_GEN */

    wc_InitCert(&cert);
    strncpy(cert.subject.country,    "TW",                    CTC_NAME_SIZE - 1);
    strncpy(cert.subject.org,        "Guangtian Information", CTC_NAME_SIZE - 1);
    strncpy(cert.subject.commonName, "GT-SIP-GW",             CTC_NAME_SIZE - 1);
    cert.daysValid = 3650;
    cert.isCA      = 0;
    cert.sigType   = CTC_SHA256wRSA;
#ifdef WOLFSSL_ALT_NAMES
    if (build_ip_san(san, ip) == 8) {        /* SAN=IP，现代浏览器必须，否则报 CN_INVALID */
        memcpy(cert.altNames, san, 8);
        cert.altNamesSz = 8;
    }
#else
    (void)san; (void)ip;                     /* 没开 CERT_EXT：证书无 SAN，浏览器会更严格 */
#endif

    /* 自签：issuer == subject → DER */
    certSz = wc_MakeSelfCert(&cert, derCert, (word32)sizeof(derCert), &key, &rng); /* CERT_GEN */
    if (certSz < 0) { ret = certSz; goto out; }
    keySz = wc_RsaKeyToDer(&key, derKey, (word32)sizeof(derKey));
    if (keySz < 0) { ret = keySz; goto out; }

    if ((f = fopen(crt_path, "wb"))) { fwrite(derCert, 1, certSz, f); fclose(f); }
    if ((f = fopen(key_path, "wb"))) { fwrite(derKey, 1, keySz, f); fclose(f);
                                       chmod(key_path, 0600); }
    ret = 0;
out:
    wc_FreeRsaKey(&key);
    wc_FreeRng(&rng);
    return ret;   /* 产物为 DER → 载入用 WOLFSSL_FILETYPE_ASN1 */
}

/* ── ② 跑 HTTPS：载入证书到 TLS context（这部分一定有、零风险） ──────────
 * 回传可复用的 WOLFSSL_CTX*；失败回 NULL。整个进程建一次即可。
 */
WOLFSSL_CTX* https_ctx_setup(const char* crt_path, const char* key_path) {
    WOLFSSL_CTX* ctx;
    wolfSSL_Init();
    ctx = wolfSSL_CTX_new(wolfTLS_server_method());     /* 自动协商 TLS1.2/1.3 */
    if (!ctx) return NULL;
    /* 路 A 产的是 DER → ASN1；路 B-2（openssl 预生成 PEM）→ 改 WOLFSSL_FILETYPE_PEM */
    if (wolfSSL_CTX_use_certificate_file(ctx, crt_path, WOLFSSL_FILETYPE_ASN1) != WOLFSSL_SUCCESS
     || wolfSSL_CTX_use_PrivateKey_file (ctx, key_path, WOLFSSL_FILETYPE_ASN1) != WOLFSSL_SUCCESS) {
        wolfSSL_CTX_free(ctx);
        return NULL;
    }
    return ctx;
}

/* 每条 accept() 进来的连线包一层 TLS；把现有 recv()/send() 换成 wolfSSL_read()/write()。
 * 若 SDK 的 init_web_listen 支持传入 cert/key（那三组预留参数），优先用它、可省掉本函数。*/
int handle_one_conn(WOLFSSL_CTX* ctx, int client_fd) {
    WOLFSSL* ssl = wolfSSL_new(ctx);
    if (!ssl) return -1;
    wolfSSL_set_fd(ssl, client_fd);
    if (wolfSSL_accept(ssl) == WOLFSSL_SUCCESS) {
        /* char buf[2048];
         * int n = wolfSSL_read(ssl, buf, sizeof buf);   // 取代 recv()
         * ... 交给现有 http_callback 处理 ...
         * wolfSSL_write(ssl, resp, resp_len);            // 取代 send()
         */
    }
    wolfSSL_free(ssl);
    return 0;
}

/* 进程收尾：wolfSSL_CTX_free(ctx); wolfSSL_Cleanup(); */

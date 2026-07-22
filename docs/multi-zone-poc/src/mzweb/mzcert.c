/* mzcert.c — 設備端自簽憑證（SAN=IP, RSA-2048, mbedTLS 3.6 x509write）產生／載入。
 *
 * SEC-03 HTTPS 的憑證來源。跑在設備（uClibc ARM）與容器（musl）。
 *   - entropy 用 /dev/urandom（精簡 config 開了 MBEDTLS_ENTROPY_HARDWARE_ALT，
 *     故本檔提供真實的 mbedtls_hardware_poll()，取代 S-T1 smoke 的 memset stub）。
 *   - 私鑰寫檔後 chmod 0600。
 *   - SAN=IP：用 3.6 的 mbedtls_x509write_crt_set_subject_alternative_name，
 *     節點 type=MBEDTLS_X509_SAN_IP_ADDRESS、unstructured_name 填 4-byte IP。
 *     mbedTLS 會寫成 GeneralNames  `87 04 <a b c d>`（context-specific tag 7），
 *     現代瀏覽器與 openssl 皆能驗出 `IP Address:<ip>`。
 */
#include "mzcert.h"

#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <sys/stat.h>

#include "mbedtls/entropy.h"
#include "mbedtls/platform_util.h"
#include "mbedtls/ctr_drbg.h"
#include "mbedtls/rsa.h"
#include "mbedtls/pk.h"
#include "mbedtls/x509_crt.h"
#include "mbedtls/x509.h"
#include "mbedtls/error.h"

#define MZCERT_SUBJECT   "CN=GT-SIP-GW,O=Guangtian Information,C=TW"
#define MZCERT_NOT_BEFORE "20260101000000"
#define MZCERT_NOT_AFTER  "20360101000000"   /* 3650 天有效期 */
#define MZCERT_RSA_BITS   2048
#define MZCERT_RSA_EXP    65537

/* --- 真實硬體熵：讀 /dev/urandom 填 output。精簡 config 的
 * MBEDTLS_ENTROPY_HARDWARE_ALT 會呼叫此函式作為熵源。回 0 成功。 --- */
int mbedtls_hardware_poll(void *data, unsigned char *output, size_t len, size_t *olen)
{
    (void) data;
    int fd = open("/dev/urandom", O_RDONLY);
    if (fd < 0) {
        return MBEDTLS_ERR_ENTROPY_SOURCE_FAILED;
    }
    size_t got = 0;
    while (got < len) {
        ssize_t r = read(fd, output + got, len - got);
        if (r <= 0) {
            if (r < 0 && errno == EINTR) {
                continue;
            }
            close(fd);
            return MBEDTLS_ERR_ENTROPY_SOURCE_FAILED;
        }
        got += (size_t) r;
    }
    close(fd);
    if (olen) {
        *olen = got;
    }
    return 0;
}

/* 兩檔皆可讀 → 已存在（不重簽）。 */
static int mzcert_file_exists(const char *path)
{
    FILE *f = fopen(path, "rb");
    if (f) {
        fclose(f);
        return 1;
    }
    return 0;
}

/* "a.b.c.d" → out[4]。成功回 0；格式錯回 -1。 */
static int mzcert_parse_ipv4(const char *ip, unsigned char out[4])
{
    unsigned int a, b, c, d;
    char extra;
    if (sscanf(ip, "%u.%u.%u.%u%c", &a, &b, &c, &d, &extra) != 4) {
        return -1;
    }
    if (a > 255 || b > 255 || c > 255 || d > 255) {
        return -1;
    }
    out[0] = (unsigned char) a;
    out[1] = (unsigned char) b;
    out[2] = (unsigned char) c;
    out[3] = (unsigned char) d;
    return 0;
}

/* 產生私鑰＋自簽憑證並寫檔。回 0 成功。 */
static int mzcert_generate(const char *crt_path, const char *key_path, const char *ip)
{
    int ret = -1;
    unsigned char ip_bytes[4];
    unsigned char serial[16];
    unsigned char crt_pem[4096];
    unsigned char key_pem[4096];

    mbedtls_entropy_context entropy;
    mbedtls_ctr_drbg_context ctr_drbg;
    mbedtls_pk_context key;
    mbedtls_x509write_cert crt;
    mbedtls_x509_san_list san_ip;

    mbedtls_entropy_init(&entropy);
    mbedtls_ctr_drbg_init(&ctr_drbg);
    mbedtls_pk_init(&key);
    mbedtls_x509write_crt_init(&crt);

    if (mzcert_parse_ipv4(ip, ip_bytes) != 0) {
        goto cleanup;
    }

    /* --- DRBG seed（熵源 → /dev/urandom via mbedtls_hardware_poll） --- */
    if (mbedtls_ctr_drbg_seed(&ctr_drbg, mbedtls_entropy_func, &entropy,
                              (const unsigned char *) "mzcert-gen", 10) != 0) {
        goto cleanup;
    }

    /* --- RSA-2048 金鑰產生 --- */
    if (mbedtls_pk_setup(&key, mbedtls_pk_info_from_type(MBEDTLS_PK_RSA)) != 0) {
        goto cleanup;
    }
    if (mbedtls_rsa_gen_key(mbedtls_pk_rsa(key), mbedtls_ctr_drbg_random, &ctr_drbg,
                            MZCERT_RSA_BITS, MZCERT_RSA_EXP) != 0) {
        goto cleanup;
    }

    /* --- 憑證欄位（subject==issuer ＝ 自簽） --- */
    mbedtls_x509write_crt_set_subject_key(&crt, &key);
    mbedtls_x509write_crt_set_issuer_key(&crt, &key);
    if (mbedtls_x509write_crt_set_subject_name(&crt, MZCERT_SUBJECT) != 0) {
        goto cleanup;
    }
    if (mbedtls_x509write_crt_set_issuer_name(&crt, MZCERT_SUBJECT) != 0) {
        goto cleanup;
    }
    mbedtls_x509write_crt_set_md_alg(&crt, MBEDTLS_MD_SHA256);
    if (mbedtls_x509write_crt_set_validity(&crt, MZCERT_NOT_BEFORE, MZCERT_NOT_AFTER) != 0) {
        goto cleanup;
    }
    if (mbedtls_x509write_crt_set_basic_constraints(&crt, 0, -1) != 0) {  /* is_ca=0 */
        goto cleanup;
    }

    /* 序號：隨機 16 bytes，清最高位保持正整數（INTEGER 不得為負）。 */
    if (mbedtls_ctr_drbg_random(&ctr_drbg, serial, sizeof(serial)) != 0) {
        goto cleanup;
    }
    serial[0] &= 0x7F;
    if (serial[0] == 0) {
        serial[0] = 0x01;
    }
    if (mbedtls_x509write_crt_set_serial_raw(&crt, serial, sizeof(serial)) != 0) {
        goto cleanup;
    }

    /* --- SAN=IP（現代瀏覽器只認 SAN）：型別 IP_ADDRESS ＋ 4-byte IP --- */
    memset(&san_ip, 0, sizeof(san_ip));
    san_ip.node.type = MBEDTLS_X509_SAN_IP_ADDRESS;
    san_ip.node.san.unstructured_name.p   = ip_bytes;
    san_ip.node.san.unstructured_name.len = 4;
    san_ip.next = NULL;
    if (mbedtls_x509write_crt_set_subject_alternative_name(&crt, &san_ip) != 0) {
        goto cleanup;
    }

    /* --- 寫出 PEM --- */
    memset(crt_pem, 0, sizeof(crt_pem));
    if (mbedtls_x509write_crt_pem(&crt, crt_pem, sizeof(crt_pem),
                                  mbedtls_ctr_drbg_random, &ctr_drbg) != 0) {
        goto cleanup;
    }
    memset(key_pem, 0, sizeof(key_pem));
    if (mbedtls_pk_write_key_pem(&key, key_pem, sizeof(key_pem)) != 0) {
        goto cleanup;
    }

    /* 私鑰先以 0600 建檔（避免短暫 world-readable 視窗）。 */
    {
        int fd = open(key_path, O_WRONLY | O_CREAT | O_TRUNC, S_IRUSR | S_IWUSR);
        if (fd < 0) {
            goto cleanup;
        }
        size_t klen = strlen((const char *) key_pem);
        size_t w = 0;
        while (w < klen) {
            ssize_t n = write(fd, key_pem + w, klen - w);
            if (n <= 0) {
                if (n < 0 && errno == EINTR) {
                    continue;
                }
                close(fd);
                unlink(key_path);
                goto cleanup;
            }
            w += (size_t) n;
        }
        close(fd);
        /* 明確再 chmod 0600（呼應需求；覆蓋 umask 影響）。 */
        if (chmod(key_path, S_IRUSR | S_IWUSR) != 0) {
            unlink(key_path);
            goto cleanup;
        }
    }

    /* 憑證為公開資料，一般權限即可。 */
    {
        FILE *fc = fopen(crt_path, "wb");
        if (!fc) {
            unlink(key_path);
            goto cleanup;
        }
        size_t clen = strlen((const char *) crt_pem);
        if (fwrite(crt_pem, 1, clen, fc) != clen) {
            fclose(fc);
            unlink(crt_path);
            unlink(key_path);
            goto cleanup;
        }
        fclose(fc);
    }

    ret = 0;

cleanup:
    mbedtls_x509write_crt_free(&crt);
    mbedtls_pk_free(&key);
    mbedtls_ctr_drbg_free(&ctr_drbg);
    mbedtls_entropy_free(&entropy);
    /* 抹除敏感緩衝 */
    mbedtls_platform_zeroize(key_pem, sizeof(key_pem));
    mbedtls_platform_zeroize(serial, sizeof(serial));
    return ret;
}

int mzcert_ensure(const char *crt_path, const char *key_path, const char *ip)
{
    if (!crt_path || !key_path || !ip) {
        return -1;
    }
    if (mzcert_file_exists(crt_path) && mzcert_file_exists(key_path)) {
        return 0;   /* 已存在 → 不重簽 */
    }
    return mzcert_generate(crt_path, key_path, ip);
}

int mzcert_load(const char *crt_path, const char *key_path,
                mbedtls_x509_crt *crt_out, mbedtls_pk_context *key_out,
                mbedtls_ctr_drbg_context *drbg)
{
    if (!crt_path || !key_path || !crt_out || !key_out) {
        return -1;
    }
    if (mbedtls_x509_crt_parse_file(crt_out, crt_path) != 0) {
        return -1;
    }
    if (mbedtls_pk_parse_keyfile(key_out, key_path, NULL,
                                 drbg ? mbedtls_ctr_drbg_random : NULL, drbg) != 0) {
        return -1;
    }
    return 0;
}

void mzcert_invalidate(const char *crt_path, const char *key_path)
{
    if (crt_path) {
        unlink(crt_path);
    }
    if (key_path) {
        unlink(key_path);
    }
}

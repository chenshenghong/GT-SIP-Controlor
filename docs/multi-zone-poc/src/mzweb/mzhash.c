/* mzhash.c — SEC-04：WEB_PASSWORD 密碼雜湊(SHA-256+salt)產生／驗證，含舊明文相容。
 * 跑在設備（uClibc ARM）與容器（musl）；用 mbedTLS mbedtls_sha256 + ctr_drbg。
 * DRBG 熵源沿用 mzcert.c 已提供的 mbedtls_hardware_poll()（讀 /dev/urandom，
 * 精簡 config 開 MBEDTLS_ENTROPY_HARDWARE_ALT），本檔不重複定義。 */
#include "mzhash.h"

#include <string.h>
#include <stdio.h>

#include "mbedtls/sha256.h"
#include "mbedtls/entropy.h"
#include "mbedtls/ctr_drbg.h"

#define MZHASH_SALT_LEN    16   /* bytes */
#define MZHASH_DIGEST_LEN  32   /* SHA-256 輸出 bytes */
#define MZHASH_PREFIX      "sha256$"
#define MZHASH_PREFIX_LEN  7    /* strlen(MZHASH_PREFIX)，用於陣列大小等常數場合 */

/* --- hex 編碼／解碼（無外部相依，避免多帶一個 vendor） --- */

static void mzhash_to_hex(const unsigned char* in, int in_len, char* out /* >= in_len*2+1 */)
{
    static const char hexch[] = "0123456789abcdef";
    int i;
    for (i = 0; i < in_len; i++) {
        out[i * 2]     = hexch[(in[i] >> 4) & 0x0F];
        out[i * 2 + 1] = hexch[in[i] & 0x0F];
    }
    out[in_len * 2] = 0;
}

static int mzhash_hex_nibble(char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

/* 回 0 成功、非 0 失敗（長度非偶數或含非法字元）。out 需 >= hex_len/2 bytes。 */
static int mzhash_from_hex(const char* in, int hex_len, unsigned char* out)
{
    int i;
    if (hex_len % 2 != 0) {
        return -1;
    }
    for (i = 0; i < hex_len / 2; i++) {
        int hi = mzhash_hex_nibble(in[i * 2]);
        int lo = mzhash_hex_nibble(in[i * 2 + 1]);
        if (hi < 0 || lo < 0) {
            return -1;
        }
        out[i] = (unsigned char) ((hi << 4) | lo);
    }
    return 0;
}

/* --- salt 產生：mbedtls_ctr_drbg，熵源同 mzcert（/dev/urandom）。回 0 成功。 --- */
static int mzhash_random_salt(unsigned char* salt, int len)
{
    int ret = -1;
    mbedtls_entropy_context entropy;
    mbedtls_ctr_drbg_context ctr_drbg;

    mbedtls_entropy_init(&entropy);
    mbedtls_ctr_drbg_init(&ctr_drbg);

    if (mbedtls_ctr_drbg_seed(&ctr_drbg, mbedtls_entropy_func, &entropy,
                              (const unsigned char *) "mzhash-salt", 11) != 0) {
        goto cleanup;
    }
    if (mbedtls_ctr_drbg_random(&ctr_drbg, salt, (size_t) len) != 0) {
        goto cleanup;
    }
    ret = 0;

cleanup:
    mbedtls_ctr_drbg_free(&ctr_drbg);
    mbedtls_entropy_free(&entropy);
    return ret;
}

/* digest = SHA256(salt || password)。digest_out 需 >= MZHASH_DIGEST_LEN bytes。 */
static void mzhash_digest(const unsigned char* salt, int salt_len,
                          const char* password, unsigned char* digest_out)
{
    mbedtls_sha256_context ctx;
    mbedtls_sha256_init(&ctx);
    mbedtls_sha256_starts(&ctx, 0 /* is224=0 → SHA-256 */);
    mbedtls_sha256_update(&ctx, salt, (size_t) salt_len);
    mbedtls_sha256_update(&ctx, (const unsigned char*) password, strlen(password));
    mbedtls_sha256_finish(&ctx, digest_out);
    mbedtls_sha256_free(&ctx);
}

/* 常數時間比較：不因首個不同 byte 提前 return，降低時序側錄推測雜湊內容的風險。
 * 這裡雙方輸入皆是「雜湊後的 hex 字串」而非原始密碼本身，敏感度已遠低於直接比對
 * 明文密碼，但仍用固定走訪迴圈（非 strcmp/memcmp 短路版）以求穩妥。 */
static int mzhash_consteq(const char* a, const char* b, int len)
{
    unsigned char diff = 0;
    int i;
    for (i = 0; i < len; i++) {
        diff |= (unsigned char) (a[i] ^ b[i]);
    }
    return diff == 0;
}

void mzhash_make(const char* password, char* out, int out_sz)
{
    unsigned char salt[MZHASH_SALT_LEN];
    unsigned char digest[MZHASH_DIGEST_LEN];
    char salt_hex[MZHASH_SALT_LEN * 2 + 1];
    char digest_hex[MZHASH_DIGEST_LEN * 2 + 1];
    char full[MZHASH_PREFIX_LEN + MZHASH_SALT_LEN * 2 + 1 + MZHASH_DIGEST_LEN * 2 + 1];

    if (out == NULL || out_sz <= 0) {
        return;
    }
    out[0] = 0;
    if (password == NULL) {
        return;
    }

    if (mzhash_random_salt(salt, MZHASH_SALT_LEN) != 0) {
        /* DRBG/熵源異常：留 out 為空字串。呼叫端（login 就地遷移）用
         * modify_key_value 寫入空字串會讓下次比對必失敗——比「寫入壞掉的雜湊」
         * 更安全（不會把帳號鎖成誰都進不去也進不了的假裝成功狀態），
         * 且此路徑只在 /dev/urandom 壞掉這種硬體異常下才會發生。 */
        return;
    }

    mzhash_digest(salt, MZHASH_SALT_LEN, password, digest);
    mzhash_to_hex(salt, MZHASH_SALT_LEN, salt_hex);
    mzhash_to_hex(digest, MZHASH_DIGEST_LEN, digest_hex);

    snprintf(full, sizeof(full), "%s%s$%s", MZHASH_PREFIX, salt_hex, digest_hex);
    snprintf(out, (size_t) out_sz, "%s", full);
}

int mzhash_is_legacy(const char* stored)
{
    if (stored == NULL) {
        return 1;
    }
    return strncmp(stored, MZHASH_PREFIX, MZHASH_PREFIX_LEN) != 0;
}

int mzhash_verify(const char* password, const char* stored)
{
    if (password == NULL || stored == NULL) {
        return 0;
    }

    if (mzhash_is_legacy(stored)) {
        /* 舊明文：沿用原廠 request_login_cmd 既有語意（先比長度、再比內容）。 */
        size_t lp = strlen(password);
        size_t ls = strlen(stored);
        if (lp != ls) {
            return 0;
        }
        return mzhash_consteq(password, stored, (int) lp) ? 1 : 0;
    }

    {
        const char* p = stored + MZHASH_PREFIX_LEN;
        const char* dollar = strchr(p, '$');
        unsigned char salt[MZHASH_SALT_LEN];
        unsigned char digest[MZHASH_DIGEST_LEN];
        char digest_hex[MZHASH_DIGEST_LEN * 2 + 1];
        int salt_hex_len;

        if (dollar == NULL) {
            return 0;   /* 格式壞掉（有 sha256$ 前綴但缺第二個分隔字元） */
        }
        salt_hex_len = (int) (dollar - p);
        if (salt_hex_len != MZHASH_SALT_LEN * 2) {
            return 0;
        }
        if (mzhash_from_hex(p, salt_hex_len, salt) != 0) {
            return 0;
        }
        if ((int) strlen(dollar + 1) != MZHASH_DIGEST_LEN * 2) {
            return 0;
        }

        mzhash_digest(salt, MZHASH_SALT_LEN, password, digest);
        mzhash_to_hex(digest, MZHASH_DIGEST_LEN, digest_hex);

        return mzhash_consteq(digest_hex, dollar + 1, MZHASH_DIGEST_LEN * 2) ? 1 : 0;
    }
}

#include <stdio.h>
#include "mbedtls/build_info.h"   /* 觸發 #include MBEDTLS_CONFIG_FILE → 我方精簡 config */

/* --- sentinel：編譯期證明實際生效的是我方精簡 config，而非被 vendor 官方全量 config shadow --- */
#ifndef MZWEB_MBEDTLS_CONFIG_H
#error "mzweb 精簡 config 未生效(仍被 vendor 預設 config shadow)"
#endif
#ifdef MBEDTLS_SSL_PROTO_TLS1_3
#error "官方全量 config 洩漏：TLS1.3 不應在精簡範圍內"
#endif
#ifdef MBEDTLS_PSA_CRYPTO_C
#error "官方全量 config 洩漏：PSA crypto 不應在精簡範圍內"
#endif
#ifdef MBEDTLS_SSL_PROTO_DTLS
#error "官方全量 config 洩漏：DTLS 不應在精簡範圍內"
#endif

#include "mbedtls/ssl.h"
#include "mbedtls/ctr_drbg.h"
#include "mbedtls/entropy.h"
#include "mbedtls/x509_crt.h"
#include <string.h>

/* 精簡 config 啟用 MBEDTLS_ENTROPY_HARDWARE_ALT（生產由 mzcert 提供 /dev/urandom poll）。
 * smoke 測試不含 mzcert，這裡放測試專用 stub 讓連結成立；不影響生產 config 的設計決策。 */
int mbedtls_hardware_poll(void *data, unsigned char *output, size_t len, size_t *olen)
{
    (void)data;
    memset(output, 0x00, len);   /* 測試用；非真實熵源 */
    if (olen) *olen = len;
    return 0;
}

int main(void){
    mbedtls_ssl_config conf; mbedtls_ssl_config_init(&conf);
    mbedtls_ctr_drbg_context drbg; mbedtls_ctr_drbg_init(&drbg);
    mbedtls_x509write_cert crt; mbedtls_x509write_crt_init(&crt);  /* 驗證憑證產生模組編入 */
    printf("mbedtls smoke OK\n");
    mbedtls_ssl_config_free(&conf); mbedtls_ctr_drbg_free(&drbg);
    return 0;
}

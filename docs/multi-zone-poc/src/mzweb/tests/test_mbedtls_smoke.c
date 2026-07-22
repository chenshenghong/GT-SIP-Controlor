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

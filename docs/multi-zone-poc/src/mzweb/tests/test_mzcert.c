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

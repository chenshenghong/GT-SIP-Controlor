/* mzcert.h — 設備端自簽憑證（SAN=IP, RSA-2048, mbedTLS x509write）產生／載入。
 * SEC-03 HTTPS 的憑證來源；跑在設備（uClibc ARM）與容器（musl）。 */
#ifndef MZCERT_H
#define MZCERT_H

#include "mbedtls/x509_crt.h"
#include "mbedtls/pk.h"
#include "mbedtls/ctr_drbg.h"

/* 若 crt/key 不存在則以 SAN=ip 自簽產生（RSA-2048, 3650 天）並寫檔(key chmod 600)；
 * 已存在則不動。回 0 成功，非 0 失敗。 */
int mzcert_ensure(const char* crt_path, const char* key_path, const char* ip);

/* 載入 crt/key 到 mbedTLS 結構供 ssl_conf 用。回 0 成功，非 0 失敗。 */
int mzcert_load(const char* crt_path, const char* key_path,
                mbedtls_x509_crt* crt_out, mbedtls_pk_context* key_out,
                mbedtls_ctr_drbg_context* drbg);

/* 刪除 crt/key（改 IP 重簽用）。 */
void mzcert_invalidate(const char* crt_path, const char* key_path);

#endif /* MZCERT_H */

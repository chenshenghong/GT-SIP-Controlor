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
#define MBEDTLS_GENPRIME              /* mzcert RSA-2048 金鑰產生(mbedtls_rsa_gen_key) 需要 */
#define MBEDTLS_FS_IO                 /* mzcert 載入 crt/key 檔(parse_file/parse_keyfile) 需要 */
#define MBEDTLS_CIPHER_C
#define MBEDTLS_ECP_C
#define MBEDTLS_ECP_DP_SECP256R1_ENABLED  /* ECDHE 曲線；亦定義 MBEDTLS_ECP_MAX_BITS */
#define MBEDTLS_ECDH_C
#define MBEDTLS_KEY_EXCHANGE_ECDHE_RSA_ENABLED
#define MBEDTLS_KEY_EXCHANGE_RSA_ENABLED
#define MBEDTLS_SSL_CIPHERSUITES MBEDTLS_TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256, MBEDTLS_TLS_RSA_WITH_AES_128_GCM_SHA256
#define MBEDTLS_NO_PLATFORM_ENTROPY   /* uClibc/musl：無 /dev/hwrng 假設，用 /dev/urandom */
#define MBEDTLS_ENTROPY_HARDWARE_ALT  /* 由 mzcert 提供 /dev/urandom entropy callback */
/* 勿在此自行 #include check_config.h：它會在 config_adjust_*.h 推導出 *_CAN_* 輔助巨集
 * 之前就跑 → 誤報「not all prerequisites」。build_info.h 會在正確時機(config_adjust 之後)
 * 自動 include check_config.h。 */
#endif

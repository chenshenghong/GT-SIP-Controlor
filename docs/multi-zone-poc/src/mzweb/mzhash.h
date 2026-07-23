/* mzhash.h — SEC-04：WEB_PASSWORD 密碼雜湊(SHA-256+salt)產生／驗證，含舊明文相容。
 * 儲存格式："sha256$<hex-salt 32 chars>$<hex-digest 64 chars>"
 *   雜湊輸入 = salt(16 bytes 隨機) || password(明文, 不含長度前綴/分隔字元)。
 * salt 由 mbedTLS mbedtls_ctr_drbg 產生（熵源與 mzcert 相同：/dev/urandom via
 * mbedtls_hardware_poll，精簡 config 開 MBEDTLS_ENTROPY_HARDWARE_ALT）。 */
#ifndef MZHASH_H
#define MZHASH_H

/* 產生一組新雜湊字串寫入 out（out_sz 建議 >=128 bytes；完整格式固定長度為
 * 7("sha256$") + 32(salt hex) + 1('$') + 64(digest hex) + 1(NUL) = 105 bytes，
 * out_sz 不足時安全截斷、不溢位）。salt 每次呼叫皆由 ctr_drbg 重新產生，
 * 故同一密碼每次呼叫結果不同（僅雜湊值不同，驗證仍可互通）。
 * password 為 NULL 或 out 為 NULL/out_sz<=0 時安全地不寫出任何內容。 */
void mzhash_make(const char* password, char* out, int out_sz);

/* 驗證 password 是否符合 stored：
 *   - stored 以 "sha256$" 開頭 → 判定為雜湊格式：以相同 salt 重算 digest，
 *     與 stored 內的 digest hex 做常數時間比較。
 *   - 否則(舊明文格式，例如原廠預設值 "123456") → 直接明文比對，
 *     保留 request_login_cmd 對既有(尚未遷移)帳號的原始行為。
 * password / stored 任一為 NULL 回 0。回 1 表示符合，0 表示不符合。 */
int mzhash_verify(const char* password, const char* stored);

/* stored 是否為舊明文格式（即不是以 "sha256$" 開頭）。
 * stored 為 NULL 視為舊明文（回 1）。回 1 是舊明文，0 已是雜湊格式。 */
int mzhash_is_legacy(const char* stored);

#endif /* MZHASH_H */

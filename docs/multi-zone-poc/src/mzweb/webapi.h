#ifndef MZWEB_WEBAPI_H
#define MZWEB_WEBAPI_H

/* 自研相容層：取代原廠缺失的 webapi.h SDK。
 * 重建的原廠 websetsip.c 唯一對外入口 init_web_listen 靠此模組；
 * 19 條路由的請求解析、Authorization 擷取、回應寫出全經此。
 * 跑在 26MB RAM 單核嵌入式設備上。 */

struct event_loop; /* event.h 定義；此處僅需前向宣告 */

#define APP_REQUEST_CMD 1
#define HBI_WEB_SERVER "SIP-Player-2024"   /* 先放此值；Task 11 baseline 擷取後比對原廠 Server: 標頭字串修正 */
#define HBI_WEB_METHOD "GET, POST"         /* 同上，依 baseline 修正 */

typedef int (*http_callback_fn)(void* client, void* http_head, int request_type, const char* content, int content_len);

/* websetsip.c:3015 鎖定簽名（三組 TLS buf/len 與 flag 忽略；request_url 白名單忽略——
 * dispatch 在 callback 內；care_key_name 忽略）。 */
void init_web_listen(int port, http_callback_fn cb, struct event_loop* loop,
                     void* buf1, int len1, void* buf2, int len2, void* buf3, int len3,
                     char** request_url, int url_count,
                     char** care_key_name, int care_count, int flag);

/* SEC-03：:443 非阻塞 TLS 終結。mzcert_ensure/mzcert_load 取得自簽憑證，
 * 建 mbedTLS server ssl_config，https_port listen fd 註冊進同一 event loop。
 * TLS handshake 與 read/write 全走非阻塞、整合進單執行緒 poll 迴圈（不阻塞）。
 * 與 init_web_listen 共用 callback/連線池/idle 清掃；可單獨或並存啟用。 */
void init_web_listen_tls(int https_port, http_callback_fn cb, struct event_loop* loop,
                         const char* crt_path, const char* key_path, const char* ip);

void get_http_url(void* http_head, char** out_url, int* out_len);
void get_http_head(void* http_head, const char* name, char** out_value, int* out_len);
void web_snd_data(void* client, const char* buffer, int len);

/* P7 內部擴充（mzweb_zones.c 消費）：回傳 method 是否為 GET（1）/POST（0）*/
int mzweb_http_is_get(void* http_head);

#endif

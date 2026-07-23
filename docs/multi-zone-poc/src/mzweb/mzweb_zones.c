/* mzweb_zones.c — zones 路由轉呼 mzrelay3 (127.0.0.1:8090)。
 *
 * 職責切分（spec §3.2）：token 驗證在 websetsip.c patch 內的 mzweb_check_token；
 * 本檔只在 token 驗過後被呼叫，負責把請求轉呼 loopback 的 mzrelay3 REST，
 * 並把 mzrelay3 的完整 HTTP 回應原樣轉回瀏覽器。
 *
 * 連不上／timeout／讀不到資料 → 回 503 且不寫任何檔（spec 必測項 #6）。
 * 503 的 Content-Length 以 strlen(body) 計算，避免寫死錯值（brief 範例的 57 為誤，
 * 實際 body 長 56；此處一律動態計算，杜絕 off-by-one）。 */
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <sys/time.h>
#include <unistd.h>
#include "webapi.h"
#include "mzweb_zones.h"

#define RELAY_ADDR       "127.0.0.1"
#define RELAY_PORT       8090
#define RELAY_TIMEOUT_MS 2000
#define FWD_MAX          65536

#define SVC_UNAVAIL_BODY "{\"status\":\"error\",\"message\":\"zones service unavailable\"}"

/* 回 503（zones service unavailable）。Content-Length 動態計算 = strlen(body)。 */
static void send_service_unavailable(void* client)
{
    char resp[256];
    int n = snprintf(resp, sizeof(resp),
        "HTTP/1.1 503 Service Unavailable\r\n"
        "Server: " HBI_WEB_SERVER "\r\n"
        "Content-Type: application/json\r\n"
        "Content-Length: %d\r\n"
        "Connection: close\r\n\r\n"
        "%s",
        (int)strlen(SVC_UNAVAIL_BODY), SVC_UNAVAIL_BODY);
    /* snprintf 截斷防呆：n 為「應寫入長度」，若 HBI_WEB_SERVER 未來變長致 n >= buffer，
     * clamp 到 sizeof(resp)-1，避免 web_snd_data 用超界長度過讀 stack（對齊 serve_index.c #4）。 */
    if (n >= (int)sizeof(resp)) n = (int)sizeof(resp) - 1;
    web_snd_data(client, resp, n);
}

/* 對 mzrelay3 發一次 loopback HTTP RPC。成功回讀到的 bytes（>0），否則回 -1。 */
static int relay_rpc(int is_set, const char* content, int content_len, char* out, int out_cap)
{
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return -1;

    struct sockaddr_in a;
    memset(&a, 0, sizeof(a));
    a.sin_family = AF_INET;
    a.sin_port = htons(RELAY_PORT);
    inet_pton(AF_INET, RELAY_ADDR, &a.sin_addr);

    struct timeval tv;
    tv.tv_sec = RELAY_TIMEOUT_MS / 1000;
    tv.tv_usec = (RELAY_TIMEOUT_MS % 1000) * 1000;
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));

    if (connect(fd, (struct sockaddr*)&a, sizeof(a)) < 0) { close(fd); return -1; }

    char req[512];
    int rlen = snprintf(req, sizeof(req),
        "%s /%s/sip/multicast/zones HTTP/1.1\r\n"
        "Host: 127.0.0.1\r\n"
        "Content-Type: application/json\r\n"
        "Content-Length: %d\r\n"
        "Connection: close\r\n\r\n",
        is_set ? "POST" : "GET",
        is_set ? "set" : "get",
        is_set ? content_len : 0);
    if (rlen <= 0 || rlen >= (int)sizeof(req)) { close(fd); return -1; }

    if (send(fd, req, rlen, MSG_NOSIGNAL) != rlen) { close(fd); return -1; }
    if (is_set && content_len > 0 &&
        send(fd, content, content_len, MSG_NOSIGNAL) != content_len) { close(fd); return -1; }

    int total = 0, n;
    while (total < out_cap - 1 &&
           (n = recv(fd, out + total, out_cap - 1 - total, 0)) > 0) {
        total += n;
    }
    close(fd);
    out[total] = 0;
    return total > 0 ? total : -1;
}

void mzweb_forward_zones(void* client, int is_set, const char* content, int content_len)
{
    char* out = malloc(FWD_MAX);
    if (!out) { send_service_unavailable(client); return; }

    int n = relay_rpc(is_set, content, content_len, out, FWD_MAX);
    if (n <= 0) send_service_unavailable(client);
    else        web_snd_data(client, out, n);   /* mzrelay3 完整 HTTP 回應原樣轉回 */

    free(out);
}

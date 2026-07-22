#include <stdio.h>
#include <string.h>
#include "event.h"
#include "webapi.h"
static int cb(void* client, void* http_head, int type, const char* content, int content_len) {
    char* url; int ulen;
    get_http_url(http_head, &url, &ulen);
    if (type == APP_REQUEST_CMD && ulen == 5 && strncmp("/echo", url, ulen) == 0) {
        char* auth; int alen;
        get_http_head(http_head, "Authorization", &auth, &alen);
        char body[512];
        int blen = snprintf(body, sizeof(body), "{\"auth_len\":%d,\"body_len\":%d,\"is_get\":%d}",
                            alen, content_len, mzweb_http_is_get(http_head));
        char resp[1024];
        int rlen = snprintf(resp, sizeof(resp),
            "HTTP/1.1 200 OK\r\nServer: %s\r\nContent-Type: application/json\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s",
            HBI_WEB_SERVER, blen, body);
        web_snd_data(client, resp, rlen);
    }
    /* 未知路由：不送 → webapi 應自動 404 */
    return 0;
}
int main(void) {
    struct event_loop* loop = get_main_event_loop();
    init_web_listen(18080, cb, loop, NULL, 0, NULL, 0, NULL, 0, NULL, 0, NULL, 0, 0);
    printf("listening 18080\n");
    fflush(stdout);
    event_loop_run(loop);
    return 0;
}

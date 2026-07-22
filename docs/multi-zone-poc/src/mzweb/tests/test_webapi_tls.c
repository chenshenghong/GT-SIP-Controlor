/* test_webapi_tls.c — :8443 TLS echo server 殼。
 * init_web_listen_tls 內部 mzcert_ensure 產 /tmp/mzt.crt+key（首開需時間，
 * https_test.py 端 sleep 1.5s 等 keygen），mzcert_load → ssl_conf → :8443 listen。
 * cb 對 GET /echo 回 200 JSON；其餘走自動 404。 */
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include "event.h"
#include "webapi.h"

#include <stdlib.h>

#define BIG_BODY (2*1024*1024)   /* 遠大於 server SO_SNDBUF/wmem_max（~208KB）＋客戶端小 RCVBUF 視窗 → 保證 WANT_WRITE */

static int cb(void* client, void* hh, int type, const char* content, int clen){
    (void)content; (void)clen;
    char* url; int ul; get_http_url(hh,&url,&ul);
    if(type==APP_REQUEST_CMD && ul==5 && strncmp("/echo",url,ul)==0){
        const char* body="{\"ok\":1}";
        char resp[256]; int n=snprintf(resp,sizeof(resp),
          "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 8\r\nConnection: close\r\n\r\n%s",body);
        web_snd_data(client,resp,n);
    }
    /* /big：回一個遠大於 socket 送出緩衝的 body。若客戶端故意暫停讀取，TLS ssl_write
     * 會回 WANT_WRITE。舊版 tls_send_all 在此原地空轉 100% CPU、凍結整個 poll loop
     * （鑑別點：暫停期間另一條連線打 /echo 收不到回應）。修正後靠 POLLOUT 事件驅動排空。 */
    else if(type==APP_REQUEST_CMD && ul==4 && strncmp("/big",url,ul)==0){
        int cap = BIG_BODY + 256;
        char* resp = (char*)malloc(cap);
        if(resp){
            int hl = snprintf(resp, 256,
              "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: %d\r\nConnection: close\r\n\r\n",
              BIG_BODY);
            memset(resp+hl, 'A', BIG_BODY);
            web_snd_data(client, resp, hl+BIG_BODY);
            free(resp);
        }
    }
    return 0;
}

int main(void){
    /* 確保新鮮憑證（避免上次殘檔干擾）；init_web_listen_tls 內部會 mzcert_ensure 重簽。 */
    unlink("/tmp/mzt.crt"); unlink("/tmp/mzt.key");
    struct event_loop* l=get_main_event_loop();
    init_web_listen_tls(8443, cb, l, "/tmp/mzt.crt","/tmp/mzt.key","127.0.0.1");
    printf("tls listening 8443\n"); fflush(stdout);
    event_loop_run(l); return 0;
}

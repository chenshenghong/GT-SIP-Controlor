/* ─────────────────────────────────────────────────────────────────────
 * serve_index.c — 設備內建管理網頁的韌體 handler（參考用，請整合進 websetsip.c）
 *
 *  目的：讓設備 :80 在 GET /（與 /index.html）回傳內建管理網頁。
 *  現況：原 http_callback() 只 dispatch 19 條 JSON 路由，沒有任何靜態檔/HTML，
 *        GET / 不會回網頁。本檔補上這唯一缺口。
 *
 *  本檔沿用 websetsip.c 既有的 Web 層原語與巨集，無新增相依：
 *    · HBI_WEB_SERVER            （Server 標頭字串，既有）
 *    · web_snd_data(client,buf,n)（送資料，既有；二進位安全，用長度而非 strlen）
 *    · <string.h> memcpy / <stdlib.h> malloc（websetsip.c 已 include）
 * ───────────────────────────────────────────────────────────────────── */

/* P7 mzweb：本檔在自研相容層下作為「獨立編譯單元」連進 mzweb（非如原廠貼進
 * websetsip.c）。故補上原本靠 websetsip.c 提供的相依標頭：webapi.h 提供
 * web_snd_data 宣告與 HBI_WEB_SERVER 巨集；string/stdlib/stdio 提供 memcpy/
 * malloc/snprintf。request_get_index 由 static 改為外部連結，供 websetsip.c
 * 的 http_callback 跨編譯單元呼叫（patch 內以 extern 宣告）。 */
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include "webapi.h"

#include "web_index_gz.h"   /* 由 make-embed.sh 產生：web_index_gz[] / web_index_gz_len */

/*
 * 回傳內建管理網頁（gzip 壓縮、UTF-8）。
 * 與其他 handler 一致：組成「單一緩衝」一次 web_snd_data 送出。
 * ⚠ body 是二進位（gzip 含 0x00），務必用 web_index_gz_len，切勿用 strlen/snprintf 複製 body。
 */
void request_get_index(void* client)   /* P7: 去 static，供 websetsip.c 跨編譯單元呼叫 */
{
    static const char err503[] =
        "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";

    char head[384];                          /* 加了安全標頭，緩衝放大避免 snprintf 截斷 (#4) */
    int hl = snprintf(head, sizeof(head),
        "HTTP/1.1 200 OK\r\n"
        "Server: %s\r\n"
        "Connection: close\r\n"
        "Content-Type: text/html; charset=UTF-8\r\n"
        "Content-Encoding: gzip\r\n"          /* 任何現代瀏覽器都支援 */
        "Cache-Control: no-cache\r\n"
        "X-Frame-Options: SAMEORIGIN\r\n"        /* 防點擊劫持/iframe 嵌入（對齊 Grandstream 同級設備）*/
        "X-Content-Type-Options: nosniff\r\n"    /* 防 MIME sniffing */
        "X-XSS-Protection: 1; mode=block\r\n"    /* 舊版瀏覽器 XSS 過濾 */
        "Content-Length: %u\r\n\r\n",
        HBI_WEB_SERVER, web_index_gz_len);

    /* snprintf 截斷防呆：回傳「應寫入長度」，>= buffer 表示 HBI_WEB_SERVER 過長，勿用 hl 去 memcpy (#4) */
    if (hl < 0 || hl >= (int)sizeof(head)) {
        web_snd_data(client, err503, (int)sizeof(err503) - 1);
        return;
    }

    int total = hl + (int)web_index_gz_len;
    char* buf = (char*)malloc(total);
    if (buf == NULL) {                        /* 配置失敗也要回應，避免 client 卡到 timeout (#12) */
        web_snd_data(client, err503, (int)sizeof(err503) - 1);
        return;
    }
    memcpy(buf, head, hl);
    memcpy(buf + hl, web_index_gz, web_index_gz_len);
    web_snd_data(client, buf, total);
    free(buf);
}

/* ─────────────────────────────────────────────────────────────────────
 * 路由插入位置：http_callback() 內，「if (len > 0) {」之後、
 * 「if (strncmp("/auth/login", url, len) == 0)」之「前」。
 *
 * ⚠ 為什麼一定要放最前面：
 *   既有比對是 strncmp(route, url, len)，len = 請求路徑長度（屬 prefix 比對）。
 *   GET / 時 url="/"、len=1，strncmp("/auth/login","/",1)==0 會「誤命中」登入！
 *   因此必須在鏈最前面用「精確長度」攔截 / 與 /index.html。
 *
 * 把下面這段貼在原本第一個 if 之前（保持 else-if 串接）：
 * ───────────────────────────────────────────────────────────────────── */
#if 0  /* ↓↓↓ 複製進 http_callback()，勿直接編譯本段 ↓↓↓ */

            if (len == 1 && url[0] == '/')                          /* GET /           */
            {
                request_get_index(client);
            }
            else
            if (len == 11 && strncmp("/index.html", url, 11) == 0)  /* GET /index.html（精確長度，避免 /index.htmlXXX 命中 #8）*/
            {
                request_get_index(client);
            }
            else
            if (strncmp("/auth/login", url, len) == 0)
            {
                /* ...以下維持原本 19 條路由不變... */
            }

#endif /* ↑↑↑ */

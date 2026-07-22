/* webapi.c — 自研最小 HTTP server（取代原廠缺失的 webapi.h SDK）。
 *
 * 非阻塞、單執行緒、event-loop 驅動。設計為 26MB RAM 單核嵌入式設備服役：
 *   - 併發連線上限 MAX_CONNS（超額 accept 後直接 close）
 *   - URL > MAX_URL / headers 區 > MAX_HEADERS / Content-Length > MAX_BODY → 關閉
 *   - idle timeout IDLE_MS：某 conn 從上次 IO 起逾時仍未收齊完整請求 → 關閉
 *   - SIGPIPE 忽略 + send(MSG_NOSIGNAL)：客戶端半途斷線不殺 server
 *
 * 每連線一段固定緩衝（buf[MAX_HEADERS + MAX_BODY + 1]）：headers 收齊（找到
 * "\r\n\r\n"）並收滿 Content-Length body 後，以 (client, http_head) 皆指向該 conn
 * 呼叫 callback；callback 未 web_snd_data 則自動回 404。partial read（跨多個 TCP
 * segment / 多次 readable 事件）以 conn 內狀態累積，url/auth 視圖指進不搬動的 buf。 */

#include <string.h>
#include <strings.h>
#include <stdio.h>
#include <stdlib.h>
#include <signal.h>
#include <errno.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <unistd.h>
#include "event.h"
#include "socketbase.h"
#include "webapi.h"

#define MAX_CONNS   4
#define MAX_HEADERS 8192
#define MAX_URL     2048
#define MAX_BODY    32768
#define IDLE_MS     30000
#define CONN_CAP    (MAX_HEADERS + MAX_BODY + 1)

struct conn {
    int fd; int used;
    char buf[CONN_CAP];
    int len;                    /* 已累積 bytes */
    int hdr_end;                /* body 起始 offset（= "\r\n\r\n" 起點 + 4）；0 = headers 未解析 */
    int content_len;            /* 解析出的 Content-Length（無則 0） */
    int responded;              /* web_snd_data 已被呼叫 */
    unsigned long long last_io; /* idle timeout 用 */
    /* http_head 視圖（指進 buf，非 NUL 結尾） */
    char* url; int url_len;
    char* auth; int auth_len;   /* Authorization 值 */
    int is_get;
};
static struct conn s_conns[MAX_CONNS];
static http_callback_fn s_cb;
static struct event_loop* s_loop;
static int s_listen_fd = -1;

static void conn_close(struct conn* c) {
    if (!c->used) return;
    ev_unreg_fd(s_loop, c->fd);
    close_socket(c->fd);
    c->used = 0;
}

/* 送滿 len bytes（非阻塞下能送多少送多少；SIGPIPE 由 MSG_NOSIGNAL 抑制）。 */
static void send_all(int fd, const char* buffer, int len) {
    int off = 0;
    while (off < len) {
        int n = send(fd, buffer + off, len - off, MSG_NOSIGNAL);
        if (n > 0) { off += n; continue; }
        if (n < 0 && errno == EINTR) continue;
        break; /* EAGAIN / 對端關閉 / 其他錯誤：放棄剩餘（連線即將關閉） */
    }
}

void web_snd_data(void* client, const char* buffer, int len) {
    struct conn* c = client;
    send_all(c->fd, buffer, len);
    c->responded = 1;
    conn_close(c);
}
void get_http_url(void* http_head, char** out_url, int* out_len) {
    struct conn* c = http_head; *out_url = c->url; *out_len = c->url_len;
}
void get_http_head(void* http_head, const char* name, char** out_value, int* out_len) {
    struct conn* c = http_head;
    if (strcasecmp(name, "Authorization") == 0) { *out_value = c->auth; *out_len = c->auth_len; }
    else { *out_value = NULL; *out_len = 0; }
}
int mzweb_http_is_get(void* http_head) { return ((struct conn*)http_head)->is_get; }

/* 在 [buf, buf+len) 內找 "\r\n\r\n"，回傳其起點 index；找不到回 -1。 */
static int find_hdr_end(const char* buf, int len) {
    for (int i = 0; i + 3 < len; i++)
        if (buf[i] == '\r' && buf[i+1] == '\n' && buf[i+2] == '\r' && buf[i+3] == '\n')
            return i;
    return -1;
}

/* 非負十進位解析（非 NUL 結尾）；遇非數字即停。溢位夾在 INT 上限之上讓邊界檢查攔下。 */
static int parse_uint(const char* s, int len) {
    long v = 0;
    for (int i = 0; i < len; i++) {
        if (s[i] < '0' || s[i] > '9') break;
        v = v * 10 + (s[i] - '0');
        if (v > MAX_BODY + 1) return MAX_BODY + 1; /* 夾住，避免溢位；邊界檢查會拒 */
    }
    return (int)v;
}

/* 解析 request line（method/url）＋逐行 headers（僅擷取 Authorization、Content-Length）。
 * hdr_len = header 區長度（"\r\n\r\n" 起點）。成功回 1，request line 畸形回 0。 */
static int parse_request(struct conn* c, int hdr_len) {
    char* base = c->buf;
    /* --- request line：base .. 第一個 "\r\n" --- */
    int rle = -1;
    for (int i = 0; i + 1 < hdr_len; i++)
        if (base[i] == '\r' && base[i+1] == '\n') { rle = i; break; }
    if (rle < 0) rle = hdr_len; /* 單行（無 header）；request line 佔整段 */

    char* rls = base;
    char* rend = base + rle;
    char* sp1 = memchr(rls, ' ', rend - rls);
    if (!sp1) return 0;
    char* us = sp1 + 1;
    char* sp2 = memchr(us, ' ', rend - us);
    if (!sp2) return 0;
    c->is_get = ((sp1 - rls) == 3 && strncmp(rls, "GET", 3) == 0) ? 1 : 0;
    c->url = us;
    c->url_len = (int)(sp2 - us);

    /* --- header lines：request line 之後，逐行掃 --- */
    int p = rle + 2; /* 跳過 request line 的 \r\n */
    while (p < hdr_len) {
        int le = -1;
        for (int i = p; i + 1 < hdr_len; i++)
            if (base[i] == '\r' && base[i+1] == '\n') { le = i; break; }
        if (le < 0) le = hdr_len; /* 最後一行（其後即終止的 \r\n\r\n），無自帶 \r\n */
        char* ls = base + p;
        char* lend = base + le;
        char* colon = memchr(ls, ':', lend - ls);
        if (colon) {
            int nlen = (int)(colon - ls);
            char* v = colon + 1;
            while (v < lend && (*v == ' ' || *v == '\t')) v++;
            char* ve = lend;
            while (ve > v && (ve[-1] == ' ' || ve[-1] == '\t')) ve--; /* 修尾空白 */
            int vlen = (int)(ve - v);
            if (nlen == 13 && strncasecmp(ls, "Authorization", 13) == 0) {
                c->auth = v; c->auth_len = vlen;
            } else if (nlen == 14 && strncasecmp(ls, "Content-Length", 14) == 0) {
                c->content_len = parse_uint(v, vlen);
            }
        }
        if (le >= hdr_len) break;
        p = le + 2;
    }
    return 1;
}

static void dispatch(struct conn* c) {
    int body_start = c->hdr_end;
    const char* body = c->buf + body_start;
    s_cb(c, c, APP_REQUEST_CMD, body, c->content_len);
    if (!c->used) return;           /* callback 已 web_snd_data → 連線已關 */
    if (!c->responded) {
        static const char r404[] =
            "HTTP/1.1 404 Not Found\r\n"
            "Server: " HBI_WEB_SERVER "\r\n"
            "Content-Length: 0\r\n"
            "Connection: close\r\n\r\n";
        send_all(c->fd, r404, (int)(sizeof(r404) - 1));
        conn_close(c);
    }
}

/* idle 掃描：借每次 readable 事件檢查所有 conn；逾時仍未收齊完整請求者關閉。 */
static void sweep_idle(struct conn* self) {
    unsigned long long now = clock_time();
    for (int i = 0; i < MAX_CONNS; i++) {
        struct conn* c = &s_conns[i];
        if (!c->used || c == self) continue;
        if (now - c->last_io > IDLE_MS) conn_close(c);
    }
}

static void on_conn_readable(struct event_loop* loop, int fd, void* arg) {
    (void)loop; (void)fd;
    struct conn* c = arg;
    if (!c->used) return;

    /* 1) 非阻塞累積：讀到 EAGAIN 為止，跨多次 readable 事件保留狀態。 */
    for (;;) {
        int space = CONN_CAP - c->len;
        if (space <= 0) { conn_close(c); return; } /* 緩衝滿仍不完整：邊界超限，關閉 */
        int n = recv(c->fd, c->buf + c->len, space, 0);
        if (n > 0) { c->len += n; c->last_io = clock_time(); continue; }
        if (n == 0) { conn_close(c); return; }      /* 對端關閉（EOF） */
        if (errno == EINTR) continue;
        if (errno == EAGAIN || errno == EWOULDBLOCK) break;
        conn_close(c); return;                       /* 其他錯誤 */
    }

    /* 順帶回收其他閒置連線（此連線 last_io 剛更新，不會被自己誤殺）。 */
    sweep_idle(c);

    /* 2) headers 尚未解析：找 "\r\n\r\n"。 */
    if (c->hdr_end == 0) {
        int pos = find_hdr_end(c->buf, c->len);
        if (pos < 0) {
            if (c->len >= MAX_HEADERS) { conn_close(c); return; } /* headers 過長仍未終止 */
            return; /* 尚未收齊，等下一次 readable */
        }
        if (pos > MAX_HEADERS) { conn_close(c); return; }         /* header 區超限 */
        if (!parse_request(c, pos)) { conn_close(c); return; }    /* request line 畸形 */
        if (c->url_len > MAX_URL) { conn_close(c); return; }      /* URL 超限 */
        if (c->content_len > MAX_BODY) { conn_close(c); return; } /* body 超限 */
        c->hdr_end = pos + 4; /* body 起點；>0 標記 headers 已解析 */
        /* 防禦性：headers+body 合計不得超過緩衝容量（極端 8KB headers＋32KB body 邊角）。
         * recv 的 space 守衛已保證不溢位；此處提前明確拒絕，免得無謂緩衝一個註定失敗的請求。 */
        if (c->hdr_end + c->content_len > CONN_CAP) { conn_close(c); return; }
    }

    /* 3) body 是否收滿。 */
    int have_body = c->len - c->hdr_end;
    if (have_body < c->content_len) return; /* body 未齊，等下一次 readable */

    /* 4) 完整請求 → 派送 callback（未 respond 則自動 404）。 */
    dispatch(c);
}

static void on_listen_readable(struct event_loop* loop, int fd, void* arg) {
    (void)arg;
    int cfd = accept(fd, NULL, NULL);
    if (cfd < 0) return;
    struct conn* c = NULL;
    for (int i = 0; i < MAX_CONNS; i++) if (!s_conns[i].used) { c = &s_conns[i]; break; }
    if (!c) { close_socket(cfd); return; }               /* 併發上限：超額直接關 */
    memset(c, 0, sizeof(*c));
    c->fd = cfd; c->used = 1; c->last_io = clock_time();
    set_no_block(cfd);
    ev_reg_fd(loop, cfd, on_conn_readable, c);
}

void init_web_listen(int port, http_callback_fn cb, struct event_loop* loop,
                     void* b1, int l1, void* b2, int l2, void* b3, int l3,
                     char** urls, int nurls, char** care, int ncare, int flag) {
    (void)b1;(void)l1;(void)b2;(void)l2;(void)b3;(void)l3;
    (void)urls;(void)nurls;(void)care;(void)ncare;(void)flag;
    signal(SIGPIPE, SIG_IGN);
    s_cb = cb; s_loop = loop;
    s_listen_fd = socket(AF_INET, SOCK_STREAM, 0);
    int one = 1;
    setsockopt(s_listen_fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
    struct sockaddr_in a; memset(&a, 0, sizeof(a));
    a.sin_family = AF_INET;
    a.sin_port = htons((unsigned short)port);
    a.sin_addr.s_addr = INADDR_ANY;
    bind(s_listen_fd, (struct sockaddr*)&a, sizeof(a));
    listen(s_listen_fd, 8);
    set_no_block(s_listen_fd);
    ev_reg_fd(loop, s_listen_fd, on_listen_readable, NULL);
}

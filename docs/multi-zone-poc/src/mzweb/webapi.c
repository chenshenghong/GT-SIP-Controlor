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
#include <arpa/inet.h>
#include <unistd.h>
#include "event.h"
#include "socketbase.h"
#include "webapi.h"
#include "mzcert.h"
#include "mbedtls/ssl.h"
#include "mbedtls/entropy.h"
#include "mbedtls/ctr_drbg.h"
#include "mbedtls/net_sockets.h"   /* MBEDTLS_ERR_NET_{RECV,SEND}_FAILED */

#define MAX_CONNS   4
#define MAX_HEADERS 8192
#define MAX_URL     2048
#define MAX_BODY    32768
#ifndef IDLE_MS
#define IDLE_MS     30000        /* conn 逾此毫秒未收齊完整請求 → 回收（可 -DIDLE_MS 覆蓋，測試用縮短） */
#endif
#ifndef SWEEP_MS
#define SWEEP_MS    5000         /* idle 清掃 timer 週期（可 -DSWEEP_MS 覆蓋） */
#endif
#ifndef HS_TIMEOUT_MS
#define HS_TIMEOUT_MS 10000      /* TLS handshake 硬上限：逾此仍未握手完成 → 關閉（防 TLS slow-loris；可 -DHS_TIMEOUT_MS 覆蓋） */
#endif
#ifndef OUT_TIMEOUT_MS
#define OUT_TIMEOUT_MS 30000     /* 寫出硬上限：一段回應從開始緩衝起逾此仍未送畢 → 關閉（防「涓滴讀取」寫出面 slow-loris；與 hs_deadline 對稱、與 last_io 解耦，不隨 n>0 刷新。30s 給正常慢速行動網路收 ~23KB 充裕餘裕；可 -DOUT_TIMEOUT_MS 覆蓋，測試用縮短） */
#endif
#ifndef OUT_MAX
#define OUT_MAX     (2*1024*1024) /* 單段回應 len 上限護欄（defense-in-depth）：production 兩呼叫點（serve_index ~23KB、mzweb_zones clamped）皆遠低於此。逾此 → 不緩衝、關閉（可 -DOUT_MAX 覆蓋） */
#endif
#define CONN_CAP    (MAX_HEADERS + MAX_BODY + 1)

struct conn {
    int fd; int used;
    char buf[CONN_CAP];
    int len;                    /* 已累積 bytes */
    int hdr_end;                /* body 起始 offset（= "\r\n\r\n" 起點 + 4）；0 = headers 未解析 */
    int content_len;            /* 解析出的 Content-Length（無則 0） */
    int responded;              /* web_snd_data 已被呼叫 */
    unsigned long long last_io; /* idle timeout 用 */
    /* --- per-conn 送出緩衝（事件驅動非阻塞寫）：回應整段存此，conn_flush 逐次排空。
     * 傳輸層送出緩衝滿（WANT_WRITE/EAGAIN）→ ev_set_writable(+POLLOUT)＋return 回 poll，
     * 絕不原地空轉。送完 → conn_close。out_buf 動態配置（回應可達內嵌頁 ~23KB），
     * conn_close 釋放。out_pending：此 conn 尚有待送 bytes（讀路徑據此改走排空）。 --- */
    char* out_buf; int out_len; int out_off; int out_pending;
    unsigned long long out_deadline; /* 首次緩衝一段回應時 = now + OUT_TIMEOUT_MS；防寫出面 slow-loris 硬牆，不隨 n>0 刷新（與 last_io 解耦，對稱 hs_deadline） */
    /* http_head 視圖（指進 buf，非 NUL 結尾） */
    char* url; int url_len;
    char* auth; int auth_len;   /* Authorization 值 */
    char* host; int host_len;   /* Host 值（T4 301 Location 組址用；不經 get_http_head 公開，
                                  * 避免與 P7 T5 對 get_http_head 的擴充計畫衝突——見 webapi.h 註記） */
    int is_get;
    /* --- TLS 狀態（is_tls=0 時全不觸碰；ssl 由 accept 時 memset(0) 即 init 態） --- */
    int is_tls;                 /* 此 conn 走 :443 TLS 終結 */
    int hs_done;                /* 非阻塞 handshake 已完成 */
    mbedtls_ssl_context ssl;    /* per-conn TLS 上下文（BIO ctx = 本 conn） */
    unsigned long long hs_deadline; /* accept 時 = now + HS_TIMEOUT_MS；防 slow-loris 握手拖延 */
};
static struct conn s_conns[MAX_CONNS];
static http_callback_fn s_cb;
static struct event_loop* s_loop;
static int s_listen_fd = -1;
static int s_tls_listen_fd = -1;
static TIMER_EVENT s_idle_timer;    /* 自我重新武裝的週期 timer，驅動 idle 清掃（見 Critical-1） */
static int s_idle_started;           /* idle 清掃 timer 已啟動（:80/:443 共用，僅啟動一次） */

/* --- 伺服器生命週期共享的 TLS 材料（單執行緒，全程存活） --- */
static mbedtls_ssl_config     s_ssl_conf;
static mbedtls_x509_crt       s_srvcert;
static mbedtls_pk_context     s_pkey;
static mbedtls_entropy_context s_entropy;
static mbedtls_ctr_drbg_context s_ctr_drbg;
static int s_tls_ready;              /* ssl_conf 已就緒（憑證載入＋config 完成） */

static void conn_close(struct conn* c) {
    if (!c->used) return;
    if (c->is_tls) {
        /* fd 仍開著時送 close_notify（BIO 走 c->fd）；非阻塞下回 WANT_* 就放棄，
         * 不為了優雅關閉阻塞單執行緒 loop。ssl_free 恰一次（used=0 早退保證不重入）。 */
        mbedtls_ssl_close_notify(&c->ssl);
        mbedtls_ssl_free(&c->ssl);
    }
    ev_set_writable(s_loop, c->fd, 0);   /* 清 POLLOUT 興趣（須在 ev_unreg_fd 之前，靠 fd 尋位） */
    ev_unreg_fd(s_loop, c->fd);
    close_socket(c->fd);
    if (c->out_buf) { free(c->out_buf); c->out_buf = NULL; }  /* 釋放送出緩衝（動態配置） */
    c->out_len = c->out_off = c->out_pending = 0;
    c->used = 0;
}

/* conn_flush — 事件驅動非阻塞排空 out_buf[out_off..out_len)。
 *   TLS：mbedtls_ssl_write；明文：send(MSG_NOSIGNAL)。
 *   WANT_WRITE / EAGAIN → ev_set_writable(+POLLOUT)＋return（回 poll，絕不空轉單執行緒 loop）。
 *   WANT_READ（TLS 重議罕見）→ 清 POLLOUT 改等 POLLIN（POLLIN 恆在興趣集）＋return。
 *   全數送畢 → conn_close（回應皆 Connection: close）。致命錯誤 / 對端關閉 → conn_close。 */
static void conn_flush(struct conn* c) {
    if (!c->used) return;
    while (c->out_off < c->out_len) {
        int remaining = c->out_len - c->out_off;
        if (c->is_tls) {
            int n = mbedtls_ssl_write(&c->ssl,
                        (const unsigned char*)(c->out_buf + c->out_off), (size_t)remaining);
            if (n > 0) { c->out_off += n; c->last_io = clock_time(); continue; }
            if (n == MBEDTLS_ERR_SSL_WANT_WRITE) { ev_set_writable(s_loop, c->fd, 1); return; }
            if (n == MBEDTLS_ERR_SSL_WANT_READ)  { ev_set_writable(s_loop, c->fd, 0); return; }
            conn_close(c); return;               /* 對端關閉 / 致命錯誤 */
        } else {
            int n = send(c->fd, c->out_buf + c->out_off, remaining, MSG_NOSIGNAL);
            if (n > 0) { c->out_off += n; c->last_io = clock_time(); continue; }
            if (n < 0 && errno == EINTR) continue;
            if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
                ev_set_writable(s_loop, c->fd, 1); return;
            }
            conn_close(c); return;               /* 對端關閉 / 其他錯誤 */
        }
    }
    conn_close(c);                               /* out_off == out_len：送完即關 */
}

/* 把整段回應複製進 conn 送出緩衝並啟動非阻塞排空（caller 之後可自由釋放 buffer）。
 * 明文與 TLS 共用此路徑 → 消除舊 send_all 的 EAGAIN 截斷隱患。 */
static void conn_send(struct conn* c, const char* buffer, int len) {
    if (!c->used) return;
    if (len <= 0) { conn_close(c); return; }
    if (len > OUT_MAX) { conn_close(c); return; } /* Minor 1 護欄：異常大 len 不緩衝、直接關閉（production 兩呼叫點皆遠低於上限） */
    char* nb = (char*)malloc((size_t)len);
    if (!nb) { conn_close(c); return; }          /* 配置失敗：無法回應，關閉 */
    memcpy(nb, buffer, (size_t)len);
    if (c->out_buf) free(c->out_buf);            /* 防禦：單次回應，理論上不會既有緩衝 */
    c->out_buf = nb; c->out_len = len; c->out_off = 0; c->out_pending = 1;
    /* 寫出硬牆：此刻設定一次，之後 conn_flush 的 n>0 只刷 last_io、絕不動 out_deadline。
     * 攻擊者涓滴讀取（每 <IDLE_MS 收數 byte）令 last_io 恆新鮮、idle 永不成立時，
     * out_deadline 仍會在固定時限強制回收 slot（對稱 hs_deadline 對握手 slow-loris 的硬牆）。 */
    c->out_deadline = clock_time() + OUT_TIMEOUT_MS;
    conn_flush(c);                               /* 先試同步排空；卡住則轉 POLLOUT 驅動 */
}

/* T4：安全回應標頭，套用於「所有」回應（301、404、TLS 路由回應）。單一組字串常數，
 * append_security_headers 為唯一組裝點——避免三處各自拼字元造成漂移。 */
#define SEC_HEADERS_TEXT \
    "X-Frame-Options: SAMEORIGIN\r\n" \
    "X-Content-Type-Options: nosniff\r\n" \
    "X-XSS-Protection: 1; mode=block\r\n"
#define SEC_HEADERS_LEN ((int)(sizeof(SEC_HEADERS_TEXT) - 1))

static int append_security_headers(char* buf) {
    memcpy(buf, SEC_HEADERS_TEXT, (size_t)SEC_HEADERS_LEN);
    return SEC_HEADERS_LEN;
}

void web_snd_data(void* client, const char* buffer, int len) {
    struct conn* c = client;
    c->responded = 1;
    /* 所有經此路徑送出的回應（含 TLS 路由回應）在 status line 之後插入安全標頭——
     * 呼叫端（mzweb_zones.c/serve_index.c/測試 cb）維持原樣，不需各自加標頭。
     * 找不到 status line 結尾（畸形呼叫）則原樣送出，不阻塞回應。 */
    int se = -1;
    if (len > 0) {
        for (int i = 0; i + 1 < len; i++) {
            if (buffer[i] == '\r' && buffer[i+1] == '\n') { se = i; break; }
        }
    }
    if (se < 0) { conn_send(c, buffer, len); return; }
    int head_len = se + 2;
    int tail_len = len - head_len;
    char* nb = (char*)malloc((size_t)(head_len + SEC_HEADERS_LEN + tail_len));
    if (!nb) { conn_send(c, buffer, len); return; }   /* 配置失敗：退回原樣送出而非直接關閉 */
    memcpy(nb, buffer, (size_t)head_len);
    int hlen = append_security_headers(nb + head_len);
    memcpy(nb + head_len + hlen, buffer + head_len, (size_t)tail_len);
    conn_send(c, nb, head_len + hlen + tail_len);
    free(nb);
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
            } else if (nlen == 4 && strncasecmp(ls, "Host", 4) == 0) {
                c->host = v; c->host_len = vlen;   /* T4：301 Location 組址用 */
            }
        }
        if (le >= hdr_len) break;
        p = le + 2;
    }
    return 1;
}

/* 直接由 webapi.c 組裝、不經 web_snd_data 的回應（301／404）在此各自呼叫
 * append_security_headers 一次；不可再走 web_snd_data（否則標頭會被重複插入兩次）。 */
static void send_404(struct conn* c) {
    char resp[256];
    int n = snprintf(resp, sizeof(resp),
        "HTTP/1.1 404 Not Found\r\n"
        "Server: " HBI_WEB_SERVER "\r\n"
        "Content-Length: 0\r\n"
        "Connection: close\r\n");
    if (n < 0 || n >= (int)sizeof(resp)) { conn_close(c); return; }
    n += append_security_headers(resp + n);
    n += snprintf(resp + n, sizeof(resp) - (size_t)n, "\r\n");
    c->responded = 1;
    conn_send(c, resp, n);            /* 走緩衝路徑（明文/TLS 皆非阻塞、送畢自關） */
}

/* T4：:80 全轉址 https（憑證已就緒／s_tls_ready）。Location host 優先取請求 Host: header；
 * 取不到（畸形請求／HTTP/1.0 無 Host）則以 getsockname 取本機（server 端）IP 兜底，
 * 確保任何情況都給出可解析的 https:// 絕對網址，不留空 Location。 */
static void send_redirect(struct conn* c) {
    char hostbuf[128];
    const char* host; int hostlen;
    if (c->host_len > 0 && c->host_len < (int)sizeof(hostbuf)) {
        host = c->host; hostlen = c->host_len;
    } else {
        struct sockaddr_in sa; socklen_t sl = sizeof(sa);
        char ipbuf[INET_ADDRSTRLEN];
        if (getsockname(c->fd, (struct sockaddr*)&sa, &sl) == 0 &&
            inet_ntop(AF_INET, &sa.sin_addr, ipbuf, sizeof(ipbuf))) {
            hostlen = snprintf(hostbuf, sizeof(hostbuf), "%s", ipbuf);
        } else {
            hostlen = snprintf(hostbuf, sizeof(hostbuf), "127.0.0.1");
        }
        host = hostbuf;
    }
    char resp[MAX_URL + 640];
    int n = snprintf(resp, sizeof(resp),
        "HTTP/1.1 301 Moved Permanently\r\n"
        "Location: https://%.*s%.*s\r\n"
        "Content-Length: 0\r\n"
        "Connection: close\r\n",
        hostlen, host, c->url_len, c->url);
    if (n < 0 || n >= (int)sizeof(resp)) { conn_close(c); return; } /* 防禦性：不送出被截斷的 Location */
    n += append_security_headers(resp + n);
    n += snprintf(resp + n, sizeof(resp) - (size_t)n, "\r\n");
    c->responded = 1;
    conn_send(c, resp, n);
}

static void dispatch(struct conn* c) {
    int body_start = c->hdr_end;
    const char* body = c->buf + body_start;
    s_cb(c, c, APP_REQUEST_CMD, body, c->content_len);
    if (!c->used) return;           /* callback 已 web_snd_data → 連線已關 */
    if (!c->responded) send_404(c);
}

/* idle 掃描：檢查所有 conn（self 傳 NULL 時全掃），逾時仍未收齊完整請求者關閉。
 * 由週期 timer 驅動（見 on_idle_timer），與 fd 活動無關 → slow-loris 沉默連線也會被回收。 */
static void sweep_idle(struct conn* self) {
    unsigned long long now = clock_time();
    for (int i = 0; i < MAX_CONNS; i++) {
        struct conn* c = &s_conns[i];
        if (!c->used || c == self) continue;
        /* TLS 握手硬上限：即使對端每隔幾秒滴一個 byte 拖住 last_io，也在 hs_deadline 強制回收。 */
        if (c->is_tls && !c->hs_done && now > c->hs_deadline) { conn_close(c); continue; }
        /* 寫出硬上限：卡在寫出（out_pending）的 conn，即使對端涓滴讀取令 last_io 恆新鮮、
         * idle 永不成立，也在 out_deadline 強制回收（寫出面 slow-loris 對稱 hs_deadline）。 */
        if (c->out_pending && now > c->out_deadline) { conn_close(c); continue; }
        /* idle 逾時回收：收 header 卡住的 slow-loris，以及對端「完全停止讀取」時 last_io
         * 凍結的寫出 conn（涓滴讀取者則由上面 out_deadline 兜住），超過 IDLE_MS 釋放 slot。 */
        if (now - c->last_io > IDLE_MS) conn_close(c);
    }
}

/* 週期 timer callback：清掃 idle 連線後重新武裝自己（T4 timer 觸發後 armed=0，需 re-arm 才週期化）。
 * 這是 Critical-1 的核心：不依賴任何 fd 產生 readable 事件，靜默卡住的 slow-loris 連線也會被回收。 */
static void on_idle_timer(struct event_loop* loop, struct event* ev, int arg) {
    (void)ev; (void)arg;
    sweep_idle(NULL);
    event_timer_start(loop, &s_idle_timer); /* 重新武裝，下一週期再觸發 */
}

/* idle 清掃 timer 只需啟動一次；:80 與 :443 init 皆可呼叫，冪等。 */
static void ensure_idle_timer(struct event_loop* loop) {
    if (s_idle_started) return;
    s_idle_started = 1;
    event_timer_init(&s_idle_timer, SWEEP_MS, on_idle_timer, NULL, 0);
    event_timer_start(loop, &s_idle_timer);
}

/* 已把（明文或 TLS 解密後的）bytes 累積進 c->buf 後，跑相同的 HTTP 解析/派送狀態機。
 * 明文與 TLS 路徑共用；呼叫後須檢查 c->used（可能已 conn_close）。 */
static void try_dispatch(struct conn* c) {
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

        /* T4：明文 :80 且憑證/TLS listener 已就緒 → 對「所有路徑」直接 301 轉址 https，
         * 不 dispatch 到路由、不等 body 收滿（Connection: close 隨即斷線，未讀 body 無妨）。
         * !s_tls_ready（首開憑證尚未就緒的窗口）維持原行為，走下方既有 http 服務。 */
        if (!c->is_tls && s_tls_ready) { send_redirect(c); return; }
    }

    /* 3) body 是否收滿。 */
    int have_body = c->len - c->hdr_end;
    if (have_body < c->content_len) return; /* body 未齊，等下一次 readable */

    /* 4) 完整請求 → 派送 callback（未 respond 則自動 404）。 */
    dispatch(c);
}

static void on_conn_readable(struct event_loop* loop, int fd, void* arg) {
    (void)loop; (void)fd;
    struct conn* c = arg;
    if (!c->used) return;

    /* 0) 排空優先：此 conn 已在送出回應（POLLOUT 或殘餘 POLLIN 喚醒）→ 續排空，
     *    不再讀取（回應皆 Connection: close，讀路徑此時無意義）。 */
    if (c->out_pending) { conn_flush(c); return; }

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

    try_dispatch(c);
}

/* --- TLS BIO callback：ctx = struct conn*。非阻塞 send/recv，EAGAIN → WANT_WRITE/READ。 --- */
static int ssl_send_cb(void* ctx, const unsigned char* buf, size_t len) {
    struct conn* c = ctx;
    int n = send(c->fd, buf, len, MSG_NOSIGNAL);
    if (n >= 0) return n;
    if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)
        return MBEDTLS_ERR_SSL_WANT_WRITE;   /* 非阻塞：等下次可寫 */
    return MBEDTLS_ERR_NET_SEND_FAILED;      /* 致命 */
}
static int ssl_recv_cb(void* ctx, unsigned char* buf, size_t len) {
    struct conn* c = ctx;
    int n = recv(c->fd, buf, len, 0);
    if (n > 0) { c->last_io = clock_time(); return n; }
    if (n == 0) return MBEDTLS_ERR_SSL_CONN_EOF;       /* 對端關閉傳輸層 */
    if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)
        return MBEDTLS_ERR_SSL_WANT_READ;    /* 非阻塞：等下次 poll 再讀 */
    return MBEDTLS_ERR_NET_RECV_FAILED;      /* 致命 */
}

/* :443 conn readable：先非阻塞推進 handshake（WANT_* 即 return 等下次 poll，絕不阻塞
 * 單執行緒 loop）；握手完成後以 mbedtls_ssl_read 逐筆解密累積，再走既有 HTTP 解析。 */
static void on_tls_conn_readable(struct event_loop* loop, int fd, void* arg) {
    (void)loop; (void)fd;
    struct conn* c = arg;
    if (!c->used) return;

    /* 0) 排空優先：已在送出回應（POLLOUT 或殘餘 POLLIN 喚醒）→ 續排空 out_buf，不再讀。 */
    if (c->out_pending) { conn_flush(c); return; }

    /* A) handshake 未完成：推進一步。WANT_READ/WRITE → return（狀態留在 ssl，下次 poll 續做）。 */
    if (!c->hs_done) {
        int hr = mbedtls_ssl_handshake(&c->ssl);
        if (hr == MBEDTLS_ERR_SSL_WANT_READ || hr == MBEDTLS_ERR_SSL_WANT_WRITE)
            return;                          /* 尚未完成，等下一次 readable（不阻塞） */
        if (hr != 0) { conn_close(c); return; } /* 握手失敗 → 關閉 */
        c->hs_done = 1;
        c->last_io = clock_time();
        /* 不 return：同一 TCP segment 可能已挾帶 app data 被 mbedtls 內部緩衝，
         * 此時 socket 無新 bytes、poll 不會再觸發 → 立即續往下讀，避免卡死。 */
    }

    /* B) 應用資料：mbedtls_ssl_read 迴圈到 WANT_READ（底層 socket 真的排空）為止。
     *    一次 socket 讀可能含多筆 TLS record，全在 mbedtls 內部緩衝 → 必須迴圈抽乾，
     *    否則剩餘 record 無 socket 事件喚醒會遺漏。 */
    for (;;) {
        int space = CONN_CAP - c->len;
        if (space <= 0) { conn_close(c); return; } /* 緩衝滿仍不完整：邊界超限 */
        int n = mbedtls_ssl_read(&c->ssl, (unsigned char*)(c->buf + c->len), (size_t)space);
        if (n > 0) { c->len += n; c->last_io = clock_time(); continue; }
        if (n == MBEDTLS_ERR_SSL_WANT_READ || n == MBEDTLS_ERR_SSL_WANT_WRITE)
            break;                           /* 傳輸層排空，等下次 poll */
        /* CONN_EOF / PEER_CLOSE_NOTIFY / 其他負值：對端關閉或致命錯誤 → 關閉。 */
        conn_close(c); return;
    }

    /* 順帶回收其他閒置連線（此連線 last_io 剛更新，不會被自己誤殺）。 */
    sweep_idle(c);

    try_dispatch(c);
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
    if (s_listen_fd < 0) {
        fprintf(stderr, "init_web_listen: socket() failed: %s\n", strerror(errno));
        return;
    }
    int one = 1;
    setsockopt(s_listen_fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
    struct sockaddr_in a; memset(&a, 0, sizeof(a));
    a.sin_family = AF_INET;
    a.sin_port = htons((unsigned short)port);
    a.sin_addr.s_addr = INADDR_ANY;
    if (bind(s_listen_fd, (struct sockaddr*)&a, sizeof(a)) < 0) {
        fprintf(stderr, "init_web_listen: bind(port=%d) failed: %s\n", port, strerror(errno));
        close_socket(s_listen_fd); s_listen_fd = -1;
        return; /* 埠被占用等：不註冊壞 fd 進 loop */
    }
    if (listen(s_listen_fd, 8) < 0) {
        fprintf(stderr, "init_web_listen: listen(port=%d) failed: %s\n", port, strerror(errno));
        close_socket(s_listen_fd); s_listen_fd = -1;
        return;
    }
    set_no_block(s_listen_fd);
    ev_reg_fd(loop, s_listen_fd, on_listen_readable, NULL);
    /* Critical-1：註冊自我重新武裝的週期 timer 驅動 idle 清掃，與 fd 活動解耦。 */
    ensure_idle_timer(loop);
}

/* :443 accept：配 conn slot、標 is_tls、mbedtls_ssl_setup + set_bio（BIO ctx = conn），
 * 握手不在此做（留給首次 readable，非阻塞推進）。 */
static void on_tls_listen_readable(struct event_loop* loop, int fd, void* arg) {
    (void)arg;
    int cfd = accept(fd, NULL, NULL);
    if (cfd < 0) return;
    if (!s_tls_ready) { close_socket(cfd); return; }     /* ssl_conf 未就緒（理論上不會走到） */
    struct conn* c = NULL;
    for (int i = 0; i < MAX_CONNS; i++) if (!s_conns[i].used) { c = &s_conns[i]; break; }
    if (!c) { close_socket(cfd); return; }               /* 併發上限（TLS 亦計入）：超額直接關 */
    memset(c, 0, sizeof(*c));                             /* ssl 隨之歸零 = mbedtls_ssl_init 態 */
    c->fd = cfd;
    set_no_block(cfd);
    if (mbedtls_ssl_setup(&c->ssl, &s_ssl_conf) != 0) {   /* 綁 config 到本連線 ssl 上下文 */
        mbedtls_ssl_free(&c->ssl);                        /* setup 半成品亦須釋放 */
        close_socket(cfd);
        return;                                           /* used 仍為 0，slot 可再用 */
    }
    mbedtls_ssl_set_bio(&c->ssl, c, ssl_send_cb, ssl_recv_cb, NULL); /* 非阻塞 BIO */
    c->used = 1; c->is_tls = 1; c->hs_done = 0;
    c->last_io = clock_time();
    c->hs_deadline = c->last_io + HS_TIMEOUT_MS;          /* 握手硬上限 → 防 slow-loris */
    ev_reg_fd(loop, cfd, on_tls_conn_readable, c);
}

void init_web_listen_tls(int https_port, http_callback_fn cb, struct event_loop* loop,
                         const char* crt_path, const char* key_path, const char* ip) {
    signal(SIGPIPE, SIG_IGN);
    s_cb = cb; s_loop = loop;                             /* 與 :80 路徑共用 callback/loop */

    /* --- 1) 憑證：不存在則自簽產生，再載入 mbedTLS 結構 --- */
    mbedtls_ssl_config_init(&s_ssl_conf);
    mbedtls_x509_crt_init(&s_srvcert);
    mbedtls_pk_init(&s_pkey);
    mbedtls_entropy_init(&s_entropy);
    mbedtls_ctr_drbg_init(&s_ctr_drbg);

    if (mbedtls_ctr_drbg_seed(&s_ctr_drbg, mbedtls_entropy_func, &s_entropy,
                              (const unsigned char*)"mzweb-tls", 9) != 0) {
        fprintf(stderr, "init_web_listen_tls: ctr_drbg_seed failed\n");
        return;
    }
    if (mzcert_ensure(crt_path, key_path, ip) != 0) {
        fprintf(stderr, "init_web_listen_tls: mzcert_ensure(%s) failed\n", crt_path);
        return;
    }
    if (mzcert_load(crt_path, key_path, &s_srvcert, &s_pkey, &s_ctr_drbg) != 0) {
        fprintf(stderr, "init_web_listen_tls: mzcert_load failed\n");
        return;
    }

    /* --- 2) mbedTLS server 端 ssl_config：TLS1.2、伺服器不驗客戶端、掛自簽憑證 --- */
    if (mbedtls_ssl_config_defaults(&s_ssl_conf, MBEDTLS_SSL_IS_SERVER,
                                    MBEDTLS_SSL_TRANSPORT_STREAM,
                                    MBEDTLS_SSL_PRESET_DEFAULT) != 0) {
        fprintf(stderr, "init_web_listen_tls: ssl_config_defaults failed\n");
        return;
    }
    mbedtls_ssl_conf_rng(&s_ssl_conf, mbedtls_ctr_drbg_random, &s_ctr_drbg);
    mbedtls_ssl_conf_authmode(&s_ssl_conf, MBEDTLS_SSL_VERIFY_NONE);
    if (mbedtls_ssl_conf_own_cert(&s_ssl_conf, &s_srvcert, &s_pkey) != 0) {
        fprintf(stderr, "init_web_listen_tls: conf_own_cert failed\n");
        return;
    }
    s_tls_ready = 1;

    /* --- 3) :443 listen fd，註冊進同一 event loop（同既有 :80） --- */
    s_tls_listen_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (s_tls_listen_fd < 0) {
        fprintf(stderr, "init_web_listen_tls: socket() failed: %s\n", strerror(errno));
        return;
    }
    int one = 1;
    setsockopt(s_tls_listen_fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
    struct sockaddr_in a; memset(&a, 0, sizeof(a));
    a.sin_family = AF_INET;
    a.sin_port = htons((unsigned short)https_port);
    a.sin_addr.s_addr = INADDR_ANY;
    if (bind(s_tls_listen_fd, (struct sockaddr*)&a, sizeof(a)) < 0) {
        fprintf(stderr, "init_web_listen_tls: bind(port=%d) failed: %s\n", https_port, strerror(errno));
        close_socket(s_tls_listen_fd); s_tls_listen_fd = -1;
        return;
    }
    if (listen(s_tls_listen_fd, 8) < 0) {
        fprintf(stderr, "init_web_listen_tls: listen(port=%d) failed: %s\n", https_port, strerror(errno));
        close_socket(s_tls_listen_fd); s_tls_listen_fd = -1;
        return;
    }
    set_no_block(s_tls_listen_fd);
    ev_reg_fd(loop, s_tls_listen_fd, on_tls_listen_readable, NULL);
    ensure_idle_timer(loop);
}

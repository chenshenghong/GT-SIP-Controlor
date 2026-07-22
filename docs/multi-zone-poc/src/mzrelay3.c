/* mzrelay3 — GT-SIP-GW multi-zone PoC side-car (P5: REST control plane + real IGMP join).
 *
 * Evolution of mzrelay2 (P2 arbitration + RTP rewrite, P4 PT pass-through):
 *   - Zone table (16 rows) lives in a JSON file (default /opt/mzzones.json), schema per
 *     需求單 §三: zone_id/multicast_address/multicast_port/priority/enabled/audio_codec.
 *   - Each enabled zone gets its own socket with a real IGMP join (IP_ADD_MEMBERSHIP).
 *   - Built-in REST server (spec §四, sidecar variant):
 *       GET  /get/sip/multicast/zones          -> {"zones":[ ...16 rows... ]}
 *       POST /set/sip/multicast/zones          -> full-table overwrite, server-side
 *            validation (E001 with zone_id), live re-join without restart, atomic
 *            persist (tmp+rename+sync).
 *   - Same-priority ties: first-come-first-served (spec §一) — the current winner is
 *     only displaced by a STRICTLY higher priority (v2 picked lowest index on ties).
 *
 * usage: mzrelay3 <dst_grp> <dst_port> <ttl> <ifaddr> <silence_ms> <rest_port> [zones.json]
 * Build: static armv7 musl (see mzrelay.c).
 */
#define _GNU_SOURCE            /* memmem, strcasestr */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <unistd.h>
#include <fcntl.h>
#include <time.h>
#include <errno.h>
#include <arpa/inet.h>
#include <sys/socket.h>
#include <sys/select.h>
#include <netinet/in.h>

#define NZONES 16
#define REQMAX 8192

struct zdef {                       /* configured row (persisted) */
    char addr[40];
    int  port;
    int  prio;
    int  enabled;
    char codec[8];                  /* "G.722" | "G.711U" */
};
struct zrun {                       /* runtime state */
    int  fd;                        /* -1 when not joined */
    long last;
    int  active;
    long first_active;              /* for first-come tie-break bookkeeping */
};

static struct zdef zd[NZONES];
static struct zrun zr[NZONES];
static const char *g_ifaddr;
static char g_zpath[256];

static long now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1000L + ts.tv_nsec / 1000000L;
}

/* ---------- zone sockets ---------- */

static void zone_close(int i) {
    if (zr[i].fd >= 0) { close(zr[i].fd); zr[i].fd = -1; }
    zr[i].active = 0; zr[i].last = 0; zr[i].first_active = 0;
}

/* join/bind one enabled zone; returns 0 ok. Failure must not affect other zones (MZ-01). */
static int zone_open(int i) {
    zone_close(i);
    if (!zd[i].enabled) return 0;
    int fd = socket(AF_INET, SOCK_DGRAM, 0);
    if (fd < 0) return -1;
    int one = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
    struct sockaddr_in a;
    memset(&a, 0, sizeof(a));
    a.sin_family = AF_INET;
    a.sin_addr.s_addr = htonl(INADDR_ANY);
    a.sin_port = htons(zd[i].port);
    if (bind(fd, (struct sockaddr *)&a, sizeof(a)) < 0) {
        fprintf(stderr, "zone%d: bind %d failed: %s\n", i + 1, zd[i].port, strerror(errno));
        close(fd); return -1;
    }
    struct in_addr ga; ga.s_addr = inet_addr(zd[i].addr);
    if ((ntohl(ga.s_addr) >> 28) == 0xE) {          /* 224/4 -> real IGMP join */
        struct ip_mreq mr;
        mr.imr_multiaddr = ga;
        mr.imr_interface.s_addr = inet_addr(g_ifaddr);
        if (setsockopt(fd, IPPROTO_IP, IP_ADD_MEMBERSHIP, &mr, sizeof(mr)) < 0)
            fprintf(stderr, "zone%d: IGMP join %s failed: %s\n", i + 1, zd[i].addr, strerror(errno));
    }
    zr[i].fd = fd;
    fprintf(stderr, "zone%d: %s:%d prio %d joined\n", i + 1, zd[i].addr, zd[i].port, zd[i].prio);
    return 0;
}

static void zones_apply_all(void) {
    for (int i = 0; i < NZONES; i++) zone_open(i);
}

/* ---------- tiny JSON helpers (fixed schema only) ---------- */

/* extract "key":<value> inside object slice [p,end); returns 1 + copies raw token */
static int jfield(const char *p, const char *end, const char *key, char *out, int outsz) {
    char pat[40];
    snprintf(pat, sizeof(pat), "\"%s\"", key);
    const char *k = p;
    size_t patlen = strlen(pat);
    while (k < end && (k = memmem(k, (size_t)(end - k), pat, patlen)) != NULL) {
        const char *v = k + patlen;
        while (v < end && (*v == ' ' || *v == '\t')) v++;
        if (v < end && *v == ':') {
            v++;
            while (v < end && (*v == ' ' || *v == '\t')) v++;
            int n = 0;
            if (v < end && *v == '"') {
                v++;
                while (v < end && *v != '"' && n < outsz - 1) out[n++] = *v++;
            } else {
                while (v < end && *v != ',' && *v != '}' && *v != ' ' && n < outsz - 1)
                    out[n++] = *v++;
            }
            out[n] = 0;
            return 1;
        }
        k += patlen;
    }
    return 0;
}

static int json_serialize(char *out, int outsz) {
    int off = snprintf(out, (size_t)outsz, "{\"zones\":[");
    for (int i = 0; i < NZONES; i++) {
        /* pure placeholder rows report empty codec so device-web shows its
         * "(please pick)" sentinel and treats the row as untouched on save */
        int ph = !zd[i].enabled && zd[i].addr[0] == 0 && zd[i].port == 0 && zd[i].prio == 0;
        off += snprintf(out + off, (size_t)(outsz - off),
            "%s{\"zone_id\":%d,\"multicast_address\":\"%s\",\"multicast_port\":%d,"
            "\"priority\":%d,\"enabled\":%s,\"audio_codec\":\"%s\"}",
            i ? "," : "", i + 1, zd[i].addr, zd[i].port, zd[i].prio,
            zd[i].enabled ? "true" : "false", ph ? "" : zd[i].codec);
        if (off >= outsz - 2) return -1;
    }
    off += snprintf(out + off, (size_t)(outsz - off), "]}");
    return off;
}

/* parse zones array from body into tmp[]; returns 0 ok, else sets err (E001 text) */
static int json_parse_zones(const char *body, struct zdef *tmp, char *err, int errsz) {
    for (int i = 0; i < NZONES; i++) {          /* absent zone_id => keep current row */
        tmp[i] = zd[i];
    }
    const char *p = strstr(body, "\"zones\"");
    if (!p) { snprintf(err, (size_t)errsz, "missing zones array"); return -1; }
    p = strchr(p, '[');
    if (!p) { snprintf(err, (size_t)errsz, "missing zones array"); return -1; }
    const char *arr_end = strrchr(p, ']');
    if (!arr_end) { snprintf(err, (size_t)errsz, "unterminated zones array"); return -1; }
    while ((p = strchr(p, '{')) != NULL && p < arr_end) {
        const char *oend = strchr(p, '}');
        if (!oend || oend > arr_end) { snprintf(err, (size_t)errsz, "bad object"); return -1; }
        char tok[64];
        if (!jfield(p, oend, "zone_id", tok, sizeof(tok))) {
            snprintf(err, (size_t)errsz, "row missing zone_id"); return -1;
        }
        int id = atoi(tok);
        if (id < 1 || id > NZONES) { snprintf(err, (size_t)errsz, "zone_id %d out of range", id); return -1; }
        struct zdef *z = &tmp[id - 1];
        if (jfield(p, oend, "multicast_address", tok, sizeof(tok)))
            snprintf(z->addr, sizeof(z->addr), "%s", tok);
        if (jfield(p, oend, "multicast_port", tok, sizeof(tok))) z->port = atoi(tok);
        if (jfield(p, oend, "priority", tok, sizeof(tok)))       z->prio = atoi(tok);
        if (jfield(p, oend, "enabled", tok, sizeof(tok)))        z->enabled = (strcmp(tok, "true") == 0);
        if (jfield(p, oend, "audio_codec", tok, sizeof(tok)))
            snprintf(z->codec, sizeof(z->codec), "%s", tok);
        p = oend + 1;
    }
    return 0;
}

/* ---------- validation (spec §4.2) ---------- */

static int addr_valid_mcast(const char *s) {
    struct in_addr a;
    if (inet_pton(AF_INET, s, &a) != 1) return 0;
    unsigned first = ntohl(a.s_addr) >> 24;
    return first >= 224 && first <= 239;
}

/* returns 0 ok; else writes E001 message naming the zone_id */
static int validate_zones(const struct zdef *t, char *err, int errsz) {
    for (int i = 0; i < NZONES; i++) {
        const struct zdef *z = &t[i];
        /* placeholder: disabled AND addr empty AND port==0 AND prio==0 (codec ignored) */
        if (!z->enabled && z->addr[0] == 0 && z->port == 0 && z->prio == 0) continue;
        if (!addr_valid_mcast(z->addr)) {
            snprintf(err, (size_t)errsz, "zone_id %d: multicast_address invalid (224-239 required)", i + 1);
            return -1;
        }
        if (z->port < 1024 || z->port > 65535) {
            snprintf(err, (size_t)errsz, "zone_id %d: multicast_port out of range 1024-65535", i + 1);
            return -1;
        }
        if (z->prio < 1 || z->prio > 16) {
            snprintf(err, (size_t)errsz, "zone_id %d: priority out of range 1-16", i + 1);
            return -1;
        }
        if (strcmp(z->codec, "G.722") != 0 && strcmp(z->codec, "G.711U") != 0) {
            snprintf(err, (size_t)errsz, "zone_id %d: audio_codec must be G.711U or G.722", i + 1);
            return -1;
        }
    }
    for (int i = 0; i < NZONES; i++) {           /* priority unique among enabled only */
        if (!t[i].enabled) continue;
        for (int j = i + 1; j < NZONES; j++) {
            if (t[j].enabled && t[i].prio == t[j].prio) {
                snprintf(err, (size_t)errsz, "zone_id %d: priority %d duplicates zone_id %d",
                         j + 1, t[j].prio, i + 1);
                return -1;
            }
        }
    }
    return 0;
}

/* ---------- persistence ---------- */

static void zones_default(void) {
    for (int i = 0; i < NZONES; i++) {
        memset(&zd[i], 0, sizeof(zd[i]));
        snprintf(zd[i].codec, sizeof(zd[i].codec), "G.722");
    }
}

static int zones_load(void) {
    FILE *f = fopen(g_zpath, "rb");
    if (!f) return -1;
    static char buf[REQMAX];
    size_t n = fread(buf, 1, sizeof(buf) - 1, f);
    fclose(f);
    buf[n] = 0;
    char err[128];
    struct zdef tmp[NZONES];
    zones_default();
    memcpy(tmp, zd, sizeof(tmp));
    if (json_parse_zones(buf, tmp, err, sizeof(err)) != 0) {
        fprintf(stderr, "zones_load: %s — keeping defaults\n", err);
        return -1;
    }
    memcpy(zd, tmp, sizeof(zd));
    return 0;
}

static int zones_save(void) {
    static char buf[REQMAX];
    int n = json_serialize(buf, sizeof(buf));
    if (n < 0) return -1;
    char tmp[280];
    snprintf(tmp, sizeof(tmp), "%s.tmp", g_zpath);
    int fd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd < 0) return -1;
    if (write(fd, buf, (size_t)n) != n) { close(fd); return -1; }
    fsync(fd); close(fd);
    if (rename(tmp, g_zpath) != 0) return -1;
    sync();
    return 0;
}

/* ---------- REST ---------- */

#define MZ_TOKEN "mzpoc-token"     /* PoC static bearer; production: per-login random */

static void http_reply(int cfd, int code, const char *ctype, const char *body) {
    char hdr[400];
    int blen = (int)strlen(body);
    int hn = snprintf(hdr, sizeof(hdr),
        "HTTP/1.1 %d %s\r\nContent-Type: %s\r\nContent-Length: %d\r\n"
        "Access-Control-Allow-Origin: *\r\n"
        "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
        "Access-Control-Allow-Headers: Authorization, Content-Type, Accept\r\n"
        "Connection: close\r\n\r\n",
        code, code == 200 ? "OK" : (code == 400 ? "Bad Request" :
                                    (code == 401 ? "Unauthorized" : "Not Found")),
        ctype, blen);
    write(cfd, hdr, (size_t)hn);
    write(cfd, body, (size_t)blen);
}

static int has_token(const char *req) {
    const char *a = strcasestr(req, "Authorization:");
    return a && strstr(a, "Bearer " MZ_TOKEN) != NULL;
}

/* read one HTTP request (bounded, single read loop w/ short timeout) */
static int http_read(int cfd, char *buf, int bufsz) {
    int total = 0;
    struct timeval tv = {2, 0};
    setsockopt(cfd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    for (;;) {
        ssize_t n = recv(cfd, buf + total, (size_t)(bufsz - 1 - total), 0);
        if (n <= 0) break;
        total += (int)n;
        buf[total] = 0;
        char *hend = strstr(buf, "\r\n\r\n");
        if (hend) {
            char *cl = strcasestr(buf, "Content-Length:");
            int want = cl ? atoi(cl + 15) : 0;
            int have = total - (int)(hend + 4 - buf);
            if (have >= want) return total;
        }
        if (total >= bufsz - 1) break;
    }
    return total;
}

static void rest_handle(int cfd) {
    static char req[REQMAX], out[REQMAX];
    int n = http_read(cfd, req, sizeof(req));
    if (n <= 0) { close(cfd); return; }
    if (strncmp(req, "OPTIONS ", 8) == 0) {          /* CORS preflight for device-web */
        http_reply(cfd, 200, "text/plain", "");
        close(cfd); return;
    }
    if (strncmp(req, "POST /auth/login", 16) == 0) { /* PoC login: any non-empty creds */
        char *body = strstr(req, "\r\n\r\n");
        char u[64] = "";
        if (body) jfield(body, req + n, "username", u, sizeof(u));
        if (u[0]) {
            snprintf(out, sizeof(out),
                "{\"status\":\"success\",\"data\":{\"token\":\"%s\","
                "\"user_info\":{\"username\":\"%s\"}}}", MZ_TOKEN, u);
            http_reply(cfd, 200, "application/json", out);
        } else {
            http_reply(cfd, 400, "application/json",
                "{\"status\":\"error\",\"error_code\":\"A001\",\"message\":\"bad credentials\"}");
        }
        close(cfd); return;
    }
    if (!has_token(req)) {                            /* zones endpoints: token required */
        http_reply(cfd, 401, "application/json",
            "{\"status\":\"error\",\"error_code\":\"A003\",\"message\":\"token invalid\"}");
        close(cfd); return;
    }
    if (strncmp(req, "GET /get/sip/multicast/zones", 28) == 0) {
        if (json_serialize(out, sizeof(out)) > 0) http_reply(cfd, 200, "application/json", out);
        else http_reply(cfd, 400, "application/json", "{\"status\":\"error\",\"message\":\"serialize\"}");
    } else if (strncmp(req, "POST /set/sip/multicast/zones", 29) == 0) {
        char *body = strstr(req, "\r\n\r\n");
        body = body ? body + 4 : req;
        struct zdef tmp[NZONES];
        char err[160];
        if (json_parse_zones(body, tmp, err, sizeof(err)) != 0 ||
            validate_zones(tmp, err, sizeof(err)) != 0) {
            snprintf(out, sizeof(out),
                "{\"status\":\"error\",\"error_code\":\"E001\",\"message\":\"%s\"}", err);
            http_reply(cfd, 400, "application/json", out);
        } else {
            memcpy(zd, tmp, sizeof(zd));
            zones_apply_all();                    /* live re-join, no restart */
            if (zones_save() != 0)
                fprintf(stderr, "WARN: zones persisted FAILED (%s)\n", strerror(errno));
            http_reply(cfd, 200, "application/json", "{\"status\":\"success\"}");
            fprintf(stderr, "[%ld] REST: zones table applied + persisted\n", now_ms());
        }
    } else {
        http_reply(cfd, 404, "application/json", "{\"status\":\"error\",\"message\":\"not found\"}");
    }
    close(cfd);
}

/* ---------- main ---------- */

int main(int argc, char **argv) {
    if (argc < 7) {
        fprintf(stderr, "usage: %s <dst_grp> <dst_port> <ttl> <ifaddr> <silence_ms> <rest_port> [zones.json]\n", argv[0]);
        return 2;
    }
    const char *dst_grp = argv[1];
    int   dst_port = atoi(argv[2]);
    int   ttl      = atoi(argv[3]);
    g_ifaddr       = argv[4];
    long  silence  = atol(argv[5]);
    int   rport    = atoi(argv[6]);
    snprintf(g_zpath, sizeof(g_zpath), "%s", argc > 7 ? argv[7] : "/opt/mzzones.json");

    zones_default();
    if (zones_load() != 0) fprintf(stderr, "no zones file yet (%s), starting empty\n", g_zpath);
    for (int i = 0; i < NZONES; i++) { zr[i].fd = -1; zr[i].active = 0; zr[i].last = 0; zr[i].first_active = 0; }
    zones_apply_all();

    int rs = socket(AF_INET, SOCK_STREAM, 0);
    int one = 1;
    setsockopt(rs, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
    struct sockaddr_in ra;
    memset(&ra, 0, sizeof(ra));
    ra.sin_family = AF_INET;
    ra.sin_addr.s_addr = htonl(INADDR_ANY);
    ra.sin_port = htons(rport);
    if (bind(rs, (struct sockaddr *)&ra, sizeof(ra)) < 0 || listen(rs, 4) < 0) {
        perror("rest bind/listen"); return 1;
    }

    int tx = socket(AF_INET, SOCK_DGRAM, 0);
    unsigned char cttl = (unsigned char)ttl;
    setsockopt(tx, IPPROTO_IP, IP_MULTICAST_TTL, &cttl, sizeof(cttl));
    struct in_addr ifa; ifa.s_addr = inet_addr(g_ifaddr);
    setsockopt(tx, IPPROTO_IP, IP_MULTICAST_IF, &ifa, sizeof(ifa));
    unsigned char loop = 1;
    setsockopt(tx, IPPROTO_IP, IP_MULTICAST_LOOP, &loop, sizeof(loop));
    struct sockaddr_in da;
    memset(&da, 0, sizeof(da));
    da.sin_family = AF_INET;
    da.sin_addr.s_addr = inet_addr(dst_grp);
    da.sin_port = htons(dst_port);

    unsigned int   out_ssrc = 0x5A5A0003;
    unsigned short out_seq  = 0;
    unsigned int   out_ts   = 0;
    int cur = -1;

    fprintf(stderr, "mzrelay3: -> %s:%d rest=:%d zones=%s silence=%ldms\n",
            dst_grp, dst_port, rport, g_zpath, silence);

    unsigned char buf[2048];
    for (;;) {
        fd_set rf; FD_ZERO(&rf); int mx = rs;
        FD_SET(rs, &rf);
        for (int i = 0; i < NZONES; i++)
            if (zr[i].fd >= 0) { FD_SET(zr[i].fd, &rf); if (zr[i].fd > mx) mx = zr[i].fd; }
        struct timeval tv = {0, 50000};
        int r = select(mx + 1, &rf, NULL, NULL, &tv);
        long t = now_ms();
        if (r <= 0) goto silence_check;

        if (FD_ISSET(rs, &rf)) {
            int cfd = accept(rs, NULL, NULL);
            if (cfd >= 0) rest_handle(cfd);      /* bounded: 2s rcv timeout, then back to RTP */
        }

        for (int i = 0; i < NZONES; i++) {
            if (zr[i].fd < 0 || !FD_ISSET(zr[i].fd, &rf)) continue;
            ssize_t n = recv(zr[i].fd, buf, sizeof(buf), 0);
            if (n < 12) continue;
            if (!zr[i].active) zr[i].first_active = t;
            zr[i].last = t; zr[i].active = 1;

            /* winner: keep cur unless a STRICTLY higher priority zone is active
             * (same-priority = first-come-first-served, spec §一). */
            int win = (cur >= 0 && zr[cur].active) ? cur : -1;
            for (int j = 0; j < NZONES; j++) {
                if (!zr[j].active || zr[j].fd < 0) continue;
                if (win < 0 || zd[j].prio < zd[win].prio ||
                    (zd[j].prio == zd[win].prio && zr[j].first_active < zr[win].first_active))
                    win = j;
            }

            if (i == win) {
                int marker = (cur != win) ? 1 : 0;
                int pt = buf[1] & 0x7f;                  /* PT pass-through (P4) */
                buf[0] = 0x80;
                buf[1] = (unsigned char)(pt | (marker ? 0x80 : 0));
                buf[2] = (out_seq >> 8) & 0xff; buf[3] = out_seq & 0xff;
                buf[4] = (out_ts >> 24) & 0xff; buf[5] = (out_ts >> 16) & 0xff;
                buf[6] = (out_ts >> 8) & 0xff;  buf[7] = out_ts & 0xff;
                buf[8] = (out_ssrc >> 24) & 0xff; buf[9] = (out_ssrc >> 16) & 0xff;
                buf[10] = (out_ssrc >> 8) & 0xff; buf[11] = out_ssrc & 0xff;
                sendto(tx, buf, (size_t)n, 0, (struct sockaddr *)&da, sizeof(da));
                out_seq++; out_ts += 160;                /* 20ms @ 8kHz RTP clock */
                if (cur != win) {
                    fprintf(stderr, "[%ld] SWITCH -> zone%d (%s:%d prio %d)\n",
                            t, win + 1, zd[win].addr, zd[win].port, zd[win].prio);
                    cur = win;
                }
            }
        }

silence_check:
        for (int i = 0; i < NZONES; i++) {
            if (zr[i].active && (t - zr[i].last) > silence) {
                zr[i].active = 0;
                if (i == cur) { fprintf(stderr, "[%ld] zone%d SILENT -> release\n", t, i + 1); cur = -1; }
            }
        }
    }
    return 0;
}

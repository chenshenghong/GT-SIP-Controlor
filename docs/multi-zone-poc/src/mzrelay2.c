/* mzrelay2 — GT-SIP-GW multi-zone PoC side-car (P2: priority arbitration + RTP rewrite).
 *
 * Listens on N zone ports (each = one multicast zone; PoC uses unicast ports so a
 * cross-subnet mac can drive them). Forwards ONLY the highest-priority active zone
 * to termapp's group, single stream, no mixing. Higher priority preempts instantly;
 * when the winner goes RTP-silent for `silence_ms`, playback falls back to the next
 * active lower-priority zone. Outgoing RTP header is rewritten (fixed SSRC, monotonic
 * seq, continuous timestamp, marker bit on switch) so termapp sees one seamless flow.
 *
 * usage: mzrelay2 <dst_grp> <dst_port> <ttl> <ifaddr> <silence_ms> \
 *                 <zoneN_port> <zoneN_prio> [<zone_port> <zone_prio> ...]
 *   priority: smaller = higher. Build: static armv7 (see mzrelay.c).
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <time.h>
#include <arpa/inet.h>
#include <sys/socket.h>
#include <sys/select.h>
#include <netinet/in.h>

#define MAXZ 16

static long now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1000L + ts.tv_nsec / 1000000L;
}

int main(int argc, char **argv) {
    if (argc < 8 || (argc % 2) != 0) {
        fprintf(stderr, "usage: %s <dst_grp> <dst_port> <ttl> <ifaddr> <silence_ms> "
                        "<zone_port> <zone_prio> [<zone_port> <zone_prio> ...]\n", argv[0]);
        return 2;
    }
    const char *dst_grp = argv[1];
    int   dst_port = atoi(argv[2]);
    int   ttl      = atoi(argv[3]);
    const char *ifaddr = argv[4];
    long  silence  = atol(argv[5]);

    struct zone { int fd; int port; int prio; long last; int active; } z[MAXZ];
    int nz = 0;
    for (int i = 6; i + 1 < argc && nz < MAXZ; i += 2) {
        z[nz].port = atoi(argv[i]);
        z[nz].prio = atoi(argv[i + 1]);
        z[nz].last = 0; z[nz].active = 0;
        int fd = socket(AF_INET, SOCK_DGRAM, 0);
        int one = 1;
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
        struct sockaddr_in a;
        memset(&a, 0, sizeof(a));
        a.sin_family = AF_INET;
        a.sin_addr.s_addr = htonl(INADDR_ANY);
        a.sin_port = htons(z[nz].port);
        if (bind(fd, (struct sockaddr *)&a, sizeof(a)) < 0) { perror("bind zone"); return 1; }
        z[nz].fd = fd;
        fprintf(stderr, "  zone%d: port %d prio %d\n", nz, z[nz].port, z[nz].prio);
        nz++;
    }

    int tx = socket(AF_INET, SOCK_DGRAM, 0);
    unsigned char cttl = (unsigned char)ttl;
    setsockopt(tx, IPPROTO_IP, IP_MULTICAST_TTL, &cttl, sizeof(cttl));
    struct in_addr ifa; ifa.s_addr = inet_addr(ifaddr);
    setsockopt(tx, IPPROTO_IP, IP_MULTICAST_IF, &ifa, sizeof(ifa));
    unsigned char loop = 1;
    setsockopt(tx, IPPROTO_IP, IP_MULTICAST_LOOP, &loop, sizeof(loop));
    struct sockaddr_in da;
    memset(&da, 0, sizeof(da));
    da.sin_family = AF_INET;
    da.sin_addr.s_addr = inet_addr(dst_grp);
    da.sin_port = htons(dst_port);

    unsigned int   out_ssrc = 0x5A5A0001;
    unsigned short out_seq  = 0;
    unsigned int   out_ts   = 0;
    int cur = -1;

    fprintf(stderr, "mzrelay2: %d zones -> %s:%d silence=%ldms\n", nz, dst_grp, dst_port, silence);

    unsigned char buf[2048];
    for (;;) {
        fd_set rf; FD_ZERO(&rf); int mx = 0;
        for (int i = 0; i < nz; i++) { FD_SET(z[i].fd, &rf); if (z[i].fd > mx) mx = z[i].fd; }
        struct timeval tv = {0, 50000};       /* 50ms tick for silence check */
        int r = select(mx + 1, &rf, NULL, NULL, &tv);
        long t = now_ms();

        if (r > 0) {
            for (int i = 0; i < nz; i++) {
                if (!FD_ISSET(z[i].fd, &rf)) continue;
                ssize_t n = recv(z[i].fd, buf, sizeof(buf), 0);
                if (n < 12) continue;
                z[i].last = t; z[i].active = 1;

                int win = -1;
                for (int j = 0; j < nz; j++)
                    if (z[j].active && (win < 0 || z[j].prio < z[win].prio)) win = j;

                if (i == win) {
                    int marker = (cur != win) ? 1 : 0;   /* talkspurt start on switch */
                    int pt = buf[1] & 0x7f;              /* P4: pass through zone's codec PT */
                    buf[0] = 0x80;
                    buf[1] = (unsigned char)(pt | (marker ? 0x80 : 0));
                    buf[2] = (out_seq >> 8) & 0xff; buf[3] = out_seq & 0xff;
                    buf[4] = (out_ts >> 24) & 0xff; buf[5] = (out_ts >> 16) & 0xff;
                    buf[6] = (out_ts >> 8) & 0xff;  buf[7] = out_ts & 0xff;
                    buf[8] = (out_ssrc >> 24) & 0xff; buf[9] = (out_ssrc >> 16) & 0xff;
                    buf[10] = (out_ssrc >> 8) & 0xff; buf[11] = out_ssrc & 0xff;
                    sendto(tx, buf, (size_t)n, 0, (struct sockaddr *)&da, sizeof(da));
                    out_seq++; out_ts += 160;            /* 20ms @ 8kHz RTP clock (G.722 & PCMU) */
                    if (cur != win) {
                        fprintf(stderr, "[%ld] SWITCH -> zone%d (port %d prio %d)\n",
                                t, win, z[win].port, z[win].prio);
                        cur = win;
                    }
                }
                /* not winner -> drop (no mixing) */
            }
        }

        for (int i = 0; i < nz; i++) {
            if (z[i].active && (t - z[i].last) > silence) {
                z[i].active = 0;
                if (i == cur) { fprintf(stderr, "[%ld] zone%d SILENT -> release\n", t, i); cur = -1; }
            }
        }
    }
    return 0;
}

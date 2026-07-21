/* mzrelay — GT-SIP-GW multi-zone PoC side-car (P1 minimal: single-zone passthrough).
 *
 * Joins a "real" multicast group and forwards each UDP datagram (RTP payload
 * byte-for-byte, no rewrite) to a "relay" group that termapp listens on.
 * This proves the side-car can sit transparently in front of termapp's single
 * multicast slot. Arbitration / RTP rewrite come in later PoC phases.
 *
 * usage: mzrelay <src_grp> <src_port> <dst_grp> <dst_port> [ttl] [ifaddr]
 * build (static, portable to uClibc device):
 *   zig cc -target arm-linux-musleabi -march=armv7-a -static -O2 -o mzrelay mzrelay.c
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <arpa/inet.h>
#include <sys/socket.h>
#include <netinet/in.h>

int main(int argc, char **argv) {
    if (argc < 5) {
        fprintf(stderr, "usage: %s <src_grp> <src_port> <dst_grp> <dst_port> [ttl] [ifaddr]\n", argv[0]);
        return 2;
    }
    const char *src_grp = argv[1];
    int         src_port = atoi(argv[2]);
    const char *dst_grp = argv[3];
    int         dst_port = atoi(argv[4]);
    int         ttl     = (argc > 5) ? atoi(argv[5]) : 1;
    const char *ifaddr  = (argc > 6) ? argv[6] : "0.0.0.0";

    /* RX: bind ANY:src_port, join src_grp on ifaddr */
    int rx = socket(AF_INET, SOCK_DGRAM, 0);
    if (rx < 0) { perror("socket rx"); return 1; }
    int one = 1;
    setsockopt(rx, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
    struct sockaddr_in ra;
    memset(&ra, 0, sizeof(ra));
    ra.sin_family = AF_INET;
    ra.sin_addr.s_addr = htonl(INADDR_ANY);
    ra.sin_port = htons(src_port);
    if (bind(rx, (struct sockaddr *)&ra, sizeof(ra)) < 0) { perror("bind rx"); return 1; }
    /* join only if src is a multicast group (first octet 224..239);
     * a unicast/0.0.0.0 src means "just receive whatever lands on src_port". */
    struct in_addr sa;
    sa.s_addr = inet_addr(src_grp);
    unsigned char fb = (unsigned char)((ntohl(sa.s_addr) >> 24) & 0xff);
    if (fb >= 224 && fb <= 239) {
        struct ip_mreq mreq;
        mreq.imr_multiaddr.s_addr = inet_addr(src_grp);
        mreq.imr_interface.s_addr = inet_addr(ifaddr);
        if (setsockopt(rx, IPPROTO_IP, IP_ADD_MEMBERSHIP, &mreq, sizeof(mreq)) < 0) {
            perror("IP_ADD_MEMBERSHIP src"); return 1;
        }
    } else {
        fprintf(stderr, "src %s is unicast — no IGMP join, receiving on port %d\n", src_grp, src_port);
    }

    /* TX: send to dst_grp:dst_port, loopback ON so local termapp receives */
    int tx = socket(AF_INET, SOCK_DGRAM, 0);
    if (tx < 0) { perror("socket tx"); return 1; }
    unsigned char cttl = (unsigned char)ttl;
    setsockopt(tx, IPPROTO_IP, IP_MULTICAST_TTL, &cttl, sizeof(cttl));
    struct in_addr ifa;
    ifa.s_addr = inet_addr(ifaddr);
    setsockopt(tx, IPPROTO_IP, IP_MULTICAST_IF, &ifa, sizeof(ifa));
    unsigned char loop = 1;
    setsockopt(tx, IPPROTO_IP, IP_MULTICAST_LOOP, &loop, sizeof(loop));
    struct sockaddr_in da;
    memset(&da, 0, sizeof(da));
    da.sin_family = AF_INET;
    da.sin_addr.s_addr = inet_addr(dst_grp);
    da.sin_port = htons(dst_port);

    fprintf(stderr, "mzrelay: %s:%d -> %s:%d ttl=%d if=%s\n",
            src_grp, src_port, dst_grp, dst_port, ttl, ifaddr);

    unsigned char buf[2048];
    unsigned long pkts = 0;
    for (;;) {
        ssize_t n = recv(rx, buf, sizeof(buf), 0);
        if (n <= 0) continue;
        if (sendto(tx, buf, (size_t)n, 0, (struct sockaddr *)&da, sizeof(da)) < 0) {
            /* keep relaying even on transient tx errors */
        }
        if ((++pkts % 250) == 0) fprintf(stderr, "relayed %lu pkts\n", pkts);
    }
    return 0;
}

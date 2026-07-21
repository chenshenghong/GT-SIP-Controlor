/* mztone — on-device RTP G.722 sender for multi-zone PoC (zero-loss local source).
 * Reads a raw G.722 bitstream and sends it as 20ms/160-byte RTP frames (50pps, PT9)
 * to a UDP target, looping. Runs ON the device so there is no cross-subnet loss.
 *
 * usage: mztone <g722_file> <dst_ip> <dst_port> [loop:1|0] [dur_sec:0=inf]
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <time.h>
#include <arpa/inet.h>
#include <sys/socket.h>
#include <netinet/in.h>

#define FRAME 160   /* 20ms of G.722 @ 64kbps */

int main(int argc, char **argv) {
    if (argc < 4) { fprintf(stderr, "usage: %s <g722_file> <dst_ip> <dst_port> [loop] [dur_sec]\n", argv[0]); return 2; }
    const char *path = argv[1];
    const char *dip  = argv[2];
    int dport = atoi(argv[3]);
    int loop  = (argc > 4) ? atoi(argv[4]) : 1;
    int dur   = (argc > 5) ? atoi(argv[5]) : 0;

    FILE *f = fopen(path, "rb");
    if (!f) { perror("fopen"); return 1; }
    fseek(f, 0, SEEK_END); long sz = ftell(f); fseek(f, 0, SEEK_SET);
    unsigned char *data = malloc(sz);
    if (fread(data, 1, sz, f) != (size_t)sz) { perror("fread"); return 1; }
    fclose(f);

    int s = socket(AF_INET, SOCK_DGRAM, 0);
    struct sockaddr_in da; memset(&da, 0, sizeof(da));
    da.sin_family = AF_INET; da.sin_addr.s_addr = inet_addr(dip); da.sin_port = htons(dport);

    unsigned char pkt[12 + FRAME];
    unsigned int ssrc = 0x11220000 ^ (unsigned)dport;
    unsigned short seq = 0;
    unsigned int ts = 0;
    pkt[0] = 0x80; pkt[1] = 9;   /* V2, PT9 (G.722) */
    pkt[8]  = (ssrc >> 24) & 0xff; pkt[9]  = (ssrc >> 16) & 0xff;
    pkt[10] = (ssrc >> 8) & 0xff;  pkt[11] = ssrc & 0xff;

    struct timespec t0; clock_gettime(CLOCK_MONOTONIC, &t0);
    fprintf(stderr, "mztone: %s (%ld B) -> %s:%d loop=%d dur=%d\n", path, sz, dip, dport, loop, dur);

    long sent_frames = 0;
    do {
        for (long off = 0; off + FRAME <= sz; off += FRAME) {
            pkt[2] = (seq >> 8) & 0xff; pkt[3] = seq & 0xff;
            pkt[4] = (ts >> 24) & 0xff; pkt[5] = (ts >> 16) & 0xff;
            pkt[6] = (ts >> 8) & 0xff;  pkt[7] = ts & 0xff;
            memcpy(pkt + 12, data + off, FRAME);
            sendto(s, pkt, sizeof(pkt), 0, (struct sockaddr *)&da, sizeof(da));
            seq++; ts += FRAME; sent_frames++;
            /* pace to 20ms using absolute clock to avoid drift */
            struct timespec tw;
            tw.tv_sec = t0.tv_sec; tw.tv_nsec = t0.tv_nsec + (long)(sent_frames * 20000000L % 1000000000L);
            tw.tv_sec += (sent_frames * 20000000L) / 1000000000L;
            if (tw.tv_nsec >= 1000000000L) { tw.tv_sec += tw.tv_nsec / 1000000000L; tw.tv_nsec %= 1000000000L; }
            clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &tw, NULL);
            if (dur > 0) {
                struct timespec nowt; clock_gettime(CLOCK_MONOTONIC, &nowt);
                if (nowt.tv_sec - t0.tv_sec >= dur) { fprintf(stderr, "mztone done (%ld frames)\n", sent_frames); return 0; }
            }
        }
    } while (loop);
    fprintf(stderr, "mztone done (%ld frames)\n", sent_frames);
    return 0;
}

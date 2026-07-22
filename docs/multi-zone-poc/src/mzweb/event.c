#include <poll.h>
#include <stddef.h>
#include <time.h>
#include "event.h"

#define EV_MAX_FDS 16
#define EV_MAX_TIMERS 8

struct ev_fd { int fd; ev_fd_cb cb; void* arg; };
static struct { struct event_loop pub; struct ev_fd fds[EV_MAX_FDS]; int nfds; TIMER_EVENT* timers[EV_MAX_TIMERS]; int ntimers; } s_loop;

unsigned long long clock_time(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (unsigned long long)ts.tv_sec * 1000ULL + ts.tv_nsec / 1000000ULL;
}
struct event_loop* get_main_event_loop(void) { s_loop.pub.mn_now = clock_time(); return &s_loop.pub; }

void event_timer_init(TIMER_EVENT* t, int interval_ms, void (*cb)(struct event_loop*, struct event*, int), void* arg, int oneshot) {
    t->cb = cb; t->arg = arg; t->interval_ms = interval_ms; t->fire_at = 0; t->armed = 0; (void)oneshot;
}
void event_timer_start(struct event_loop* loop, TIMER_EVENT* t) {
    (void)loop;
    t->fire_at = clock_time() + (unsigned long long)t->interval_ms;
    t->armed = 1;
    for (int i = 0; i < s_loop.ntimers; i++) if (s_loop.timers[i] == t) return;
    if (s_loop.ntimers < EV_MAX_TIMERS) s_loop.timers[s_loop.ntimers++] = t;
}
int ev_reg_fd(struct event_loop* loop, int fd, ev_fd_cb cb, void* arg) {
    (void)loop;
    if (s_loop.nfds >= EV_MAX_FDS) return -1;
    s_loop.fds[s_loop.nfds].fd = fd; s_loop.fds[s_loop.nfds].cb = cb; s_loop.fds[s_loop.nfds].arg = arg;
    s_loop.nfds++;
    return 0;
}
void ev_unreg_fd(struct event_loop* loop, int fd) {
    (void)loop;
    for (int i = 0; i < s_loop.nfds; i++)
        if (s_loop.fds[i].fd == fd) { s_loop.fds[i] = s_loop.fds[--s_loop.nfds]; return; }
}
static int ev_fd_is_live(int fd) {
    for (int i = 0; i < s_loop.nfds; i++) if (s_loop.fds[i].fd == fd) return 1;
    return 0;
}
int event_loop_step(struct event_loop* loop, int max_wait_ms) {
    /* snap 與 pfds 必須是同一份 poll 前狀態：先一次拍好，poll 之後 timer cb 就算
     * ev_unreg_fd 重排 s_loop.fds，也不影響這裡已配對好的索引順序 */
    struct pollfd pfds[EV_MAX_FDS];
    struct ev_fd snap[EV_MAX_FDS];
    int ns = s_loop.nfds;
    for (int i = 0; i < ns; i++) {
        snap[i] = s_loop.fds[i];
        pfds[i].fd = s_loop.fds[i].fd; pfds[i].events = POLLIN; pfds[i].revents = 0;
    }
    int n = poll(pfds, ns, max_wait_ms);
    loop->mn_now = clock_time();
    for (int i = 0; i < s_loop.ntimers; i++) {
        TIMER_EVENT* t = s_loop.timers[i];
        if (t->armed && loop->mn_now >= t->fire_at) { t->armed = 0; t->cb(loop, NULL, 0); }
    }
    if (n > 0) {
        for (int i = 0; i < ns; i++)
            if ((pfds[i].revents & (POLLIN | POLLHUP | POLLERR)) && ev_fd_is_live(snap[i].fd))
                snap[i].cb(loop, snap[i].fd, snap[i].arg);
    }
    return n;
}
void event_loop_run(struct event_loop* loop) { for (;;) event_loop_step(loop, 100); }

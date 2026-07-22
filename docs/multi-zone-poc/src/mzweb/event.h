#ifndef MZWEB_EVENT_H
#define MZWEB_EVENT_H

struct event;                                  /* opaque，callback 參數用 */
struct event_loop { unsigned long long mn_now; /* 毫秒，loop 每輪更新 */ };

struct event_loop* get_main_event_loop(void);
void event_loop_run(struct event_loop* loop);  /* 阻塞 */
unsigned long long clock_time(void);           /* CLOCK_MONOTONIC 毫秒 */

typedef struct {
    void (*cb)(struct event_loop*, struct event*, int);
    void* arg;
    int interval_ms;
    unsigned long long fire_at;
    int armed;
} TIMER_EVENT;

void event_timer_init(TIMER_EVENT* t, int interval_ms, void (*cb)(struct event_loop*, struct event*, int), void* arg, int oneshot);
void event_timer_start(struct event_loop* loop, TIMER_EVENT* t);

/* webapi.c 內部消費，非 websetsip.c 介面 */
typedef void (*ev_fd_cb)(struct event_loop*, int fd, void* arg);
int ev_reg_fd(struct event_loop* loop, int fd, ev_fd_cb on_readable, void* arg);
void ev_unreg_fd(struct event_loop* loop, int fd);
int event_loop_step(struct event_loop* loop, int max_wait_ms); /* 跑一輪，測試用 */

#endif

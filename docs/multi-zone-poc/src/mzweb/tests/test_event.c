#include <assert.h>
#include <stdio.h>
#include <unistd.h>
#include "event.h"
static int fired = 0;
static void on_timer(struct event_loop* l, struct event* e, int ev) { (void)l; (void)e; (void)ev; fired = 1; }

/* 回歸測試：event_loop_step 內 fd 快照(snap)必須與 poll 用的 pfds[] 同一份 poll 前
 * 狀態配對；timer callback 若在 poll 之後 ev_unreg_fd 重排 s_loop.fds，不可讓索引
 * 錯位而誤觸發到別的 fd 的 callback（見 P7 mzweb Task4 code review repro）。 */
static int cb_a_count = 0, cb_b_count = 0, cb_c_count = 0;
static int g_fdA_read = -1;
static void on_fd_a(struct event_loop* l, int fd, void* arg) { (void)l; (void)fd; (void)arg; cb_a_count++; }
static void on_fd_b(struct event_loop* l, int fd, void* arg) { (void)l; (void)fd; (void)arg; cb_b_count++; }
static void on_fd_c(struct event_loop* l, int fd, void* arg) { (void)l; (void)fd; (void)arg; cb_c_count++; }
static void on_timer_unreg_a(struct event_loop* l, struct event* e, int ev) {
    (void)e; (void)ev;
    ev_unreg_fd(l, g_fdA_read); /* timer 到期時 unreg 掉「已就緒」的 fdA，觸發 swap-delete 重排 s_loop.fds */
}

int main(void) {
    struct event_loop* loop = get_main_event_loop();
    assert(loop == get_main_event_loop());          /* 單例 */
    unsigned long long t0 = clock_time();
    TIMER_EVENT tm;
    event_timer_init(&tm, 50, on_timer, NULL, 1);
    event_timer_start(loop, &tm);
    while (!fired) event_loop_step(loop, 10);
    assert(clock_time() - t0 >= 50);
    assert(loop->mn_now >= t0);                      /* mn_now 有更新 */
    printf("event OK\n");

    /* --- fd 順序錯位回歸測試 --- */
    int fda[2], fdb[2], fdc[2];
    assert(pipe(fda) == 0);
    assert(pipe(fdb) == 0);
    assert(pipe(fdc) == 0);
    assert(write(fda[1], "x", 1) == 1); /* fdA(idx0) 就緒可讀；fdB/fdC 保持不可讀 */
    g_fdA_read = fda[0];
    assert(ev_reg_fd(loop, fda[0], on_fd_a, NULL) == 0);
    assert(ev_reg_fd(loop, fdb[0], on_fd_b, NULL) == 0);
    assert(ev_reg_fd(loop, fdc[0], on_fd_c, NULL) == 0);

    TIMER_EVENT tm2;
    event_timer_init(&tm2, 0, on_timer_unreg_a, NULL, 1); /* interval 0：本輪 poll 後必到期 */
    event_timer_start(loop, &tm2);

    event_loop_step(loop, 50); /* 單輪內：fdA 就緒 -> poll 完 timer 到期 unreg fdA -> 派送 */

    /* fdB/fdC 全程未就緒，不可被誤觸發（若 snap 與 pfds 索引錯位會誤觸發 fdC） */
    assert(cb_b_count == 0);
    assert(cb_c_count == 0);
    /* fdA 已被 timer unreg 掉，即使 pre-poll 快照就緒也不該再回呼（liveness 防護） */
    assert(cb_a_count == 0);

    close(fda[0]); close(fda[1]);
    close(fdb[0]); close(fdb[1]);
    close(fdc[0]); close(fdc[1]);
    printf("event fd-order OK\n");
    return 0;
}

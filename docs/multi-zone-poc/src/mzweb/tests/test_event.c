#include <assert.h>
#include <stdio.h>
#include "event.h"
static int fired = 0;
static void on_timer(struct event_loop* l, struct event* e, int ev) { (void)l; (void)e; (void)ev; fired = 1; }
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
    return 0;
}

#include <assert.h>
#include <stdio.h>
#include "mzio_core.h"

int main(void) {
    struct mzio_sm sm;

    /* 劇本 1：乾淨 press→release→tail 到期 */
    mzio_sm_init(&sm, 30, 300, 0);
    assert(mzio_sm_sample(&sm, 0, 1000) == MZIO_ACT_NONE);      /* 候選開始，未達去抖窗 */
    assert(mzio_sm_sample(&sm, 0, 1031) == MZIO_ACT_START_TX);  /* 30ms 穩定 → press */
    assert(sm.tx_on == 1);
    assert(mzio_sm_sample(&sm, 1, 2000) == MZIO_ACT_NONE);      /* release 候選 */
    assert(mzio_sm_sample(&sm, 1, 2031) == MZIO_ACT_NONE);      /* release 確立 → tail 起算，尚不停止 */
    assert(mzio_sm_next_deadline(&sm) == 2031 + 300);
    assert(mzio_sm_tick(&sm, 2200) == MZIO_ACT_NONE);           /* tail 未到 */
    assert(mzio_sm_tick(&sm, 2331) == MZIO_ACT_STOP_TX);        /* tail 到期 */
    assert(sm.tx_on == 0 && mzio_sm_next_deadline(&sm) == -1);

    /* 劇本 2：彈跳（<30ms 抖動）不觸發 */
    mzio_sm_init(&sm, 30, 300, 0);
    assert(mzio_sm_sample(&sm, 0, 100) == MZIO_ACT_NONE);
    assert(mzio_sm_sample(&sm, 1, 110) == MZIO_ACT_NONE);       /* 10ms 就彈回 → 候選作廢 */
    assert(mzio_sm_sample(&sm, 0, 115) == MZIO_ACT_NONE);
    assert(mzio_sm_sample(&sm, 1, 120) == MZIO_ACT_NONE);
    assert(mzio_sm_tick(&sm, 1000) == MZIO_ACT_NONE);           /* 始終無動作 */
    assert(sm.tx_on == 0);

    /* 劇本 3：tail 內重按 → 取消停止、不重送 START */
    mzio_sm_init(&sm, 30, 300, 0);
    mzio_sm_sample(&sm, 0, 1000); mzio_sm_sample(&sm, 0, 1031); /* press */
    mzio_sm_sample(&sm, 1, 2000); mzio_sm_sample(&sm, 1, 2031); /* release, tail@2331 */
    assert(mzio_sm_sample(&sm, 0, 2100) == MZIO_ACT_NONE);      /* 重按候選 */
    assert(mzio_sm_sample(&sm, 0, 2131) == MZIO_ACT_NONE);      /* press 確立：tx 已 on → 不重送 */
    assert(sm.tx_on == 1 && sm.tail_deadline == 0);             /* tail 取消 */
    assert(mzio_sm_tick(&sm, 3000) == MZIO_ACT_NONE);           /* 舊 deadline 不追殺 */

    /* 劇本 4：NC 反轉（invert=1）：raw 1（斷開）＝pressed */
    mzio_sm_init(&sm, 30, 300, 1);
    assert(mzio_sm_sample(&sm, 1, 100) == MZIO_ACT_NONE);
    assert(mzio_sm_sample(&sm, 1, 131) == MZIO_ACT_START_TX);

    /* 劇本 5：tail=0 → release 確立即停 */
    mzio_sm_init(&sm, 30, 0, 0);
    mzio_sm_sample(&sm, 0, 100); mzio_sm_sample(&sm, 0, 131);
    mzio_sm_sample(&sm, 1, 500);
    assert(mzio_sm_sample(&sm, 1, 531) == MZIO_ACT_STOP_TX);

    printf("test_mzio_core: ALL PASS\n");
    return 0;
}

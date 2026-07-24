#include "mzio_core.h"
#include <string.h>

void mzio_sm_init(struct mzio_sm* sm, int debounce_ms, int tail_ms, int invert)
{
    sm->debounce_ms = debounce_ms;
    sm->tail_ms = tail_ms;
    sm->invert = invert;
    sm->stable_pressed = 0;
    sm->cand_pressed = 0;
    sm->cand_since = 0;
    sm->tail_deadline = 0;
    sm->tx_on = 0;
}

/* 穩定狀態確立後的動作決策 */
static enum mzio_act on_stable_change(struct mzio_sm* sm, int pressed, long long now_ms)
{
    sm->stable_pressed = pressed;
    if (pressed)
    {
        sm->tail_deadline = 0;              /* tail 中重按：取消停止 */
        if (!sm->tx_on) { sm->tx_on = 1; return MZIO_ACT_START_TX; }
        return MZIO_ACT_NONE;               /* 已在發送（tail 取消情形）：不重送 */
    }
    /* release */
    if (sm->tx_on)
    {
        if (sm->tail_ms <= 0) { sm->tx_on = 0; return MZIO_ACT_STOP_TX; }
        sm->tail_deadline = now_ms + sm->tail_ms;
    }
    return MZIO_ACT_NONE;
}

enum mzio_act mzio_sm_sample(struct mzio_sm* sm, int raw, long long now_ms)
{
    int pressed = (raw == 0) ? 1 : 0;       /* 本板 active-low：短接 raw=0 */
    if (sm->invert) pressed = !pressed;

    if (pressed == sm->stable_pressed)      /* 回到穩定值：候選作廢 */
    {
        sm->cand_since = 0;
        return mzio_sm_tick(sm, now_ms);
    }
    if (sm->cand_since == 0 || sm->cand_pressed != pressed)
    {
        sm->cand_pressed = pressed;         /* 新候選（或候選值翻轉：重新起算） */
        sm->cand_since = now_ms;
        return mzio_sm_tick(sm, now_ms);
    }
    if (now_ms - sm->cand_since >= sm->debounce_ms)
    {
        sm->cand_since = 0;
        return on_stable_change(sm, pressed, now_ms);
    }
    return mzio_sm_tick(sm, now_ms);
}

enum mzio_act mzio_sm_tick(struct mzio_sm* sm, long long now_ms)
{
    if (sm->tail_deadline != 0 && now_ms >= sm->tail_deadline)
    {
        sm->tail_deadline = 0;
        if (sm->tx_on) { sm->tx_on = 0; return MZIO_ACT_STOP_TX; }
    }
    return MZIO_ACT_NONE;
}

long long mzio_sm_next_deadline(const struct mzio_sm* sm)
{
    long long dl = -1;
    if (sm->tail_deadline != 0) dl = sm->tail_deadline;
    if (sm->cand_since != 0)
    {
        long long c = sm->cand_since + sm->debounce_ms;
        if (dl < 0 || c < dl) dl = c;
    }
    return dl;
}

int mzio_tx_equals_rx(const char* rx_addr, const char* rx_port, const char* tx_addr, const char* tx_port)
{
    if (rx_addr == NULL || rx_port == NULL || tx_addr == NULL || tx_port == NULL) return 0;
    if (strcmp(rx_addr, tx_addr) != 0) return 0;
    if (strcmp(rx_port, tx_port) != 0) return 0;
    return 1;
}

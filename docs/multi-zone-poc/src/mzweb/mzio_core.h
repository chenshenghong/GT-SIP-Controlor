/* mzio_core.h — 單腳 PTT 狀態機：raw 取樣→去抖→press/release→tail timer→動作。
 * 無 I/O、無時鐘（now_ms 由 caller 餵入）→ host 可完整單元測試。 */
#ifndef MZIO_CORE_H
#define MZIO_CORE_H

enum mzio_act { MZIO_ACT_NONE = 0, MZIO_ACT_START_TX = 1, MZIO_ACT_STOP_TX = 2 };

struct mzio_sm {
    /* 配置（init 時填） */
    int debounce_ms;
    int tail_ms;
    int invert;          /* contact NC=1（極性反轉）；NO=0。
                          * 本板 raw: 短接=0（active-low 上拉）；logical pressed =
                          * (raw==0) ^ invert */
    /* 內部狀態 */
    int stable_pressed;  /* 去抖後穩定邏輯狀態；init=0（released） */
    int cand_pressed;    /* 去抖窗候選 */
    long long cand_since;/* 候選起始 ms；0=無候選 */
    long long tail_deadline; /* release 後停止 TX 的期限 ms；0=無 */
    int tx_on;
};

void mzio_sm_init(struct mzio_sm* sm, int debounce_ms, int tail_ms, int invert);
/* 餵一筆 raw 取樣（0/1）＋當下時間 → 應執行的動作 */
enum mzio_act mzio_sm_sample(struct mzio_sm* sm, int raw, long long now_ms);
/* 純時間推進（poll timeout 醒來）→ 應執行的動作（tail 到期） */
enum mzio_act mzio_sm_tick(struct mzio_sm* sm, long long now_ms);
/* 下一個需要喚醒的 deadline（ms 絕對時間；-1=無，可無限等） */
long long mzio_sm_next_deadline(const struct mzio_sm* sm);
#endif

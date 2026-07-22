#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include "readtemp.h"

/* readtemp 相容層單元測試：驗證 millidegree→degree 換算與讀不到感測器的 0 回退。
 * 用 MZWEB_THERMAL_PATH 注入固定輸入（production 不設此變數）。 */
int main(void) {
    /* 1) 正常：毫攝氏 42123 → 42 攝氏（整數截斷）。 */
    FILE* f = fopen("/tmp/rt_temp", "w");
    assert(f);
    fprintf(f, "42123\n");
    fclose(f);
    setenv("MZWEB_THERMAL_PATH", "/tmp/rt_temp", 1);
    assert(get_local_temp() == 42);

    /* 2) 邊界：0 毫攝氏 → 0。 */
    f = fopen("/tmp/rt_temp", "w"); assert(f);
    fprintf(f, "0"); fclose(f);
    assert(get_local_temp() == 0);

    /* 3) 感測器不存在 → 靜默回 0（容器/無感測器環境不 crash）。 */
    setenv("MZWEB_THERMAL_PATH", "/tmp/rt_nonexist_zzz", 1);
    assert(get_local_temp() == 0);

    /* 4) 內容非數字 → 回 0。 */
    f = fopen("/tmp/rt_temp", "w"); assert(f);
    fprintf(f, "garbage"); fclose(f);
    setenv("MZWEB_THERMAL_PATH", "/tmp/rt_temp", 1);
    assert(get_local_temp() == 0);

    printf("readtemp OK\n");
    return 0;
}

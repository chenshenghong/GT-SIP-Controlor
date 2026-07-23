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

    /* 5) gk7205v200 T-Sensor 純解碼：.70 真機實測 raw=0x0232(562) → 52°C。 */
    assert(mzweb_tsensor_decode(0x0232) == 52);
    assert(mzweb_tsensor_decode(407) == 19);     /* ~20°C 冷機 */

    /* 6) 解碼護欄：raw=0 或落在不合理攝氏區間 → 0（不 crash、不顯示垃圾值）。 */
    assert(mzweb_tsensor_decode(0) == 0);
    assert(mzweb_tsensor_decode(117) == 0);      /* 公式落到 -40°C → 夾為 0 */

    /* 7) production 路徑（無檔案覆寫時走暫存器）：用 MZWEB_TSENSOR_RAW 注入 raw
     *    供 host 驗證解碼串接，不觸 /dev/mem。務必先清 MZWEB_THERMAL_PATH（優先序在前）。 */
    unsetenv("MZWEB_THERMAL_PATH");
    setenv("MZWEB_TSENSOR_RAW", "0x0232", 1);
    assert(get_local_temp() == 52);
    unsetenv("MZWEB_TSENSOR_RAW");

    printf("readtemp OK\n");
    return 0;
}

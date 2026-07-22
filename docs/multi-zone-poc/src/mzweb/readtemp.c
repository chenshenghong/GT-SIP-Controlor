/* readtemp.c — 自研相容層：設備 SoC 溫度讀取（取代原廠缺失的 readtemp SDK）。
 *
 * 原廠 websetsip.c 的 request_system_info() 呼叫 get_local_temp() 取整數攝氏溫度，
 * 填入 /system/info 的 "temperature" 欄位。真設備由此支感測器；此處以 Linux 標準
 * thermal sysfs 提供等價語意，讀不到（如無感測器的容器）時回 0，維持「數值型欄位、
 * 不致 crash」的行為基準。 */
#include <stdio.h>
#include <stdlib.h>
#include "readtemp.h"

/* thermal_zone0/temp 慣例為毫攝氏（millidegree C）。回傳整數攝氏；失敗回 0。
 * 感測器路徑可用環境變數 MZWEB_THERMAL_PATH 覆寫（僅供單元測試注入固定輸入；
 * production 不設此變數 → 走預設 sysfs 路徑，行為與真設備一致）。 */
int get_local_temp(void)
{
    const char* path = getenv("MZWEB_THERMAL_PATH");
    if (!path || !path[0]) path = "/sys/class/thermal/thermal_zone0/temp";
    FILE* f = fopen(path, "r");
    if (!f) return 0;
    long milli = 0;
    int got = fscanf(f, "%ld", &milli);
    fclose(f);
    if (got != 1) return 0;
    return (int)(milli / 1000);
}

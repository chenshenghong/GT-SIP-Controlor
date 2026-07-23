/* readtemp.c — 自研相容層：設備 SoC 溫度讀取（取代原廠缺失的 readtemp SDK）。
 *
 * 原廠 websetsip.c 的 request_system_info() 呼叫 get_local_temp() 取整數攝氏溫度，
 * 填入 /system/info 的 "temperature" 欄位。
 *
 * .70（Goke GK7205V200 / HiSilicon Hi3516EV200 相容 / OHLinux 4.9.37）無 Linux 標準
 * thermal sysfs（/sys/class/thermal/ 不存在）→ 舊版讀檔法恆回 0。改讀 SoC 內建 T-Sensor
 * 暫存器（/dev/mem mmap）。位址與公式經 .70 真機實測：
 *   himm/devmem 0x120280B4 = 0xC3200000（enable T-Sensor）；
 *   讀 0x120280BC 低 10 bit = raw；temp(°C) = (raw-117)/798*165 - 40；
 *   raw=0x0232(562) → 52°C（三次讀取穩定）。
 * 公式來源：OpenIPC wiki（Hi3516EV200/EV300 同係 T-Sensor）。
 *
 * 讀不到（無 /dev/mem、mmap 失敗、值不合理）一律靜默回 0，維持「數值型欄位、不 crash、
 * 不顯示垃圾值」的行為契約。 */
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/mman.h>
#include "readtemp.h"

#define TSENSOR_BASE     0x12028000u   /* T-Sensor 暫存器頁基址 */
#define TSENSOR_CTRL     0x000000B4u   /* 控制暫存器偏移：寫 enable 值 */
#define TSENSOR_DATA     0x000000BCu   /* 資料暫存器偏移：讀 raw（低 10 bit）*/
#define TSENSOR_ENABLE   0xC3200000u   /* 致能 T-Sensor */
#define TSENSOR_RAW_MASK 0x3FFu        /* 10-bit 感測器 */

/* raw→攝氏 純函式：可單元測試、不觸硬體（見 readtemp.h 契約）。 */
int mzweb_tsensor_decode(unsigned int raw)
{
    raw &= TSENSOR_RAW_MASK;
    if (raw == 0) return 0;                       /* 未就緒 / 無讀值 */
    long t = (((long)raw - 117) * 165) / 798 - 40;
    if (t < 0 || t > 150) return 0;               /* 不合理 → 0（不顯示垃圾值）*/
    return (int)t;
}

/* 讀 gk7205v200 T-Sensor 暫存器；失敗（無 /dev/mem、mmap 失敗）靜默回 0。 */
static int read_tsensor_reg(void)
{
    int fd = open("/dev/mem", O_RDWR | O_SYNC);
    if (fd < 0) return 0;

    long ps = sysconf(_SC_PAGESIZE);
    if (ps <= 0) ps = 4096;
    off_t page = (off_t)TSENSOR_BASE & ~((off_t)ps - 1);
    off_t poff = (off_t)TSENSOR_BASE - page;
    size_t span = (size_t)poff + 0x100;

    volatile unsigned char* map = (volatile unsigned char*)
        mmap(NULL, span, PROT_READ | PROT_WRITE, MAP_SHARED, fd, page);
    if (map == MAP_FAILED) { close(fd); return 0; }

    volatile uint32_t* ctrl = (volatile uint32_t*)(map + poff + TSENSOR_CTRL);
    volatile uint32_t* data = (volatile uint32_t*)(map + poff + TSENSOR_DATA);

    *ctrl = TSENSOR_ENABLE;
    usleep(50000);                                /* 致能後短暫沉降（真機 200ms 內穩定）*/
    unsigned int raw = (unsigned int)(*data);

    munmap((void*)map, span);
    close(fd);
    return mzweb_tsensor_decode(raw);
}

int get_local_temp(void)
{
    /* 檔案覆寫（毫攝氏）：僅供單元測試/舊行為注入固定輸入；production 不設此變數。 */
    const char* path = getenv("MZWEB_THERMAL_PATH");
    if (path && path[0]) {
        FILE* f = fopen(path, "r");
        if (!f) return 0;
        long milli = 0;
        int got = fscanf(f, "%ld", &milli);
        fclose(f);
        return (got == 1) ? (int)(milli / 1000) : 0;
    }

    /* raw 注入覆寫：供 host 測試驗證暫存器解碼路徑（不觸 /dev/mem）；production 不設。 */
    const char* rawenv = getenv("MZWEB_TSENSOR_RAW");
    if (rawenv && rawenv[0]) {
        return mzweb_tsensor_decode((unsigned int)strtoul(rawenv, NULL, 0));
    }

    /* production：讀 gk7205v200 T-Sensor 暫存器。 */
    return read_tsensor_reg();
}

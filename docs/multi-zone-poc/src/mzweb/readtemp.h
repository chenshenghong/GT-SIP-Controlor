#ifndef MZWEB_READTEMP_H
#define MZWEB_READTEMP_H
/* 自研相容層：取代原廠缺失的 readtemp.h（設備溫度讀取 SDK）。
 * 原廠 websetsip.c:2332 `int temperature = get_local_temp();`，值填入
 * /system/info 回應的 "temperature": %d 欄位。回傳攝氏整數；讀不到感測器回 0。 */
int get_local_temp(void);

/* gk7205v200（HiSilicon Hi3516EV200 相容）T-Sensor raw→攝氏 純函式：可單元測試、不觸硬體。
 * 公式 temp = (raw-117)/798*165 - 40（來源 OpenIPC；.70 真機實測 raw=0x0232 → 52°C 驗證）。
 * 取 raw 低 10 bit；<0 或 >150°C（不合理）回 0，維持「數值型欄位、不顯示垃圾值」契約。 */
int mzweb_tsensor_decode(unsigned int raw);
#endif

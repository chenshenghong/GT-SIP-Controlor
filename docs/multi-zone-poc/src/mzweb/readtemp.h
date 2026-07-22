#ifndef MZWEB_READTEMP_H
#define MZWEB_READTEMP_H
/* 自研相容層：取代原廠缺失的 readtemp.h（設備溫度讀取 SDK）。
 * 原廠 websetsip.c:2332 `int temperature = get_local_temp();`，值填入
 * /system/info 回應的 "temperature": %d 欄位。回傳攝氏整數；讀不到感測器回 0。 */
int get_local_temp(void);
#endif

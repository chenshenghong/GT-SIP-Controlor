#ifndef MZWEB_CJSON_COMPAT_H
#define MZWEB_CJSON_COMPAT_H
#include "cjson_vendor.h"
/* 原廠 SDK 的 cJSON_Parse 是 (content, content_len) 長度版；
 * upstream 同名函式是單參數版 → 以 function-like macro 攔截兩參數呼叫點導向 cJSON_ParseWithLength。 */
#define cJSON_Parse(content, content_len) cJSON_ParseWithLength((content), (size_t)(content_len))
#endif

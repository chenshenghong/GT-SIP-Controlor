#ifndef MZWEB_ZONES_H
#define MZWEB_ZONES_H
/* P7: zones 路由轉呼 mzrelay3 loopback REST。token 驗證在 websetsip.c patch
 * 內的 mzweb_check_token；本模組只負責轉呼與回覆（成敗）。 */
void mzweb_forward_zones(void* client, int is_set, const char* content, int content_len);
#endif

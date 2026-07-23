#ifndef MZWEB_TXIO_H
#define MZWEB_TXIO_H
/* mzweb 補 TX + IO 路由（spec: docs/superpowers/specs/2026-07-23-mzweb-tx-io-design.md）。
 * token 驗證在 websetsip.c 的 mzweb_check_token（txio_inject.py 掛的 dispatch 內）；
 * 本模組只在 token 驗過後被呼叫。回應 GBK、驗證失敗 HTTP 200 + E001（同原廠語意）。 */
#include "cjson.h"
struct key_value_file;

/* --- HTTP handlers（websetsip.c dispatch 注入點呼叫） --- */
void mzweb_txio_set_tx(void* client, const char* content, int content_len);
void mzweb_txio_get_io(void* client);
void mzweb_txio_set_io(void* client, const char* content, int content_len);

/* --- GET 擴充 helpers（request_get_sip_config / request_get_device_status 注入點呼叫；
 *     kv = 該 handler 已開啟的 /etc/ifcfg-sip key_value_file，本函式不 free） --- */
void mzweb_txio_add_tx_config(cJSON* root, struct key_value_file* kv);
void mzweb_txio_add_tx_status(cJSON* sip_status, struct key_value_file* kv);

/* --- 純驗證（單元測試涵蓋） --- */
int mztxio_valid_mcast_addr(const char* ip);
int mztxio_valid_port(int port);
int mztxio_validate_io_config(cJSON* io_config_arr, const char** err_msg);
#endif

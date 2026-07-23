/* mzweb_txio.c — TX + IO 路由（spec 2026-07-23）。token 已由 dispatch 驗過。 */
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include "cjson.h"
#include "keyvaluefile.h"
#include "webapi.h"
#include "mzsdk.h"
#include "mzweb_txio.h"

#ifndef MZTXIO_IFCFG
#define MZTXIO_IFCFG "/etc/ifcfg-sip"
#endif
#ifndef MZIO_JSON
#define MZIO_JSON "/opt/mzio.json"
#endif
#ifndef MZIO_STATE
#define MZIO_STATE "/tmp/mzio_state"
#endif
#ifndef MZIO_PIDFILE
#define MZIO_PIDFILE "/var/run/mzio.pid"
#endif

/* --- GBK 訊息常數（原文↔bytes 見 plan GBK 常數表；\xNN 後接 ASCII 字母數字須拆字串） --- */
#define MZTXIO_MSG_BAD_ADDR   "\xb7\xc7\xb7\xa8\xd7\xe9\xb2\xa5\xb5\xd8\xd6\xb7"          /* 非法组播地址 */
#define MZTXIO_MSG_BAD_PORT   "\xb7\xc7\xb7\xa8\xd7\xe9\xb2\xa5\xb6\xcb\xbf\xda"          /* 非法组播端口 */
#define MZTXIO_MSG_BAD_CODEC  "\xb7\xc7\xb7\xa8\xd2\xf4\xc6\xb5\xb1\xe0\xc2\xeb"          /* 非法音频编码 */
#define MZTXIO_MSG_LOOPBACK   "\xb7\xa2\xcb\xcd\xb5\xd8\xd6\xb7\xd3\xeb\xbd\xd3\xca\xd5\xb5\xd8\xd6\xb7\xcf\xe0\xcd\xac" /* 发送地址与接收地址相同 */
#define MZTXIO_MSG_OK         "\xb2\xd9\xd7\xf7\xb3\xc9\xb9\xa6"                          /* 操作成功 */
#define MZTXIO_MSG_FAIL       "\xb2\xd9\xd7\xf7\xca\xa7\xb0\xdc"                          /* 操作失败 */
#define MZTXIO_MSG_EMPTY      "JSON" "\xd7\xd6\xb7\xfb\xb4\xae\xce\xaa\xbf\xd5"           /* JSON字符串为空 */
#define MZTXIO_MSG_BADJSON    "JSON" "\xd7\xd6\xb7\xfb\xb4\xae\xb8\xf1\xca\xbd\xb7\xc7\xb7\xa8" /* JSON字符串格式非法 */
#define MZTXIO_MSG_MISSKEY    "JSON" "\xd7\xd6\xb7\xfb\xb4\xae\xb4\xe6\xd4\xda\xbc\xfc\xd6\xb5\xc8\xb1\xca\xa7" /* JSON字符串存在键值缺失 */
#define MZTXIO_MSG_BADTYPE    "JSON" "\xd7\xd6\xb7\xfb\xb4\xae\xb4\xe6\xd4\xda\xbc\xfc\xd6\xb5\xc0\xe0\xd0\xcd\xb7\xc7\xd6\xb8\xb6\xa8\xc0\xe0\xd0\xcd" /* JSON字符串存在键值类型非指定类型 */
#define MZTXIO_MSG_BAD_IO     "IO" "\xc5\xe4\xd6\xc3\xb7\xc7\xb7\xa8"                     /* IO配置非法 */
#define MZTXIO_TXSTAT_ON      "\xb7\xa2\xcb\xcd\xd6\xd0"                                  /* 发送中 */
#define MZTXIO_TXSTAT_OFF     "\xb9\xd8\xb1\xd5"                                          /* 关闭 */

/* --- 純驗證 --- */
int mztxio_valid_mcast_addr(const char* ip)
{
    int a = -1, b = -1, c = -1, d = -1;
    if (ip == NULL) return 0;
    if (sscanf(ip, "%d.%d.%d.%d", &a, &b, &c, &d) != 4) return 0;
    if (a < 224 || a > 239) return 0;
    if (b < 0 || b > 255 || c < 0 || c > 255 || d < 0 || d > 255) return 0;
    return 1;
}

int mztxio_valid_port(int port) { return port >= 1 && port <= 65534 ? 1 : 0; }

static const char* s_mode_vals[]    = { "input", "output", "disabled", NULL };
static const char* s_contact_vals[] = { "NO", "NC", NULL };
static const char* s_trigger_vals[] = { "edge", "level", "long_press", NULL };
static const char* s_action_vals[]  = { "multicast_ptt", "call_toggle", "call_preset",
    "hangup", "answer", "sos", "volume_up", "volume_down",
    "call_status", "multicast_status", "remote_control", NULL };

static int in_list(const char* v, const char** list)
{
    int i;
    if (v == NULL) return 0;
    for (i = 0; list[i] != NULL; i++)
        if (strcmp(v, list[i]) == 0) return 1;
    return 0;
}

int mztxio_validate_io_config(cJSON* arr, const char** err_msg)
{
    int seen[7] = {0}; /* id 1..6 */
    cJSON* row;
    *err_msg = MZTXIO_MSG_BAD_IO;
    if (arr == NULL || !cJSON_IsArray(arr)) return 0;
    cJSON_ArrayForEach(row, arr)
    {
        cJSON* id = cJSON_GetObjectItem(row, "id");
        cJSON* mode = cJSON_GetObjectItem(row, "mode");
        cJSON* contact = cJSON_GetObjectItem(row, "contact");
        cJSON* trigger = cJSON_GetObjectItem(row, "trigger");
        cJSON* debounce = cJSON_GetObjectItem(row, "debounce_ms");
        cJSON* action = cJSON_GetObjectItem(row, "action");
        if (id == NULL || mode == NULL || contact == NULL || trigger == NULL ||
            debounce == NULL || action == NULL) { *err_msg = MZTXIO_MSG_MISSKEY; return 0; }
        if (!cJSON_IsNumber(id) || !cJSON_IsString(mode) || !cJSON_IsString(contact) ||
            !cJSON_IsString(trigger) || !cJSON_IsNumber(debounce) || !cJSON_IsObject(action))
            { *err_msg = MZTXIO_MSG_BADTYPE; return 0; }
        if (id->valueint < 1 || id->valueint > 6 || seen[id->valueint]) return 0;
        seen[id->valueint] = 1;
        if (!in_list(cJSON_GetStringValue(mode), s_mode_vals)) return 0;
        if (!in_list(cJSON_GetStringValue(contact), s_contact_vals)) return 0;
        if (!in_list(cJSON_GetStringValue(trigger), s_trigger_vals)) return 0;
        if (debounce->valueint < 0 || debounce->valueint > 200) return 0;
        {
            cJSON* atype = cJSON_GetObjectItem(action, "type");
            cJSON* aparam = cJSON_GetObjectItem(action, "param");
            if (atype == NULL || aparam == NULL) { *err_msg = MZTXIO_MSG_MISSKEY; return 0; }
            if (!cJSON_IsString(atype) || !cJSON_IsString(aparam))
                { *err_msg = MZTXIO_MSG_BADTYPE; return 0; }
            if (!in_list(cJSON_GetStringValue(atype), s_action_vals)) return 0;
        }
    }
    *err_msg = NULL;
    return 1;
}

/* --- 回應組裝（GBK、HTTP 200、Connection: close；照 mzweb_zones/原廠模板） --- */
static void txio_send_json(void* client, const char* http_msg)
{
    size_t mlen = strlen(http_msg);
    size_t cap = mlen + 512;
    char* buffer = (char*)malloc(cap);
    if (buffer == NULL) return; /* 無法回應：webapi 會因未 respond 回 404 */
    int len = snprintf(buffer, cap, "HTTP/1.1 200 OK\r\n"
                       "Server: %s\r\n"
                       "Connection: close\r\n"
                       "Content-Type: application/json;charset=GBK\r\n"
                       "Content-Length: %d\r\n"
                       "Allow: %s\r\n\r\n%s",
                       HBI_WEB_SERVER, (int)mlen, HBI_WEB_METHOD, http_msg);
    web_snd_data(client, buffer, len);
    free(buffer);
}

static void txio_send_error(void* client, const char* code, const char* msg)
{
    char http_msg[512] = {0};
    snprintf(http_msg, sizeof(http_msg),
        "{\"status\": \"error\",\"message\": \"" MZTXIO_MSG_FAIL "\","
        "\"error_code\": \"%s\",  \"details\": \"%s\"}", code, msg);
    txio_send_json(client, http_msg);
}

static void txio_send_success(void* client)
{
    txio_send_json(client,
        "{\"status\": \"success\",\"message\": \"" MZTXIO_MSG_OK "\",\"data\": {}}");
}

/* --- handlers：Task 3（set_tx）/ Task 4（add_tx_*）/ Task 5（get_io/set_io）填實 --- */
void mzweb_txio_set_tx(void* client, const char* content, int content_len)
{
    const char* code = NULL;
    const char* msg = NULL;
    cJSON* root = NULL;
    struct key_value_file* kv = NULL;
    do
    {
        if (content == NULL || content_len == 0)
            { msg = MZTXIO_MSG_EMPTY; code = "E001"; break; }
        root = cJSON_Parse(content, content_len);
        if (root == NULL)
            { msg = MZTXIO_MSG_BADJSON; code = "E001"; break; }

        cJSON* addr = cJSON_GetObjectItem(root, "multicast_address");
        cJSON* port = cJSON_GetObjectItem(root, "multicast_port");
        cJSON* enabled = cJSON_GetObjectItem(root, "enabled");
        cJSON* codec = cJSON_GetObjectItem(root, "audio_codec");
        if (addr == NULL || port == NULL || enabled == NULL || codec == NULL)
            { msg = MZTXIO_MSG_MISSKEY; code = "E001"; break; }
        if (!cJSON_IsString(addr) || !cJSON_IsNumber(port) ||
            !cJSON_IsBool(enabled) || !cJSON_IsString(codec))
            { msg = MZTXIO_MSG_BADTYPE; code = "E001"; break; }

        const char* ip = cJSON_GetStringValue(addr);
        if (!mztxio_valid_mcast_addr(ip))
            { msg = MZTXIO_MSG_BAD_ADDR; code = "E001"; break; }
        if (!mztxio_valid_port(port->valueint))
            { msg = MZTXIO_MSG_BAD_PORT; code = "E001"; break; }
        /* v1 codec 白名單僅 G.722（MTX-05；欄位保留為對稱/擴充） */
        if (strcmp(cJSON_GetStringValue(codec), "G.722") != 0)
            { msg = MZTXIO_MSG_BAD_CODEC; code = "E001"; break; }

        kv = read_keyvalue_file(MZTXIO_IFCFG);
        if (kv == NULL) { msg = MZTXIO_MSG_FAIL; code = "E001"; break; }

        /* MTX-06 迴授防護：TX 目標 == 本機 RX 且要啟動 → 拒絕 */
        if (cJSON_IsTrue(enabled))
        {
            const char* rx_addr = find_key_value(kv, "MULTICAST_ADDRESS");
            const char* rx_port = find_key_value(kv, "MULTICAST_PORT");
            char port_str[16] = {0};
            snprintf(port_str, sizeof(port_str), "%d", port->valueint);
            if (rx_addr != NULL && rx_port != NULL &&
                strcmp(rx_addr, ip) == 0 && strcmp(rx_port, port_str) == 0)
                { msg = MZTXIO_MSG_LOOPBACK; code = "E001"; break; }
        }

        /* save_flag 落盤（照原廠模式）：值有變才寫檔＋通知 */
        int save_flag = 0;
        char port_str[16] = {0};
        snprintf(port_str, sizeof(port_str), "%d", port->valueint);
        const char* en_str = cJSON_IsTrue(enabled) ? "true" : "false";
        const char* pairs[4][2] = {
            { "MULTICAST_TX_ADDRESS", ip },
            { "MULTICAST_TX_PORT",    port_str },
            { "MULTICAST_TX_ENABLED", en_str },
            { "MULTICAST_TX_CODEC",   cJSON_GetStringValue(codec) },
        };
        int i;
        for (i = 0; i < 4; i++)
        {
            const char* cur = find_key_value(kv, pairs[i][0]);
            if (cur == NULL)          { add_key_value(kv, pairs[i][0], pairs[i][1]); save_flag = 1; }
            else if (strcmp(cur, pairs[i][1]) != 0)
                                      { modify_key_value(kv, pairs[i][0], pairs[i][1]); save_flag = 1; }
        }
        if (save_flag)
        {
            write_keyvalue_file(MZTXIO_IFCFG, kv);
            mzsdk_send("{\"command\": \"set_sip_multicast_tx\",\"cseq\": 1}\r\n\r\n");
        }
        break;
    } while (1);

    if (kv != NULL) free_keyvalue_file(kv);
    if (root != NULL) cJSON_Delete(root);
    if (code != NULL) txio_send_error(client, code, msg);
    else              txio_send_success(client);
}
void mzweb_txio_get_io(void* client) { txio_send_success(client); }
void mzweb_txio_set_io(void* client, const char* content, int content_len)
{
    (void)content; (void)content_len;
    txio_send_success(client);
}
void mzweb_txio_add_tx_config(cJSON* root, struct key_value_file* kv)
{
    const char* a = find_key_value(kv, "MULTICAST_TX_ADDRESS");
    const char* p = find_key_value(kv, "MULTICAST_TX_PORT");
    const char* e = find_key_value(kv, "MULTICAST_TX_ENABLED");
    const char* c = find_key_value(kv, "MULTICAST_TX_CODEC");
    cJSON* tx = cJSON_AddObjectToObject(root, "multicast_tx_config");
    cJSON_AddStringToObject(tx, "multicast_address", a == NULL ? "239.0.0.100" : a);
    cJSON_AddRawToObject(tx, "multicast_port", p == NULL ? "9000" : p);
    cJSON_AddRawToObject(tx, "enabled", e == NULL ? "false" : e);
    cJSON_AddStringToObject(tx, "audio_codec", c == NULL ? "G.722" : c);
}

void mzweb_txio_add_tx_status(cJSON* sip_status, struct key_value_file* kv)
{
    const char* a = find_key_value(kv, "MULTICAST_TX_ADDRESS");
    const char* p = find_key_value(kv, "MULTICAST_TX_PORT");
    const char* e = find_key_value(kv, "MULTICAST_TX_ENABLED");
    const char* c = find_key_value(kv, "MULTICAST_TX_CODEC");
    int on = (e != NULL && strncmp(e, "true", 4) == 0);
    char addr_buf[64] = {0};
    snprintf(addr_buf, sizeof(addr_buf), "%s:%s",
             a == NULL ? "239.0.0.100" : a, p == NULL ? "9000" : p);
    cJSON* st = cJSON_AddObjectToObject(sip_status, "multicast_tx_status");
    cJSON_AddStringToObject(st, "status", on ? MZTXIO_TXSTAT_ON : MZTXIO_TXSTAT_OFF);
    cJSON_AddStringToObject(st, "address", addr_buf);
    cJSON_AddStringToObject(st, "audio_codec", c == NULL ? "G.722" : c);
}

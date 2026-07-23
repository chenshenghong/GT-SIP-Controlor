/* tests/test_txio.c — mzweb_txio 純函式單元測試（host x86 musl 靜態跑於 alpine 容器） */
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "cjson.h"
#include "mzweb_txio.h"

/* web_snd_data 由 webapi.c 提供；此測試只練純驗證函式，不拉進整條 webapi/mbedTLS
 * 連結鏈（COMPAT_TEST_txio 刻意精簡）。mzweb_txio.c 的 handler 仍會參照到它（連結期
 * 需要符號），故此處給空殼 stub，practice 上絕不會被呼叫到。 */
void web_snd_data(void* client, const char* buffer, int len) {
    (void)client; (void)buffer; (void)len;
}

static cJSON* parse(const char* s) { return cJSON_Parse(s, (int)strlen(s)); }

static void test_valid_mcast_addr(void) {
    assert(mztxio_valid_mcast_addr("224.0.0.1") == 1);
    assert(mztxio_valid_mcast_addr("239.255.255.255") == 1);
    assert(mztxio_valid_mcast_addr("225.1.1.1") == 1);
    assert(mztxio_valid_mcast_addr("192.168.1.1") == 0);
    assert(mztxio_valid_mcast_addr("240.0.0.1") == 0);
    assert(mztxio_valid_mcast_addr("223.9.9.9") == 0);
    assert(mztxio_valid_mcast_addr("not-an-ip") == 0);
    assert(mztxio_valid_mcast_addr("") == 0);
}

static void test_valid_port(void) {
    assert(mztxio_valid_port(1) == 1);
    assert(mztxio_valid_port(9000) == 1);
    assert(mztxio_valid_port(65534) == 1);
    assert(mztxio_valid_port(0) == 0);
    assert(mztxio_valid_port(65535) == 0);
    assert(mztxio_valid_port(-1) == 0);
}

static void test_validate_io_config(void) {
    const char* err = NULL;
    /* 合法：單列 io1(id2) multicast_ptt */
    cJSON* ok = parse("[{\"id\":2,\"mode\":\"input\",\"contact\":\"NO\","
        "\"trigger\":\"level\",\"debounce_ms\":30,"
        "\"action\":{\"type\":\"multicast_ptt\",\"param\":\"300\"}}]");
    assert(ok != NULL && mztxio_validate_io_config(ok, &err) == 1);
    cJSON_Delete(ok);
    /* id 超界 */
    cJSON* bad_id = parse("[{\"id\":7,\"mode\":\"disabled\",\"contact\":\"NO\","
        "\"trigger\":\"edge\",\"debounce_ms\":30,"
        "\"action\":{\"type\":\"hangup\",\"param\":\"\"}}]");
    assert(mztxio_validate_io_config(bad_id, &err) == 0 && err != NULL);
    cJSON_Delete(bad_id);
    /* id 重複 */
    cJSON* dup = parse("[{\"id\":2,\"mode\":\"disabled\",\"contact\":\"NO\",\"trigger\":\"edge\","
        "\"debounce_ms\":30,\"action\":{\"type\":\"hangup\",\"param\":\"\"}},"
        "{\"id\":2,\"mode\":\"disabled\",\"contact\":\"NO\",\"trigger\":\"edge\","
        "\"debounce_ms\":30,\"action\":{\"type\":\"hangup\",\"param\":\"\"}}]");
    assert(mztxio_validate_io_config(dup, &err) == 0);
    cJSON_Delete(dup);
    /* action.type 不在 11 種白名單 */
    cJSON* bad_act = parse("[{\"id\":2,\"mode\":\"input\",\"contact\":\"NO\",\"trigger\":\"edge\","
        "\"debounce_ms\":30,\"action\":{\"type\":\"reboot\",\"param\":\"\"}}]");
    assert(mztxio_validate_io_config(bad_act, &err) == 0);
    cJSON_Delete(bad_act);
    /* debounce 超界 */
    cJSON* bad_db = parse("[{\"id\":2,\"mode\":\"input\",\"contact\":\"NO\",\"trigger\":\"edge\","
        "\"debounce_ms\":999,\"action\":{\"type\":\"hangup\",\"param\":\"\"}}]");
    assert(mztxio_validate_io_config(bad_db, &err) == 0);
    cJSON_Delete(bad_db);
    /* 非陣列 */
    cJSON* notarr = parse("{\"x\":1}");
    assert(mztxio_validate_io_config(notarr, &err) == 0);
    cJSON_Delete(notarr);
}

int main(void) {
    test_valid_mcast_addr();
    test_valid_port();
    test_validate_io_config();
    printf("test_txio: ALL PASS\n");
    return 0;
}

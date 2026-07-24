# mzweb TX + IO 路由 ＋ mzio daemon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** mzweb 補上 `POST /set/multicast/tx`、兩條 GET 擴充、`GET/POST /get|set/io/config`，並新增 mzio daemon 讓 io1（GPIO5_5/Linux 45）短接→啟動 termapp Mic 組播發送（PTT），真機 .70 驗收。

**Architecture:** 不動 GBK+CRLF 的 `websetsip-p7.patch`——所有新邏輯放新 UTF-8 檔 `mzweb_txio.c`（HTTP handlers）與 `mzio.c`/`mzio_core.c`（daemon），只用 marker 式 ASCII 注入器 `txio_inject.py` 在 `make` 產生 `build/websetsip.c` 後插入 4 個掛點（1 個 include、3 條 dispatch 路由、2 個 GET 擴充呼叫）。TX 執行面完全複用 termapp 既有管線（寫 `MULTICAST_TX_*` + sip.sdk）。

**Tech Stack:** C（arm musl 靜態、Docker muslcc 交叉編譯）、cjson_vendor、keyvaluefile、python3 整合測試（docker python:3.12-alpine，`tests/run_host_tests.sh`）。

**Spec:** `docs/superpowers/specs/2026-07-23-mzweb-tx-io-design.md`（本計畫一切語意以 spec 為準）。

## Global Constraints

- 一切在 `docs/multi-zone-poc/src/mzweb/` 下操作（Makefile 假設 CWD 在此）；mzio 原始碼也放這裡（與 keyvaluefile/cjson 共用）。
- **絕不**用 Edit/Write 工具碰 `websetsip-p7.patch`、`docs/firmware-reference/websetsip.c`（GBK+CRLF 會被毀）。`build/` 為產物目錄，不進版控。
- 回應 JSON 的中文一律 **GBK bytes**，在 UTF-8 原始碼中以 `\xNN` 逸出寫出；每個常數旁註明原文。C 十六進位逸出會貪吃後續 hex 字元——GBK 逸出後若接 ASCII 字母/數字，必須拆成相鄰字串字面值（如 `"\xb7\xc7" "abc"`）。
- 本專案 cJSON 為 vendor 版：**`cJSON_Parse(content, content_len)` 是兩參數**（非上游單參數）。標頭是 `cjson.h`。
- 錯誤碼語意照原廠：驗證失敗一律 HTTP 200 + `{"status":"error",...,"error_code":"E001"}`；token 失敗由 websetsip.c 內 `mzweb_check_token` 回 401 A003/A002（我們的 handler 不碰 token）。
- 建置指令：`make x86-mzweb`（host 測試用）、`make arm-mzweb`、`make arm-mzio`；測試跑 `sh tests/run_host_tests.sh`。
- 每個 task 結尾 commit（訊息附 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`）。
- 真機：`.70`＝192.168.0.70，root/BcastTerm2、SSH port 9521，經 `src/mzctl.py`／`src/mzdeploy.sh`。

**GBK 常數表**（python3 `'字串'.encode('gbk').hex()` 產生；實作時照抄，若自行新增字串須同法產生並驗證）：

| 原文 | GBK hex |
|---|---|
| 非法组播地址 | `b7c7b7a8d7e9b2a5b5d8d6b7` |
| 非法组播端口 | `b7c7b7a8d7e9b2a5b6cbbfda` |
| 非法音频编码 | `b7c7b7a8d2f4c6b5b1e0c2eb` |
| 发送地址与接收地址相同 | `b7a2cbcdb5d8d6b7d3ebbdd3cad5b5d8d6b7cfe0cdac` |
| 操作成功 | `b2d9d7f7b3c9b9a6` |
| 操作失败 | `b2d9d7f7caa7b0dc` |
| JSON字符串为空 | `4a534f4e` + `d7d6b7fbb4aeceaabfd5` |
| JSON字符串格式非法 | `4a534f4e` + `d7d6b7fbb4aeb8f1cabdb7c7b7a8` |
| JSON字符串存在键值缺失 | `4a534f4e` + `d7d6b7fbb4aeb4e6d4dabcfcd6b5c8b1caa7` |
| JSON字符串存在键值类型非指定类型 | `4a534f4e` + `d7d6b7fbb4aeb4e6d4dabcfcd6b5c0e0d0cdb7c7d6b8b6a8c0e0d0cd` |
| IO配置非法 | `494f` + `c5e4d6c3b7c7b7a8` |
| 发送中 | `b7a2cbcdd6d0` |
| 关闭 | `b9d8b1d5` |

---

### Task 1: mzweb_txio 骨架＋mzsdk 共用單元＋純驗證函式（TDD）

**Files:**
- Create: `docs/multi-zone-poc/src/mzweb/mzweb_txio.h`
- Create: `docs/multi-zone-poc/src/mzweb/mzweb_txio.c`
- Create: `docs/multi-zone-poc/src/mzweb/mzsdk.h`
- Create: `docs/multi-zone-poc/src/mzweb/mzsdk.c`
- Create: `docs/multi-zone-poc/src/mzweb/tests/test_txio.c`
- Modify: `docs/multi-zone-poc/src/mzweb/Makefile`（加 `COMPAT_TEST_txio`）

**Interfaces（後續 task 依賴，簽名固定）:**
- Produces:
  - `int mztxio_valid_mcast_addr(const char* ip);`（224–239 首段回 1）
  - `int mztxio_valid_port(int port);`（1–65534 回 1）
  - `int mztxio_validate_io_config(cJSON* io_config_arr, const char** err_msg);`（合法回 1；否則回 0 且 `*err_msg` 指向 GBK 錯誤訊息常數）
  - `int mzsdk_send(const char* cmd);`（連 sip.sdk 送指令，成功 0 失敗 -1；socket 路徑可 `-DMZSDK_PATH="..."` 覆蓋，預設 `/tmp/sip.sdk`）
  - GBK 訊息常數宏 `MZTXIO_MSG_*`（見下）

- [ ] **Step 1: 寫失敗測試** `tests/test_txio.c`：

```c
/* tests/test_txio.c — mzweb_txio 純函式單元測試（host x86 musl 靜態跑於 alpine 容器） */
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "cjson.h"
#include "mzweb_txio.h"

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
```

- [ ] **Step 2: Makefile 加測試連結單元**（在 `COMPAT_TEST_readtemp = readtemp.c` 之後加一行）：

```make
COMPAT_TEST_txio = mzweb_txio.c mzsdk.c cjson_vendor.c keyvaluefile.c
```

- [ ] **Step 3: 跑測試確認編譯失敗**（標頭尚不存在）

Run: `cd docs/multi-zone-poc/src/mzweb && make host-txio`
Expected: FAIL（`mzweb_txio.h: No such file or directory`）

- [ ] **Step 4: 寫 `mzweb_txio.h`**：

```c
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
```

- [ ] **Step 5: 寫 `mzsdk.h`／`mzsdk.c`**（照原廠 `snd_cmd_to_sip_svr` 模式，poll 1s timeout、非阻塞 connect；mzweb_txio 與 mzio 共用）：

```c
#ifndef MZSDK_H
#define MZSDK_H
/* sip.sdk（termapp Unix socket 控制口）指令傳送。成功 0、失敗 -1。
 * 語意照原廠 websetsip.c snd_cmd_to_sip_svr：非阻塞 connect + poll 1s，送出後
 * 等回覆 1s（回覆內容不解析，只當送達確認；>4 bytes 視為成功）。 */
int mzsdk_send(const char* cmd);
#endif
```

```c
/* mzsdk.c */
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/un.h>
#include "mzsdk.h"

#ifndef MZSDK_PATH
#define MZSDK_PATH "/tmp/sip.sdk"
#endif

int mzsdk_send(const char* cmd)
{
    int fd = socket(PF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return -1;
    fcntl(fd, F_SETFL, fcntl(fd, F_GETFL, 0) | O_NONBLOCK);
    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    strncpy(addr.sun_path, MZSDK_PATH, sizeof(addr.sun_path) - 1);
    connect(fd, (struct sockaddr*)&addr, sizeof(addr));

    struct pollfd pfd = { .fd = fd, .events = POLLOUT | POLLERR | POLLNVAL };
    if (poll(&pfd, 1, 1000) <= 0 || !(pfd.revents & POLLOUT)) { close(fd); return -1; }
    int len = (int)strlen(cmd);
    if (send(fd, cmd, len, 0) != len) { close(fd); return -1; }

    struct pollfd rpfd = { .fd = fd, .events = POLLIN | POLLERR | POLLNVAL };
    if (poll(&rpfd, 1, 1000) <= 0 || !(rpfd.revents & POLLIN)) { close(fd); return -1; }
    char reply[128];
    int n = (int)read(fd, reply, sizeof(reply));
    close(fd);
    return n > 4 ? 0 : -1;
}
```

- [ ] **Step 6: 寫 `mzweb_txio.c` 第一版**（GBK 常數＋三個純驗證函式＋handlers/helpers 先放空殼——handlers 本 task 只回 `MZTXIO_MSG_OK` 成功 JSON，Task 3/5 填實）：

```c
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
    (void)content; (void)content_len;
    txio_send_success(client);
}
void mzweb_txio_get_io(void* client) { txio_send_success(client); }
void mzweb_txio_set_io(void* client, const char* content, int content_len)
{
    (void)content; (void)content_len;
    txio_send_success(client);
}
void mzweb_txio_add_tx_config(cJSON* root, struct key_value_file* kv) { (void)root; (void)kv; }
void mzweb_txio_add_tx_status(cJSON* sip_status, struct key_value_file* kv) { (void)sip_status; (void)kv; }
```

- [ ] **Step 7: 跑測試確認通過**

Run: `cd docs/multi-zone-poc/src/mzweb && make host-txio && docker run --rm --platform linux/amd64 -v "$PWD":/src -w /src python:3.12-alpine ./build/test_txio`
Expected: `test_txio: ALL PASS`

- [ ] **Step 8: Commit**

```bash
git add docs/multi-zone-poc/src/mzweb/mzweb_txio.h docs/multi-zone-poc/src/mzweb/mzweb_txio.c docs/multi-zone-poc/src/mzweb/mzsdk.h docs/multi-zone-poc/src/mzweb/mzsdk.c docs/multi-zone-poc/src/mzweb/tests/test_txio.c docs/multi-zone-poc/src/mzweb/Makefile
git commit -m "feat(mzweb-txio): txio 模組骨架＋GBK 常數＋純驗證函式與單元測試（Task 1）"
```

---

### Task 2: 注入器 txio_inject.py＋dispatch 掛 3 路由＋token gate 整合測試

**Files:**
- Create: `docs/multi-zone-poc/src/mzweb/txio_inject.py`
- Create: `docs/multi-zone-poc/src/mzweb/tests/test_txio_routes.py`
- Modify: `docs/multi-zone-poc/src/mzweb/Makefile`（`build/websetsip.c` 規則加注入步驟；`APPSRC` 加 `mzweb_txio.c mzsdk.c`）
- Modify: `docs/multi-zone-poc/src/mzweb/tests/run_host_tests.sh`（掛 `test_txio_routes.py`）

**Interfaces:**
- Consumes: Task 1 的 handler 簽名（stub 即可）。
- Produces: `make build/websetsip.c` 產物含 4 個注入點；路由 `/set/multicast/tx`、`/get/io/config`、`/set/io/config` 過 `mzweb_check_token` 後派發。

- [ ] **Step 1: 寫整合測試** `tests/test_txio_routes.py`（照 `tests/test_zones.py` 的啟動/login 模式——先讀該檔複製其 server 啟動與取 token helper；以下斷言為本測試核心）：

```python
# tests/test_txio_routes.py — 三條新路由存在性 + token gate（跑在 alpine 容器內，由 run_host_tests.sh 驅動）
# 啟動 build/mzweb-x86（複製 test_zones.py 的環境準備：/etc/ifcfg-sip 種子、login 取 token）。
# 斷言：
#  1. 無 token POST /set/multicast/tx → HTTP 401、body 含 "A003"
#  2. 無 token GET  /get/io/config    → HTTP 401、body 含 "A003"
#  3. 無 token POST /set/io/config    → HTTP 401、body 含 "A003"
#  4. 帶有效 token POST /set/multicast/tx（任意 body）→ HTTP 200、body 含 "success"（stub）
#  5. 不存在路由 GET /no/such → 404（dispatch 未破壞既有 fallthrough）
#  6. 既有路由仍活：帶 token GET /get/sip/config → 200（迴歸）
```

- [ ] **Step 2: 寫 `txio_inject.py`**：

```python
#!/usr/bin/env python3
"""txio_inject.py — 對 patch 後的 build/websetsip.c 做 marker 式 ASCII 注入。

為何不擴充 websetsip-p7.patch：該檔 GBK+CRLF，任何以 UTF-8 讀寫的工具都會毀它。
本腳本以 bytes 操作，markers 全 ASCII，冪等（重跑偵測到已注入即 no-op），
marker 找不到或不唯一則非零退出讓 make 失敗（fail loudly）。
"""
import sys

INJECTIONS = [
    # (marker bytes, insert bytes, position: 'after'|'before')
    (b'#include "mzweb_zones.h"\n',
     b'#include "mzweb_txio.h"\n', 'after'),
    # dispatch：插在 "/" index 路由之前（zones 區塊之後）
    (b'\t\t\tif (len == 1 && url[0] == \'/\')\n',
     b'\t\t\tif (len == (int)strlen("/set/multicast/tx") &&\n'
     b'\t\t\t\tstrncmp("/set/multicast/tx", url, len) == 0)\n'
     b'\t\t\t{\n'
     b'\t\t\t\tif (mzweb_check_token(client, http_head) == 0)\n'
     b'\t\t\t\t\tmzweb_txio_set_tx(client, content, content_len);\n'
     b'\t\t\t}\n'
     b'\t\t\telse\n'
     b'\t\t\tif (len == (int)strlen("/get/io/config") &&\n'
     b'\t\t\t\tstrncmp("/get/io/config", url, len) == 0)\n'
     b'\t\t\t{\n'
     b'\t\t\t\tif (mzweb_check_token(client, http_head) == 0)\n'
     b'\t\t\t\t\tmzweb_txio_get_io(client);\n'
     b'\t\t\t}\n'
     b'\t\t\telse\n'
     b'\t\t\tif (len == (int)strlen("/set/io/config") &&\n'
     b'\t\t\t\tstrncmp("/set/io/config", url, len) == 0)\n'
     b'\t\t\t{\n'
     b'\t\t\t\tif (mzweb_check_token(client, http_head) == 0)\n'
     b'\t\t\t\t\tmzweb_txio_set_io(client, content, content_len);\n'
     b'\t\t\t}\n'
     b'\t\t\telse\n', 'before'),
    # GET /get/sip/config 擴充：multicast_config 末欄之後
    (b'\tcJSON_AddStringToObject(multicast_config, "audio_codec", MULTICAST_CODEC==NULL?"":MULTICAST_CODEC);\n',
     b'\tmzweb_txio_add_tx_config(root, keyvalue_file);\n', 'after'),
    # GET /get/device/status 擴充：multicast_status 之後（同層 sip_status）
    (b'\tcJSON_AddRawToObject(sip_status, "multicast_status", backup_line_status);\n',
     b'\tmzweb_txio_add_tx_status(sip_status, keyvalue_sip);\n', 'after'),
]

def main(path):
    with open(path, 'rb') as f:
        data = f.read()
    if b'mzweb_txio.h' in data:
        print('txio_inject: already injected, no-op')
        return 0
    for marker, insert, pos in INJECTIONS:
        # 原廠檔為 CRLF 行尾、patch 增行可能為 LF——逐 marker 嘗試兩種行尾，
        # 用命中的那種行尾改寫 insert，維持該區域行尾一致。
        m_lf, i_lf = marker, insert
        m_crlf = marker.replace(b'\n', b'\r\n')
        i_crlf = insert.replace(b'\n', b'\r\n')
        if data.count(m_lf) == 1 and data.count(m_crlf) == 0:
            m, ins = m_lf, i_lf
        elif data.count(m_crlf) == 1:
            m, ins = m_crlf, i_crlf
        else:
            sys.stderr.write('txio_inject: marker not unique (LF=%d CRLF=%d): %r\n'
                             % (data.count(m_lf), data.count(m_crlf), marker[:60]))
            return 1
        i = data.index(m)
        at = i + len(m) if pos == 'after' else i
        data = data[:at] + ins + data[at:]
    with open(path, 'wb') as f:
        f.write(data)
    print('txio_inject: 4 injections OK')
    return 0

if __name__ == '__main__':
    sys.exit(main(sys.argv[1]))
```

- [ ] **Step 3: Makefile 接線**——`build/websetsip.c` 規則最後加一行注入；`APPSRC` 擴充：

```make
APPSRC   = build/websetsip.c build/main.c mzweb_zones.c serve_index.c mzweb_txio.c mzsdk.c
```

`build/websetsip.c` 規則尾端（`patch ...` 之後）加：

```make
	python3 txio_inject.py build/websetsip.c
```

- [ ] **Step 4: 建置並驗證注入**

Run: `cd docs/multi-zone-poc/src/mzweb && rm -rf build && make x86-mzweb && grep -c mzweb_txio build/websetsip.c`
Expected: 編譯成功；grep 輸出 `6`（1 include + 3 dispatch 呼叫 + 2 helper 呼叫；dispatch 內 handler 名 3 次＋include 1 次＋helpers 2 次）

- [ ] **Step 5: `run_host_tests.sh` 掛新測試**（照 `test_zones.py` 的段落樣式，在其後加同款 if 區塊跑 `tests/test_txio_routes.py`）

- [ ] **Step 6: 跑整合測試**

Run: `cd docs/multi-zone-poc/src/mzweb && sh tests/run_host_tests.sh`
Expected: `ALL HOST TESTS PASSED`（含 test_txio_routes.py 六條斷言）

- [ ] **Step 7: Commit**

```bash
git add docs/multi-zone-poc/src/mzweb/txio_inject.py docs/multi-zone-poc/src/mzweb/tests/test_txio_routes.py docs/multi-zone-poc/src/mzweb/Makefile docs/multi-zone-poc/src/mzweb/tests/run_host_tests.sh
git commit -m "feat(mzweb-txio): marker 注入器掛 3 條路由入 dispatch＋token gate 整合測試（Task 2）"
```

---

### Task 3: `POST /set/multicast/tx` 完整實作（MTX-01/02/06）

**Files:**
- Modify: `docs/multi-zone-poc/src/mzweb/mzweb_txio.c`（填實 `mzweb_txio_set_tx`）
- Create: `docs/multi-zone-poc/src/mzweb/tests/test_txio_settx.py`
- Modify: `docs/multi-zone-poc/src/mzweb/tests/run_host_tests.sh`

**Interfaces:**
- Consumes: `mztxio_valid_mcast_addr`／`mztxio_valid_port`／`mzsdk_send`／`txio_send_error`／`txio_send_success`（Task 1）。
- Produces: `/etc/ifcfg-sip` 內 `MULTICAST_TX_ADDRESS/PORT/ENABLED/CODEC` 4 key；sip.sdk 指令 `{"command": "set_sip_multicast_tx","cseq": 1}\r\n\r\n`。

- [ ] **Step 1: 寫整合測試** `tests/test_txio_settx.py`（沿用 test_txio_routes.py 的啟動/login helper；另起一條 thread 跑 fake sip.sdk unix server 收指令）：

```python
# tests/test_txio_settx.py — /set/multicast/tx 行為（alpine 容器內）
# 前置：/etc/ifcfg-sip 種子含 MULTICAST_ADDRESS=239.0.0.1、MULTICAST_PORT=8000（RX 設定，供迴授防護測項）
# fake sdk：threading 開 unix stream server bind /tmp/sip.sdk，記錄收到的 bytes。
# 斷言（全部帶有效 token）：
#  1. {"multicast_address":"225.1.1.1","multicast_port":9000,"enabled":true,"audio_codec":"G.722"}
#     → 200 success；/etc/ifcfg-sip 出現 MULTICAST_TX_ADDRESS=225.1.1.1、MULTICAST_TX_PORT=9000、
#       MULTICAST_TX_ENABLED=true、MULTICAST_TX_CODEC=G.722；fake sdk 收到 b'set_sip_multicast_tx'
#  2. 同 payload 重送（值未變）→ 200；fake sdk「未」再收到指令（save_flag 語意）
#  3. address "192.168.1.1" → 200 error E001，details GBK bytes == '非法组播地址'.encode('gbk')
#  4. port 0 與 65535 → E001 '非法组播端口'
#  5. audio_codec "OPUS" → E001 '非法音频编码'
#  6. 缺 enabled 欄 → E001 'JSON字符串存在键值缺失'
#  7. enabled 給字串 "true" → E001 'JSON字符串存在键值类型非指定类型'
#  8. 迴授防護：address=239.0.0.1、port=8000（==RX）、enabled=true → E001 '发送地址与接收地址相同'
#  9. 迴授防護例外：同位址但 enabled=false → 200 success（只擋「啟動」）
# 10. body 空 → E001 'JSON字符串为空'
```

- [ ] **Step 2: 跑測試確認失敗**（stub 全回 success，測項 3 起失敗）

Run: `cd docs/multi-zone-poc/src/mzweb && make x86-mzweb && sh tests/run_host_tests.sh`
Expected: `FAIL: tests/test_txio_settx.py`

- [ ] **Step 3: 填實 `mzweb_txio_set_tx`**（取代 Task 1 的 stub；照原廠 `request_set_sip_multicast` 骨架，差異＝TX key 名、codec 白名單、MTX-06、播種）：

```c
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
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd docs/multi-zone-poc/src/mzweb && make x86-mzweb && sh tests/run_host_tests.sh`
Expected: `ALL HOST TESTS PASSED`

- [ ] **Step 5: Commit**

```bash
git add docs/multi-zone-poc/src/mzweb/mzweb_txio.c docs/multi-zone-poc/src/mzweb/tests/test_txio_settx.py docs/multi-zone-poc/src/mzweb/tests/run_host_tests.sh
git commit -m "feat(mzweb-txio): POST /set/multicast/tx 完整實作（驗證/save_flag/sip.sdk/迴授防護）（Task 3）"
```

---

### Task 4: GET 擴充 `multicast_tx_config`＋`multicast_tx_status`（MTX-03）

**Files:**
- Modify: `docs/multi-zone-poc/src/mzweb/mzweb_txio.c`（填實 `mzweb_txio_add_tx_config`/`add_tx_status`）
- Modify: `docs/multi-zone-poc/src/mzweb/tests/test_txio_settx.py`（追加 GET 斷言）

**Interfaces:**
- Consumes: Task 2 注入點傳入的 `cJSON* root`／`cJSON* sip_status` 與已開啟的 `struct key_value_file* kv`（不得 free）。

- [ ] **Step 1: 追加測試斷言**（test_txio_settx.py 尾端）：

```python
# 11. 帶 token GET /get/sip/config → 200；json.loads(gbk decode) 成功；
#     body['multicast_tx_config'] == {"multicast_address": <前面設的值>, "multicast_port": 9000,
#                                     "enabled": True, "audio_codec": "G.722"}
# 12. /etc/ifcfg-sip 無 MULTICAST_TX_* 時（rm 後重啟 server）GET → multicast_tx_config
#     回預設 {"multicast_address":"239.0.0.100","multicast_port":9000,"enabled":False,"audio_codec":"G.722"}
# 13. 帶 token GET /get/device/status → 200 可 parse；body['sip_status']['multicast_tx_status'] ==
#     {"status":"发送中"或"关闭"（依 ENABLED）, "address":"<addr>:<port>", "audio_codec":"G.722"}
#     且 multicast_tx_status 是 sip_status 的「直接子物件」
```

- [ ] **Step 2: 跑測試確認失敗**（helpers 仍為空殼）

- [ ] **Step 3: 填實兩個 helper**：

```c
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
```

- [ ] **Step 4: 跑測試確認通過**（`sh tests/run_host_tests.sh` → ALL PASSED）

- [ ] **Step 5: Commit**

```bash
git add docs/multi-zone-poc/src/mzweb/mzweb_txio.c docs/multi-zone-poc/src/mzweb/tests/test_txio_settx.py
git commit -m "feat(mzweb-txio): GET 擴充 multicast_tx_config / multicast_tx_status（Task 4）"
```

---

### Task 5: IO 路由 `GET/POST /get|set/io/config`＋出廠預設＋SIGHUP 通知

**Files:**
- Modify: `docs/multi-zone-poc/src/mzweb/mzweb_txio.c`（填實 get_io/set_io＋內建預設表）
- Create: `docs/multi-zone-poc/src/mzweb/tests/test_txio_io.py`
- Modify: `docs/multi-zone-poc/src/mzweb/tests/run_host_tests.sh`

**Interfaces:**
- Consumes: `mztxio_validate_io_config`（Task 1）。
- Produces: `/opt/mzio.json` 格式 `{"io_config":[6 列]}`；每列欄位 `id/gpio/mode/contact/trigger/debounce_ms/action{type,param}`（檔內不存 state）；`/tmp/mzio_state` 格式 `{"1":0,"2":1,...}`；POST 成功後對 `/var/run/mzio.pid` 之 pid 送 SIGHUP。**內建預設表（單一真相，mzio Task 7 讀同一檔案格式）**：id2=GPIO5_5 input/NO/level/30/multicast_ptt("300")；id3=GPIO1_6 disabled；id1/4/5/6 gpio="" disabled。

- [ ] **Step 1: 寫整合測試** `tests/test_txio_io.py`（同前啟動/login helper）：

```python
# tests/test_txio_io.py — IO 路由（容器內；MZIO_JSON 等路徑用預設 /opt、/tmp——容器內可寫）
# 斷言（帶有效 token）：
#  1. /opt/mzio.json 不存在時 GET /get/io/config → 200；io_config 為 6 列；
#     id=2 列 gpio=="GPIO5_5"、mode=="input"、action.type=="multicast_ptt"、state==0；
#     id=1 列 gpio==""、mode=="disabled"
#  2. 寫 /tmp/mzio_state = '{"2":1}' 後 GET → id=2 列 state==1（合併即時值）
#  3. POST {"io_config":[{"id":2,...mode:"input",contact:"NO",trigger:"level",debounce_ms:50,
#     action:{type:"multicast_ptt",param:"500"}}]}（單列）→ 200 success；
#     /opt/mzio.json 中 id=2 的 debounce_ms==50；其餘 5 列保留預設；gpio 欄仍 "GPIO5_5"（伺服器端擁有）
#  4. POST 含 "gpio":"HACK" 與 "state":1 → 200；檔內 gpio 不變、無 state 欄（忽略唯讀欄）
#  5. POST debounce_ms=999 → 200 error E001 'IO配置非法'；檔案未變（整包拒收）
#  6. POST 後 SIGHUP：先寫 /var/run/mzio.pid = 測試自身 spawn 的 dummy python 程序 pid
#     （signal.pause 等 SIGHUP 後寫 marker 檔），POST 成功後斷言 marker 檔出現
#  7. GET 回應整包可過 json.loads（GBK decode 後）
```

- [ ] **Step 2: 跑測試確認失敗**（stub 回 success 無檔案行為）

- [ ] **Step 3: 實作**——`mzweb_txio.c` 增：

```c
#include <signal.h>   /* kill(SIGHUP) */
#include <unistd.h>   /* rename/unlink 於 stdio；getpid 不需 */

/* 出廠預設 io_config（gpio 對映唯一真相之 web 側鏡像；mzio 端常數表見 mzio_core.c，
 * 兩處以 tests/test_mzio_core.c 的一致性斷言互鎖）。回傳新建 cJSON 陣列（caller 擁有）。 */
static cJSON* txio_default_io_config(void)
{
    static const struct { int id; const char* gpio; const char* mode;
                          const char* trig; int db; const char* atype; const char* aparam; }
    defs[6] = {
        { 1, "",         "disabled", "edge",  30, "hangup",        ""    },
        { 2, "GPIO5_5",  "input",    "level", 30, "multicast_ptt", "300" },
        { 3, "GPIO1_6",  "disabled", "edge",  30, "hangup",        ""    },
        { 4, "",         "disabled", "edge",  30, "hangup",        ""    },
        { 5, "",         "disabled", "edge",  30, "hangup",        ""    },
        { 6, "",         "disabled", "edge",  30, "hangup",        ""    },
    };
    cJSON* arr = cJSON_CreateArray();
    int i;
    for (i = 0; i < 6; i++)
    {
        cJSON* row = cJSON_CreateObject();
        cJSON_AddNumberToObject(row, "id", defs[i].id);
        cJSON_AddStringToObject(row, "gpio", defs[i].gpio);
        cJSON_AddStringToObject(row, "mode", defs[i].mode);
        cJSON_AddStringToObject(row, "contact", "NO");
        cJSON_AddStringToObject(row, "trigger", defs[i].trig);
        cJSON_AddNumberToObject(row, "debounce_ms", defs[i].db);
        cJSON* act = cJSON_AddObjectToObject(row, "action");
        cJSON_AddStringToObject(act, "type", defs[i].atype);
        cJSON_AddStringToObject(act, "param", defs[i].aparam);
        cJSON_AddItemToArray(arr, row);
    }
    return arr;
}

/* 讀整個檔案進 malloc buffer（回傳 NULL=不存在/失敗；out_len 可 NULL） */
static char* txio_read_file(const char* path, int* out_len)
{
    FILE* f = fopen(path, "rb");
    long sz;
    char* buf;
    if (f == NULL) return NULL;
    if (fseek(f, 0, SEEK_END) != 0 || (sz = ftell(f)) < 0 || sz > 65536 ||
        fseek(f, 0, SEEK_SET) != 0) { fclose(f); return NULL; }
    buf = (char*)malloc((size_t)sz + 1);
    if (buf == NULL) { fclose(f); return NULL; }
    if (fread(buf, 1, (size_t)sz, f) != (size_t)sz) { fclose(f); free(buf); return NULL; }
    fclose(f);
    buf[sz] = 0;
    if (out_len != NULL) *out_len = (int)sz;
    return buf;
}

/* 讀 mzio.json → cJSON 陣列；無檔/壞檔 → 預設表 */
static cJSON* txio_load_io_config(void)
{
    int len = 0;
    char* buf = txio_read_file(MZIO_JSON, &len);
    if (buf != NULL)
    {
        cJSON* root = cJSON_Parse(buf, len);
        free(buf);
        if (root != NULL)
        {
            cJSON* arr = cJSON_DetachItemFromObject(root, "io_config");
            cJSON_Delete(root);
            if (arr != NULL && cJSON_IsArray(arr)) return arr;
            if (arr != NULL) cJSON_Delete(arr);
        }
    }
    return txio_default_io_config();
}
```

`mzweb_txio_get_io`：`txio_load_io_config()` → 逐列讀 `/tmp/mzio_state`（`cJSON_Parse` 後以 `"%d"` id 為 key 查數字，無檔全 0）加 `state` 欄 → 包 `{"io_config":[...]}` → `txio_send_json`。

`mzweb_txio_set_io`：
1. parse body、取 `io_config` 陣列，`mztxio_validate_io_config` 失敗 → `txio_send_error(client, "E001", err_msg)`。
2. 以 `txio_load_io_config()` 為基底，逐列以 id 合併傳入列（只覆蓋 `mode/contact/trigger/debounce_ms/action`；**`gpio`、`state` 一律不採計**）。
3. 原子寫：`MZIO_JSON ".tmp"` 寫 `{"io_config":[...]}`（`cJSON_PrintUnformatted`）→ `fflush`+`fsync`（`fileno`）→ `fclose` → `rename` 到 `MZIO_JSON`。
4. 讀 `MZIO_PIDFILE`（整數），pid > 1 → `kill(pid, SIGHUP)`；失敗僅 `fprintf(stderr, ...)`，照樣回 success。
5. `txio_send_success`。

- [ ] **Step 4: 跑測試確認通過**（`sh tests/run_host_tests.sh` → ALL PASSED）

- [ ] **Step 5: Commit**

```bash
git add docs/multi-zone-poc/src/mzweb/mzweb_txio.c docs/multi-zone-poc/src/mzweb/tests/test_txio_io.py docs/multi-zone-poc/src/mzweb/tests/run_host_tests.sh
git commit -m "feat(mzweb-txio): GET/POST io/config＋出廠預設＋原子寫＋SIGHUP 通知（Task 5）"
```

---

### Task 6: mzio 去抖＋PTT tail 狀態機（純函式，TDD）

**Files:**
- Create: `docs/multi-zone-poc/src/mzweb/mzio_core.h`
- Create: `docs/multi-zone-poc/src/mzweb/mzio_core.c`
- Create: `docs/multi-zone-poc/src/mzweb/tests/test_mzio_core.c`
- Modify: `docs/multi-zone-poc/src/mzweb/Makefile`（`COMPAT_TEST_mzio_core = mzio_core.c`）

**Interfaces:**
- Produces（Task 7 消費，簽名固定）:

```c
/* mzio_core.h — 單腳 PTT 狀態機：raw 取樣→去抖→press/release→tail timer→動作。
 * 無 I/O、無時鐘（now_ms 由 caller 餵入）→ host 可完整單元測試。 */
#ifndef MZIO_CORE_H
#define MZIO_CORE_H

enum mzio_act { MZIO_ACT_NONE = 0, MZIO_ACT_START_TX = 1, MZIO_ACT_STOP_TX = 2 };

struct mzio_sm {
    /* 配置（init 時填） */
    int debounce_ms;
    int tail_ms;
    int invert;          /* contact NC=1（極性反轉）；NO=0。
                          * 本板 raw: 短接=0（active-low 上拉）；logical pressed =
                          * (raw==0) ^ invert */
    /* 內部狀態 */
    int stable_pressed;  /* 去抖後穩定邏輯狀態；init=0（released） */
    int cand_pressed;    /* 去抖窗候選 */
    long long cand_since;/* 候選起始 ms；0=無候選 */
    long long tail_deadline; /* release 後停止 TX 的期限 ms；0=無 */
    int tx_on;
};

void mzio_sm_init(struct mzio_sm* sm, int debounce_ms, int tail_ms, int invert);
/* 餵一筆 raw 取樣（0/1）＋當下時間 → 應執行的動作 */
enum mzio_act mzio_sm_sample(struct mzio_sm* sm, int raw, long long now_ms);
/* 純時間推進（poll timeout 醒來）→ 應執行的動作（tail 到期） */
enum mzio_act mzio_sm_tick(struct mzio_sm* sm, long long now_ms);
/* 下一個需要喚醒的 deadline（ms 絕對時間；-1=無，可無限等） */
long long mzio_sm_next_deadline(const struct mzio_sm* sm);
#endif
```

- [ ] **Step 1: 寫失敗測試** `tests/test_mzio_core.c`（表格式劇本；`db=30, tail=300, invert=0`；raw 0=短接）：

```c
#include <assert.h>
#include <stdio.h>
#include "mzio_core.h"

int main(void) {
    struct mzio_sm sm;

    /* 劇本 1：乾淨 press→release→tail 到期 */
    mzio_sm_init(&sm, 30, 300, 0);
    assert(mzio_sm_sample(&sm, 0, 1000) == MZIO_ACT_NONE);      /* 候選開始，未達去抖窗 */
    assert(mzio_sm_sample(&sm, 0, 1031) == MZIO_ACT_START_TX);  /* 30ms 穩定 → press */
    assert(sm.tx_on == 1);
    assert(mzio_sm_sample(&sm, 1, 2000) == MZIO_ACT_NONE);      /* release 候選 */
    assert(mzio_sm_sample(&sm, 1, 2031) == MZIO_ACT_NONE);      /* release 確立 → tail 起算，尚不停止 */
    assert(mzio_sm_next_deadline(&sm) == 2031 + 300);
    assert(mzio_sm_tick(&sm, 2200) == MZIO_ACT_NONE);           /* tail 未到 */
    assert(mzio_sm_tick(&sm, 2331) == MZIO_ACT_STOP_TX);        /* tail 到期 */
    assert(sm.tx_on == 0 && mzio_sm_next_deadline(&sm) == -1);

    /* 劇本 2：彈跳（<30ms 抖動）不觸發 */
    mzio_sm_init(&sm, 30, 300, 0);
    assert(mzio_sm_sample(&sm, 0, 100) == MZIO_ACT_NONE);
    assert(mzio_sm_sample(&sm, 1, 110) == MZIO_ACT_NONE);       /* 10ms 就彈回 → 候選作廢 */
    assert(mzio_sm_sample(&sm, 0, 115) == MZIO_ACT_NONE);
    assert(mzio_sm_sample(&sm, 1, 120) == MZIO_ACT_NONE);
    assert(mzio_sm_tick(&sm, 1000) == MZIO_ACT_NONE);           /* 始終無動作 */
    assert(sm.tx_on == 0);

    /* 劇本 3：tail 內重按 → 取消停止、不重送 START */
    mzio_sm_init(&sm, 30, 300, 0);
    mzio_sm_sample(&sm, 0, 1000); mzio_sm_sample(&sm, 0, 1031); /* press */
    mzio_sm_sample(&sm, 1, 2000); mzio_sm_sample(&sm, 1, 2031); /* release, tail@2331 */
    assert(mzio_sm_sample(&sm, 0, 2100) == MZIO_ACT_NONE);      /* 重按候選 */
    assert(mzio_sm_sample(&sm, 0, 2131) == MZIO_ACT_NONE);      /* press 確立：tx 已 on → 不重送 */
    assert(sm.tx_on == 1 && sm.tail_deadline == 0);             /* tail 取消 */
    assert(mzio_sm_tick(&sm, 3000) == MZIO_ACT_NONE);           /* 舊 deadline 不追殺 */

    /* 劇本 4：NC 反轉（invert=1）：raw 1（斷開）＝pressed */
    mzio_sm_init(&sm, 30, 300, 1);
    assert(mzio_sm_sample(&sm, 1, 100) == MZIO_ACT_NONE);
    assert(mzio_sm_sample(&sm, 1, 131) == MZIO_ACT_START_TX);

    /* 劇本 5：tail=0 → release 確立即停 */
    mzio_sm_init(&sm, 30, 0, 0);
    mzio_sm_sample(&sm, 0, 100); mzio_sm_sample(&sm, 0, 131);
    mzio_sm_sample(&sm, 1, 500);
    assert(mzio_sm_sample(&sm, 1, 531) == MZIO_ACT_STOP_TX);

    printf("test_mzio_core: ALL PASS\n");
    return 0;
}
```

- [ ] **Step 2: Makefile 加 `COMPAT_TEST_mzio_core = mzio_core.c`；跑 `make host-mzio_core` 確認編譯失敗**

- [ ] **Step 3: 實作 `mzio_core.c`**：

```c
#include "mzio_core.h"

void mzio_sm_init(struct mzio_sm* sm, int debounce_ms, int tail_ms, int invert)
{
    sm->debounce_ms = debounce_ms;
    sm->tail_ms = tail_ms;
    sm->invert = invert;
    sm->stable_pressed = 0;
    sm->cand_pressed = 0;
    sm->cand_since = 0;
    sm->tail_deadline = 0;
    sm->tx_on = 0;
}

/* 穩定狀態確立後的動作決策 */
static enum mzio_act on_stable_change(struct mzio_sm* sm, int pressed, long long now_ms)
{
    sm->stable_pressed = pressed;
    if (pressed)
    {
        sm->tail_deadline = 0;              /* tail 中重按：取消停止 */
        if (!sm->tx_on) { sm->tx_on = 1; return MZIO_ACT_START_TX; }
        return MZIO_ACT_NONE;               /* 已在發送（tail 取消情形）：不重送 */
    }
    /* release */
    if (sm->tx_on)
    {
        if (sm->tail_ms <= 0) { sm->tx_on = 0; return MZIO_ACT_STOP_TX; }
        sm->tail_deadline = now_ms + sm->tail_ms;
    }
    return MZIO_ACT_NONE;
}

enum mzio_act mzio_sm_sample(struct mzio_sm* sm, int raw, long long now_ms)
{
    int pressed = (raw == 0) ? 1 : 0;       /* 本板 active-low：短接 raw=0 */
    if (sm->invert) pressed = !pressed;

    if (pressed == sm->stable_pressed)      /* 回到穩定值：候選作廢 */
    {
        sm->cand_since = 0;
        return mzio_sm_tick(sm, now_ms);
    }
    if (sm->cand_since == 0 || sm->cand_pressed != pressed)
    {
        sm->cand_pressed = pressed;         /* 新候選（或候選值翻轉：重新起算） */
        sm->cand_since = now_ms;
        return mzio_sm_tick(sm, now_ms);
    }
    if (now_ms - sm->cand_since >= sm->debounce_ms)
    {
        sm->cand_since = 0;
        return on_stable_change(sm, pressed, now_ms);
    }
    return mzio_sm_tick(sm, now_ms);
}

enum mzio_act mzio_sm_tick(struct mzio_sm* sm, long long now_ms)
{
    if (sm->tail_deadline != 0 && now_ms >= sm->tail_deadline)
    {
        sm->tail_deadline = 0;
        if (sm->tx_on) { sm->tx_on = 0; return MZIO_ACT_STOP_TX; }
    }
    return MZIO_ACT_NONE;
}

long long mzio_sm_next_deadline(const struct mzio_sm* sm)
{
    long long dl = -1;
    if (sm->tail_deadline != 0) dl = sm->tail_deadline;
    if (sm->cand_since != 0)
    {
        long long c = sm->cand_since + sm->debounce_ms;
        if (dl < 0 || c < dl) dl = c;
    }
    return dl;
}
```

> 注意劇本 1 的 `mzio_sm_sample(&sm, 0, 1031)`：候選在 1000 起算、1031-1000=31≥30 → press。若你的實作對「同值第二筆」走「候選確認」路徑，劇本天然通過；若把同值第二筆當新候選，劇本 2 會揪出來。**去抖窗內需要中途取樣才會確認**——Task 7 的 poll 迴圈以 `mzio_sm_next_deadline` 當 timeout 醒來後重讀 value 再餵 `mzio_sm_sample`，保證有這筆取樣。

- [ ] **Step 4: 跑測試確認通過**

Run: `cd docs/multi-zone-poc/src/mzweb && make host-mzio_core && docker run --rm --platform linux/amd64 -v "$PWD":/src -w /src python:3.12-alpine ./build/test_mzio_core`
Expected: `test_mzio_core: ALL PASS`

- [ ] **Step 5: Commit**

```bash
git add docs/multi-zone-poc/src/mzweb/mzio_core.h docs/multi-zone-poc/src/mzweb/mzio_core.c docs/multi-zone-poc/src/mzweb/tests/test_mzio_core.c docs/multi-zone-poc/src/mzweb/Makefile
git commit -m "feat(mzio): 去抖＋PTT tail 狀態機純函式與單元測試（Task 6）"
```

---

### Task 7: mzio daemon main（GPIO poll 迴圈＋動作分派＋state 檔）

**Files:**
- Create: `docs/multi-zone-poc/src/mzweb/mzio.c`
- Modify: `docs/multi-zone-poc/src/mzweb/Makefile`（`arm-mzio`/`x86-mzio` 目標）
- Create: `docs/multi-zone-poc/src/mzweb/tests/test_mzio_selftest.py`
- Modify: `docs/multi-zone-poc/src/mzweb/tests/run_host_tests.sh`

**Interfaces:**
- Consumes: `mzio_core.h` 狀態機、`mzsdk_send`、`keyvaluefile`、`cjson`。Task 5 的 `/opt/mzio.json` 格式與預設語意。
- Produces: binary `build/mzio-arm`；`mzio -t` 組態自檢模式（載入 config、印各腳啟用狀態、exit 0/1，不碰 GPIO）；環境變數覆蓋 `MZIO_GPIO_ROOT`（預設 `/sys/class/gpio`）、`MZIO_JSON`、`MZIO_IFCFG`、`MZIO_STATE`、`MZIO_PIDFILE`（供測試/部署彈性）。

- [ ] **Step 1: 寫測試** `tests/test_mzio_selftest.py`：

```python
# tests/test_mzio_selftest.py — mzio -t 組態自檢（不碰 GPIO/網路，容器可跑）
# 1. 無 config 檔（MZIO_JSON 指向不存在路徑）→ mzio -t exit 0，stdout 含 "io2"（id2 內建預設啟用）
#    且含 "gpio45"（GPIO5_5 → Linux 45 對映正確）
# 2. config 檔含 id2 mode:"disabled" → mzio -t stdout 顯示 0 個啟用腳、exit 0
# 3. config 檔壞 JSON → mzio -t exit 0 並 stderr 警告 fallback 預設（與 mzweb GET 行為一致）
# 4. config 檔 id2 debounce_ms:999（非法）→ mzio -t exit 1（fail loudly，防手改壞檔靜默上線）
```

- [ ] **Step 2: Makefile 加目標**：

```make
MZIOSRC = mzio.c mzio_core.c mzsdk.c keyvaluefile.c cjson_vendor.c

arm-mzio:
	$(DOCKER) muslcc/x86_64:arm-linux-musleabi -march=armv7-a -static -no-pie -fno-pie -O2 -I. -o build/mzio-arm $(MZIOSRC)

x86-mzio:
	$(DOCKER) muslcc/x86_64:x86_64-linux-musl -static -no-pie -fno-pie -O2 -I. -o build/mzio-x86 $(MZIOSRC)
```

（獨立寫 flags、不用 `$(CFLAGS)`——mzio 不需 mbedTLS。）

- [ ] **Step 3: 實作 `mzio.c`**（單檔 ~300 行；結構如下，關鍵段落給碼）：

```c
/* mzio.c — IO 動作 side-car daemon（spec §5）。
 * 單執行緒 poll(2)：GPIO value fd 的 POLLPRI（sysfs edge 中斷）＋ SIGHUP/SIGTERM 旗標；
 * tail/去抖 deadline 用 poll timeout。動作 multicast_ptt = 寫 MULTICAST_TX_ENABLED
 * ＋ sip.sdk set_sip_multicast_tx（termapp 執行 TX；spec 決策 1）。
 * 其餘 action：log not implemented 跳過。edge 寫入失敗＝該腳標故障、不輪詢（spec 決策 2）。 */

/* --- gpio 對映表（daemon 端唯一真相；web 端預設表鏡像此表） --- */
static const struct { int id; const char* gpio_name; int linux_num; } s_gpio_map[] = {
    { 2, "GPIO5_5", 45 },   /* io1 — 2026-07-23 真機實證 */
    { 3, "GPIO1_6", 14 },   /* io2 — 實證（v1 預設 disabled） */
};   /* id 1/4/5/6 未對映：config 有列也跳過 */

struct chan {
    int id;
    int linux_num;
    int fd;                 /* value fd；-1=未啟用/故障 */
    struct mzio_sm sm;
    int tail_ms;            /* action.param（multicast_ptt） */
    int is_ptt;             /* action.type == multicast_ptt */
    int last_stable;        /* state 檔回報值（邏輯 pressed） */
};
```

要點逐條（實作照此，皆已在 spec 定案）：

1. **config 載入**（啟動＋SIGHUP）：讀 `MZIO_JSON`（無檔/壞檔→內建預設，警告 stderr；**壞值**（過不了與 Task 1 相同規則的驗證）→ 啟動模式 exit 1、SIGHUP 模式保留舊 config 並 log）。內建預設表與 Task 5 `txio_default_io_config` 相同語意（id2 啟用 multicast_ptt）。驗證函式直接連結 `mzweb_txio.c`？**否**——mzio 不連 webapi；把 `mztxio_validate_io_config` 用 `#include` 共用會拖入 web 依賴，改為 mzio.c 內以同規則重寫精簡版 `mzio_validate_row()`（僅檢查用得到的欄：id/mode/trigger/debounce/action.type 白名單）。
2. **腳位啟用**：對每列 `mode=="input"` 且 id 在 `s_gpio_map` → export（寫 `%d` 到 `<root>/export`，EBUSY/已存在容忍）→ `<root>/gpioN/direction`="in" → `<root>/gpioN/edge`="both"。**edge 寫失敗：fprintf(stderr, "mzio: gpio%d edge unsupported, channel DISABLED\n")、fd=-1、不輪詢**。open `<root>/gpioN/value` O_RDONLY，先 read 一次清 pending 中斷。
3. **poll 迴圈**：`struct pollfd` 陣列（value fd，events=`POLLPRI|POLLERR`）；timeout = 各 chan `mzio_sm_next_deadline()` 最小值減 now（無 deadline → -1 無限等）。醒來後：POLLPRI 的 fd `lseek(fd,0,SEEK_SET)`+read 1 byte → `mzio_sm_sample(sm, raw, now_ms())`；接著對**所有** chan 跑 `mzio_sm_tick`（含去抖窗確認用的重讀：若 chan 的 `cand_since != 0` 且已過窗 → 重讀 value 餵 sample）。`now_ms()` 用 `clock_gettime(CLOCK_MONOTONIC)`。
4. **動作分派**：`MZIO_ACT_START_TX` → `set_tx_enabled(1)`；`MZIO_ACT_STOP_TX` → `set_tx_enabled(0)`。

```c
static void set_tx_enabled(int on)
{
    struct key_value_file* kv = read_keyvalue_file(mzio_ifcfg_path());
    if (kv == NULL) { fprintf(stderr, "mzio: cannot read ifcfg\n"); return; }
    const char* cur = find_key_value(kv, "MULTICAST_TX_ENABLED");
    const char* want = on ? "true" : "false";
    if (cur == NULL) add_key_value(kv, "MULTICAST_TX_ENABLED", want);
    else if (strcmp(cur, want) == 0) { free_keyvalue_file(kv); return; } /* 已是目標值：不寫不通知 */
    else modify_key_value(kv, "MULTICAST_TX_ENABLED", want);
    write_keyvalue_file(mzio_ifcfg_path(), kv);
    free_keyvalue_file(kv);
    if (mzsdk_send("{\"command\": \"set_sip_multicast_tx\",\"cseq\": 1}\r\n\r\n") != 0)
    {
        usleep(200000);   /* 重試 1 次（spec §5.4） */
        if (mzsdk_send("{\"command\": \"set_sip_multicast_tx\",\"cseq\": 1}\r\n\r\n") != 0)
            fprintf(stderr, "mzio: sip.sdk notify failed\n");
    }
}
```

   非 ptt 的 action：`fprintf(stderr, "mzio: action %s not implemented\n", type)`。
5. **開機歸零**（spec §5.4）：啟動時若有任一 ptt 綁定且 `MULTICAST_TX_ENABLED==true` → `set_tx_enabled(0)`。
6. **state 檔**：任一 chan 穩定狀態變化後，全表寫 `MZIO_STATE`（tmp+rename）：`{"2":1,"3":0}`（僅啟用腳；值=邏輯 pressed）。
7. **訊號**：`SIGHUP` → volatile flag，迴圈頂部重載 config（關舊 fd、重建 chans）；`SIGTERM/SIGINT` → 若 tx_on 先 `set_tx_enabled(0)` 再退出（不留孤兒推流）。pidfile：啟動寫 `MZIO_PIDFILE`。
8. **`-t` 模式**：載入+驗證 config、印各腳 `io%d -> gpio%d (enabled/disabled/unmapped)`、exit 0/1，不碰 GPIO 不開 socket（供 test_mzio_selftest.py 與部署前檢查）。

- [ ] **Step 4: 建置＋跑測試**

Run: `cd docs/multi-zone-poc/src/mzweb && make x86-mzio && sh tests/run_host_tests.sh`（run_host_tests.sh 已掛 test_mzio_selftest.py）
Expected: ALL PASSED

- [ ] **Step 5: arm 交叉編譯確認**

Run: `make arm-mzio && file build/mzio-arm`
Expected: `ELF 32-bit LSB executable, ARM ... statically linked`

- [ ] **Step 6: Commit**

```bash
git add docs/multi-zone-poc/src/mzweb/mzio.c docs/multi-zone-poc/src/mzweb/Makefile docs/multi-zone-poc/src/mzweb/tests/test_mzio_selftest.py docs/multi-zone-poc/src/mzweb/tests/run_host_tests.sh
git commit -m "feat(mzio): daemon main——GPIO edge poll 迴圈＋multicast_ptt 分派＋state 檔（Task 7）"
```

---

### Task 8: S21mzio＋mzdeploy 擴充＋真機 .70 部署驗收

**Files:**
- Create: `docs/multi-zone-poc/src/S21mzio`
- Modify: `docs/multi-zone-poc/src/mzdeploy.sh`（加 `mzio-install`/`mzio-status`）

**前置**：Task 1–7 全綠；`make arm-mzweb arm-mzio` 產物就緒。真機操作經 `mzctl.py`（MZHOST=192.168.0.70）。

- [ ] **Step 1: 寫 `S21mzio`**（照 S21mzrelay 模式）：

```sh
#!/bin/sh
# S21mzio — IO 動作 side-car autostart。rcS 無參數呼叫 -> start。
BIN=/opt/mzio
case "${1:-start}" in
start)
	[ -x "$BIN" ] || exit 0
	"$BIN" 2>>/tmp/mzio.boot.log &
	echo "mzio: autostart armed"
	;;
stop)
	killall mzio 2>/dev/null
	;;
esac
exit 0
```

（不等網路——mzio 只碰本機 GPIO/檔案/unix socket。config 缺檔時 daemon 用內建預設，故不設 CONF 前置條件。）

- [ ] **Step 2: `mzdeploy.sh` 加 case**（照 `deploy`/`mzweb-install` 樣式）：

```sh
mzio-install)
	[ -f mzweb/build/mzio-arm ] || { echo "缺 mzio-arm，先 make arm-mzio"; exit 1; }
	$CTL sh 'test -f /opt/mzio && cp /opt/mzio /opt/mzio.prev || true'
	$CTL put mzweb/build/mzio-arm /opt/mzio
	$CTL put S21mzio /etc/init.d/S21mzio
	$CTL sh 'chmod +x /opt/mzio /etc/init.d/S21mzio; killall mzio 2>/dev/null; sleep 1; /etc/init.d/S21mzio; sleep 1; ps | grep mzio | grep -v grep | head -2; sync'
	;;
mzio-status)
	$CTL sh 'ps | grep mzio | grep -v grep; cat /tmp/mzio_state 2>/dev/null; ls -la /opt/mzio /opt/mzio.json /etc/init.d/S21mzio 2>&1; tail -5 /tmp/mzio.boot.log 2>/dev/null'
	;;
```

- [ ] **Step 3: 真機前置驗證——edge 支援（spec 單點風險，最先做）**

```bash
cd docs/multi-zone-poc/src && python3 mzctl.py sh 'echo 45 > /sys/class/gpio/export 2>/dev/null; echo in > /sys/class/gpio/gpio45/direction; echo both > /sys/class/gpio/gpio45/edge && echo EDGE_OK || echo EDGE_FAIL; cat /sys/class/gpio/gpio45/edge'
```

Expected: `EDGE_OK` + `both`。**若 EDGE_FAIL：停下回報使用者**（spec 已載明此情況回頭補輪詢兜底，屬 scope 變更）。

- [ ] **Step 4: 部署**

```bash
cd docs/multi-zone-poc/src/mzweb && make arm-mzweb arm-mzio
cd .. && ./mzdeploy.sh mzweb-install && ./mzdeploy.sh mzio-install
```

- [ ] **Step 5: 真機驗收（spec §7；逐條記錄實際輸出）**

TX 路由（token 先 login 取得；BASE=https://192.168.0.70）：
1. 無 token `POST $BASE/set/multicast/tx` → 401 A003。
2. `{"multicast_address":"192.168.1.1",...}` → E001 非法组播地址；port 0/65535 → E001 非法组播端口。
3. 合法 `{"multicast_address":"239.9.9.9","multicast_port":9100,"enabled":false,"audio_codec":"G.722"}` → 200；設備 `/etc/ifcfg-sip` 出現 4 個 `MULTICAST_TX_*` key。
4. `GET /get/sip/config`、`GET /get/device/status` 整包 `python3 -m json.tool`（GBK decode）通過，新欄位形狀如 spec §3.2。
5. TX==RX 位址:埠 + enabled=true → E001 发送地址与接收地址相同。

IO 路由：
6. `GET /get/io/config` → 6 列、id2=GPIO5_5/multicast_ptt。`POST` 改 id2 debounce=50 → 200；再 GET 一致；mzio 收 SIGHUP（`/tmp/mzio.boot.log` 或 ps 確認存活）。

端對端 PTT（需現場接 io1 乾接點；另一台 .72 或 mztone 收 239.x TX 位址）:
7. web 設 TX 位址/埠（enabled 任意）→ io1 短接 → .72/mztone 於 ~2 秒內聽到 .70 Mic 聲；`/tmp/mzio_state` 中 `"2":1`。
8. 放開 → 約 tail 300ms 後停止；快速「放開→0.2s 內重按」→ 不中斷。
9. 設備重開機 → mzio 自啟、`MULTICAST_TX_ENABLED` 為 false（開機歸零）、PTT 功能正常。

- [ ] **Step 6: 收尾**——`bash scripts/gitnexus-fresh.sh` 後 `detect_changes()` 檢查影響面；commit S21mzio/mzdeploy.sh 與驗收紀錄（附進 handoff 或 spec 附錄）：

```bash
git add docs/multi-zone-poc/src/S21mzio docs/multi-zone-poc/src/mzdeploy.sh
git commit -m "feat(mzio): S21 自啟＋mzdeploy mzio-install＋真機 .70 驗收（Task 8）"
```

---

## 附註（executor 常見雷）

- `build/` 目錄整個是產物（含 patch+注入後的 websetsip.c），**改路由/handler 一律改 `mzweb_txio.c` 或 `txio_inject.py` 後 `rm -rf build && make`**，不要手改 build 下任何檔。
- 整合測試斷言 GBK 訊息時用 bytes 比對：`'非法组播地址'.encode('gbk') in resp_body_bytes`，不要 decode 成 str 比。
- mzweb 回應 `Connection: close`，python 測試每請求開新連線（既有 test_*.py 皆如此）。
- 測試容器內 `/opt`、`/etc`、`/tmp`、`/var/run` 都可寫；若 `/var/run` 不存在先 `os.makedirs`。
- docker 需在跑；`make` 在 mac host 執行（docker run 包 gcc），python 整合測試在 alpine 容器內由 `run_host_tests.sh` 統一驅動。

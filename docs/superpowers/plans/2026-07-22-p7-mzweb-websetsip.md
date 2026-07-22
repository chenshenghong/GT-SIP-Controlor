# P7 自建 websetsip（mzweb）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 以自研相容層＋原廠 websetsip.c 最小 diff 重建設備 `:80` web 管理程式（mzweb），新增兩條 zones 路由（轉呼 mzrelay3 loopback），並以「原廠 vs mzweb 線上 diff」驗收零漂移。

**Architecture:** 見 spec `docs/superpowers/specs/2026-07-22-p7-websetsip-design.md`。相容層（webapi/event/keyvaluefile/socketbase/hostsid stub/cJSON vendor）＋原廠 GBK 源碼經 `websetsip-p7.patch` 最小修改＋我方新檔 `mzweb_zones.c`／`serve_index.c`。雙建置目標：x86_64 musl 靜態（容器內測試）與 armv7 musl 靜態（真機）。

**Tech Stack:** C (musl static)、Docker muslcc toolchain、python3 測試 harness、真機 `192.168.0.70`（root SSH :9521，經 `mzctl.py`）。

## Global Constraints

- 原廠源碼 `docs/firmware-reference/websetsip.c`（GBK）**不進版控**（.gitignore 既有）；我方修改一律以 `websetsip-p7.patch` 形式進版控，建置時 copy＋patch。
- 編譯**原始 GBK 檔**，不加 `-finput-charset`（原字節直通；spec §六風險 5）。
- 交叉編譯：`docker run --rm --platform linux/amd64 -v "$PWD":/src -w /src --entrypoint gcc muslcc/x86_64:<target> -march=<arch> -static -no-pie -fno-pie -O2 ...`；target 兩種：`arm-linux-musleabi`（armv7 真機）、`x86_64-linux-musl`（容器測試）。
- 原廠怪癖**原樣保留**：token 比對 `len == strlen(now_token) - 1`、單 token 單 session、GBK 回應、`Connection: close`、明文密碼回傳、慢 `/system/info`（spec §3.2）。
- 資源邊界（spec §3.1）：併發連線上限 4、URL ≤2KB、headers ≤8KB、body ≤32KB、idle timeout 30s、`SIGPIPE` ignore＋`MSG_NOSIGNAL`。
- 路由比對沿用 `strncmp(literal, url, len)` 慣例；**新路由 `/set|get/sip/multicast/zones` 與既有 `/set/sip/multicast` 有前綴碰撞，新路由必須加 `len == strlen(literal)` 全等判斷且置於舊路由之前**。
- 真機操作一律經 `docs/multi-zone-poc/src/mzctl.py`（root@192.168.0.70:9521）。裝置上原廠 sipweb 位於 `/etc/sipweb/sipweb`。
- 每個 task 結尾 commit；commit 訊息尾附 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。
- 工作目錄（新程式碼）：`docs/multi-zone-poc/src/mzweb/`。

---

### Task 1: mzweb 骨架＋trivial 模組＋雙目標建置

**Files:**
- Create: `docs/multi-zone-poc/src/mzweb/Makefile`
- Create: `docs/multi-zone-poc/src/mzweb/socketbase.h`、`socketbase.c`
- Create: `docs/multi-zone-poc/src/mzweb/hostsid.h`、`hostsid.c`
- Create: `docs/multi-zone-poc/src/mzweb/aio_audio.h`（空）
- Create: `docs/multi-zone-poc/src/mzweb/tests/run_host_tests.sh`

**Interfaces:**
- Produces: `set_no_block(int fd)`、`close_socket(int fd)`、`judge_hostsid_is_equal(const char*)`（恆 0＝放行；websetsip.c:2836 為 `!= 0` 才拒啟）。
- Produces: `make host-<name>` 慣例＝以 x86_64 musl 編測試執行檔；`make arm-mzweb`＝armv7 目標（Task 6 起用）。

- [ ] **Step 1: 建目錄與 trivial 模組**

`socketbase.h`：
```c
#ifndef SOCKETBASE_H
#define SOCKETBASE_H
void set_no_block(int fd);
void close_socket(int fd);
#endif
```
`socketbase.c`：
```c
#include <fcntl.h>
#include <unistd.h>
#include "socketbase.h"
void set_no_block(int fd) { int f = fcntl(fd, F_GETFL, 0); if (f >= 0) fcntl(fd, F_SETFL, f | O_NONBLOCK); }
void close_socket(int fd) { if (fd >= 0) close(fd); }
```
`hostsid.h`：
```c
#ifndef HOSTSID_H
#define HOSTSID_H
int judge_hostsid_is_equal(const char* sn);
#endif
```
`hostsid.c`：
```c
#include "hostsid.h"
/* P7 stub: 0 = pass. websetsip.c:2836 只在 != 0 時拒絕啟動（spec §3.1；原廠語意不可考）。 */
int judge_hostsid_is_equal(const char* sn) { (void)sn; return 0; }
```
`aio_audio.h`：
```c
/* P7: 死 include（websetsip.c 零符號使用），空頭檔即可。 */
```

- [ ] **Step 2: Makefile（雙目標＋vendor 檔組裝）**

```makefile
# docs/multi-zone-poc/src/mzweb/Makefile — 一律在 mzweb/ 目錄下執行
DOCKER   = docker run --rm --platform linux/amd64 -v "$(CURDIR)":/src -w /src --entrypoint gcc
CC_ARM   = $(DOCKER) muslcc/x86_64:arm-linux-musleabi -march=armv7-a
CC_X86   = $(DOCKER) muslcc/x86_64:x86_64-linux-musl
CFLAGS   = -static -no-pie -fno-pie -O2 -I.
COMPAT   = socketbase.c hostsid.c keyvaluefile.c event.c webapi.c cJSON.c
APPSRC   = build/websetsip.c build/main.c mzweb_zones.c serve_index.c

build/websetsip.c: ../../firmware-reference/websetsip.c websetsip-p7.patch
	mkdir -p build
	cp ../../firmware-reference/websetsip.c build/websetsip.c
	cp ../../firmware-reference/main.c build/main.c
	patch build/websetsip.c < websetsip-p7.patch

arm-mzweb: build/websetsip.c
	$(CC_ARM) $(CFLAGS) -o build/mzweb-arm $(APPSRC) $(COMPAT)

x86-mzweb: build/websetsip.c
	$(CC_X86) $(CFLAGS) -o build/mzweb-x86 $(APPSRC) $(COMPAT)

host-%: tests/test_%.c
	$(CC_X86) $(CFLAGS) -o build/test_$* $< $(COMPAT_TEST_$*)

clean:
	rm -rf build
```
> `COMPAT_TEST_*` 由各 task 在 Makefile 補一行（如 `COMPAT_TEST_keyvaluefile = keyvaluefile.c`）。

`tests/run_host_tests.sh`：
```bash
#!/bin/sh
# 在 x86_64 linux 容器內執行 build/test_* 全部（musl 靜態，alpine 可跑）
set -e
cd "$(dirname "$0")/.."
docker run --rm --platform linux/amd64 -v "$PWD":/src -w /src python:3.12-alpine \
  sh -c 'for t in build/test_*; do [ -x "$t" ] || continue; echo "== $t"; "$t"; done; [ -f tests/http_test.py ] && python3 tests/http_test.py || true'
```

- [ ] **Step 3: 驗證 trivial 模組可編**

Run: `cd docs/multi-zone-poc/src/mzweb && $(拆開 Makefile 的 CC_X86) -static -O2 -c socketbase.c hostsid.c` → 用 `make host-smoke` 前先手動：
```bash
docker run --rm --platform linux/amd64 -v "$PWD":/src -w /src --entrypoint gcc muslcc/x86_64:x86_64-linux-musl -static -O2 -I. -c socketbase.c hostsid.c -o /dev/null 2>&1 || echo COMPILE-FAIL
```
Expected: 無輸出（編譯通過）。

- [ ] **Step 4: Commit**

```bash
git add docs/multi-zone-poc/src/mzweb
git commit -m "feat(multi-zone): P7 T1 mzweb 骨架＋trivial 相容模組（socketbase/hostsid stub/aio_audio 空頭檔）"
```

---

### Task 2: keyvaluefile（TDD）

**Files:**
- Create: `docs/multi-zone-poc/src/mzweb/keyvaluefile.h`、`keyvaluefile.c`
- Test: `docs/multi-zone-poc/src/mzweb/tests/test_keyvaluefile.c`

**Interfaces:**
- Produces（簽名由呼叫點分析鎖定，spec §五）:
```c
struct key_value_file;
struct key_value_file* read_keyvalue_file(const char* path);   /* 檔案不存在回 NULL */
const char* find_key_value(struct key_value_file*, const char* key); /* 無此 key 回 NULL */
void add_key_value(struct key_value_file*, const char* key, const char* val);
void modify_key_value(struct key_value_file*, const char* key, const char* val);
void write_keyvalue_file(const char* path, struct key_value_file*);
void free_keyvalue_file(struct key_value_file*);
```

- [ ] **Step 1: 寫失敗測試**

`tests/test_keyvaluefile.c`：
```c
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "keyvaluefile.h"
int main(void) {
    FILE* f = fopen("/tmp/kv_test", "w");
    fprintf(f, "WEB_USER=admin\nWEB_PORT=80\n# comment line\nPLAY_VOL=75\n");
    fclose(f);
    struct key_value_file* kv = read_keyvalue_file("/tmp/kv_test");
    assert(kv);
    assert(strcmp(find_key_value(kv, "WEB_USER"), "admin") == 0);
    assert(strcmp(find_key_value(kv, "PLAY_VOL"), "75") == 0);
    assert(find_key_value(kv, "NOPE") == NULL);
    modify_key_value(kv, "WEB_PORT", "8081");
    add_key_value(kv, "NEW_KEY", "x");
    write_keyvalue_file("/tmp/kv_test2", kv);
    free_keyvalue_file(kv);
    kv = read_keyvalue_file("/tmp/kv_test2");
    assert(strcmp(find_key_value(kv, "WEB_PORT"), "8081") == 0);
    assert(strcmp(find_key_value(kv, "NEW_KEY"), "x") == 0);
    /* 非 KEY=VALUE 行保留原樣（防呆：不破壞原廠檔中的註解/空行） */
    free_keyvalue_file(kv);
    assert(read_keyvalue_file("/tmp/kv_nonexist_zzz") == NULL);
    printf("keyvaluefile OK\n");
    return 0;
}
```
Makefile 加：`COMPAT_TEST_keyvaluefile = keyvaluefile.c`

- [ ] **Step 2: 跑測試確認失敗**

Run: `make host-keyvaluefile`
Expected: FAIL（`keyvaluefile.h` 不存在）。

- [ ] **Step 3: 實作**

`keyvaluefile.h`：
```c
#ifndef KEYVALUEFILE_H
#define KEYVALUEFILE_H
struct key_value_file;
struct key_value_file* read_keyvalue_file(const char* path);
const char* find_key_value(struct key_value_file* kv, const char* key);
void add_key_value(struct key_value_file* kv, const char* key, const char* val);
void modify_key_value(struct key_value_file* kv, const char* key, const char* val);
void write_keyvalue_file(const char* path, struct key_value_file* kv);
void free_keyvalue_file(struct key_value_file* kv);
#endif
```
`keyvaluefile.c`（行陣列，KEY=VALUE 行解析、其他行原樣保留）：
```c
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "keyvaluefile.h"

#define KV_MAX_LINES 256
#define KV_MAX_LINE  512

struct kv_line { char raw[KV_MAX_LINE]; char key[128]; char val[256]; int is_kv; };
struct key_value_file { struct kv_line lines[KV_MAX_LINES]; int n; };

struct key_value_file* read_keyvalue_file(const char* path) {
    FILE* f = fopen(path, "r");
    if (!f) return NULL;
    struct key_value_file* kv = calloc(1, sizeof(*kv));
    char buf[KV_MAX_LINE];
    while (kv->n < KV_MAX_LINES && fgets(buf, sizeof(buf), f)) {
        struct kv_line* l = &kv->lines[kv->n++];
        buf[strcspn(buf, "\r\n")] = 0;
        snprintf(l->raw, sizeof(l->raw), "%s", buf);
        char* eq = strchr(buf, '=');
        if (eq && buf[0] != '#') {
            l->is_kv = 1;
            *eq = 0;
            snprintf(l->key, sizeof(l->key), "%s", buf);
            snprintf(l->val, sizeof(l->val), "%s", eq + 1);
        }
    }
    fclose(f);
    return kv;
}
static struct kv_line* kv_find(struct key_value_file* kv, const char* key) {
    for (int i = 0; i < kv->n; i++)
        if (kv->lines[i].is_kv && strcmp(kv->lines[i].key, key) == 0) return &kv->lines[i];
    return NULL;
}
const char* find_key_value(struct key_value_file* kv, const char* key) {
    struct kv_line* l = kv_find(kv, key);
    return l ? l->val : NULL;
}
void modify_key_value(struct key_value_file* kv, const char* key, const char* val) {
    struct kv_line* l = kv_find(kv, key);
    if (l) snprintf(l->val, sizeof(l->val), "%s", val);
}
void add_key_value(struct key_value_file* kv, const char* key, const char* val) {
    if (kv->n >= KV_MAX_LINES) return;
    struct kv_line* l = &kv->lines[kv->n++];
    l->is_kv = 1;
    snprintf(l->key, sizeof(l->key), "%s", key);
    snprintf(l->val, sizeof(l->val), "%s", val);
}
void write_keyvalue_file(const char* path, struct key_value_file* kv) {
    FILE* f = fopen(path, "w");
    if (!f) return;
    for (int i = 0; i < kv->n; i++) {
        if (kv->lines[i].is_kv) fprintf(f, "%s=%s\n", kv->lines[i].key, kv->lines[i].val);
        else fprintf(f, "%s\n", kv->lines[i].raw);
    }
    fclose(f);
}
void free_keyvalue_file(struct key_value_file* kv) { free(kv); }
```

- [ ] **Step 4: 跑測試確認通過**

Run: `make host-keyvaluefile && tests/run_host_tests.sh`
Expected: `keyvaluefile OK`。

- [ ] **Step 5: Commit**

```bash
git add docs/multi-zone-poc/src/mzweb
git commit -m "feat(multi-zone): P7 T2 keyvaluefile 相容模組（KEY=VALUE 讀寫，非 kv 行保留）"
```

---

### Task 3: cJSON vendor＋長度版 Parse 轉接

**Files:**
- Create: `docs/multi-zone-poc/src/mzweb/cJSON.c`、`cJSON.h`（vendor，pin v1.7.18）
- Create: `docs/multi-zone-poc/src/mzweb/cjson.h`（轉接層）
- Test: `docs/multi-zone-poc/src/mzweb/tests/test_cjson.c`

**Interfaces:**
- Produces: websetsip.c 期望的 `#include "cjson.h"` 介面——`cJSON_Parse(content, content_len)`（**兩參數長度版**）、`cJSON_GetObjectItem/GetStringValue/IsString/IsNumber/IsBool/IsTrue/IsFalse/Delete`、欄位 `valueint`/`valuestring`（與 upstream ABI 一致，spec §五）。

- [ ] **Step 1: vendor upstream cJSON（pin 版本）**

```bash
cd docs/multi-zone-poc/src/mzweb
curl -fsSL -o cJSON.c https://raw.githubusercontent.com/DaveGamble/cJSON/v1.7.18/cJSON.c
curl -fsSL -o cJSON.h https://raw.githubusercontent.com/DaveGamble/cJSON/v1.7.18/cJSON.h
```

- [ ] **Step 2: 寫失敗測試**

`tests/test_cjson.c`：
```c
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "cjson.h"
int main(void) {
    const char* raw = "{\"username\":\"admin\",\"n\":7,\"b\":true}EXTRA-GARBAGE";
    /* 兩參數長度版：只吃前 33 bytes，尾隨垃圾不影響 */
    cJSON* root = cJSON_Parse(raw, 33);
    assert(root);
    assert(strcmp(cJSON_GetStringValue(cJSON_GetObjectItem(root, "username")), "admin") == 0);
    assert(cJSON_GetObjectItem(root, "n")->valueint == 7);
    assert(cJSON_IsTrue(cJSON_GetObjectItem(root, "b")));
    assert(cJSON_IsString(cJSON_GetObjectItem(root, "username")));
    cJSON_Delete(root);
    assert(cJSON_Parse("{bad", 4) == NULL);
    printf("cjson OK\n");
    return 0;
}
```
Makefile 加：`COMPAT_TEST_cjson = cJSON.c`

- [ ] **Step 3: 跑測試確認失敗**

Run: `make host-cjson`
Expected: FAIL（`cjson.h` 不存在）。

- [ ] **Step 4: 實作轉接層**

`cjson.h`：
```c
#ifndef MZWEB_CJSON_COMPAT_H
#define MZWEB_CJSON_COMPAT_H
#include "cJSON.h"
/* 原廠 SDK 的 cJSON_Parse 是 (content, content_len) 長度版；
 * upstream 同名函式是單參數版 → 以 function-like macro 攔截兩參數呼叫點。 */
#define cJSON_Parse(content, content_len) cJSON_ParseWithLength((content), (size_t)(content_len))
#endif
```
> 注意：upstream `cJSON_ParseWithLength` 對「前綴合法 JSON＋尾隨垃圾」的行為＝成功解析前綴。與原廠行為的差異風險由 Task 6/11 的線上 diff 覆蓋。

- [ ] **Step 5: 跑測試確認通過**

Run: `make host-cjson && tests/run_host_tests.sh`
Expected: `cjson OK`。

- [ ] **Step 6: Commit**

```bash
git add docs/multi-zone-poc/src/mzweb
git commit -m "feat(multi-zone): P7 T3 vendor cJSON v1.7.18＋長度版 Parse 轉接"
```

---

### Task 4: event loop（單例＋timer＋mn_now）

**Files:**
- Create: `docs/multi-zone-poc/src/mzweb/event.h`、`event.c`
- Test: `docs/multi-zone-poc/src/mzweb/tests/test_event.c`

**Interfaces:**
- Produces（websetsip.c/main.c 消費，spec §五）:
```c
struct event;                                  /* opaque，callback 參數用 */
struct event_loop { unsigned long long mn_now; /* 毫秒，loop 每輪更新 */ };
struct event_loop* get_main_event_loop(void);
void event_loop_run(struct event_loop* loop);  /* 阻塞 */
unsigned long long clock_time(void);           /* CLOCK_MONOTONIC 毫秒 */
typedef struct { void (*cb)(struct event_loop*, struct event*, int); void* arg; int interval_ms; unsigned long long fire_at; int armed; } TIMER_EVENT;
void event_timer_init(TIMER_EVENT* t, int interval_ms, void (*cb)(struct event_loop*, struct event*, int), void* arg, int oneshot);
void event_timer_start(struct event_loop* loop, TIMER_EVENT* t);
```
- Produces（webapi.c 內部消費，非 websetsip.c 介面）:
```c
typedef void (*ev_fd_cb)(struct event_loop*, int fd, void* arg);
int ev_reg_fd(struct event_loop* loop, int fd, ev_fd_cb on_readable, void* arg);
void ev_unreg_fd(struct event_loop* loop, int fd);
int event_loop_step(struct event_loop* loop, int max_wait_ms); /* 跑一輪，測試用 */
```
- 備註：websetsip.c **不**直接存取 TIMER_EVENT 成員（僅以值內嵌＋init/start；已由呼叫點分析證實），佈局自訂安全。

- [ ] **Step 1: 寫失敗測試**

`tests/test_event.c`：
```c
#include <assert.h>
#include <stdio.h>
#include "event.h"
static int fired = 0;
static void on_timer(struct event_loop* l, struct event* e, int ev) { (void)l; (void)e; (void)ev; fired = 1; }
int main(void) {
    struct event_loop* loop = get_main_event_loop();
    assert(loop == get_main_event_loop());          /* 單例 */
    unsigned long long t0 = clock_time();
    TIMER_EVENT tm;
    event_timer_init(&tm, 50, on_timer, NULL, 1);
    event_timer_start(loop, &tm);
    while (!fired) event_loop_step(loop, 10);
    assert(clock_time() - t0 >= 50);
    assert(loop->mn_now >= t0);                      /* mn_now 有更新 */
    printf("event OK\n");
    return 0;
}
```
Makefile 加：`COMPAT_TEST_event = event.c`

- [ ] **Step 2: 跑測試確認失敗**

Run: `make host-event`
Expected: FAIL（`event.h` 不存在）。

- [ ] **Step 3: 實作**

`event.h` 如 Interfaces 區塊（完整含 include guard、`#include <poll.h>` 不需—自含）。`event.c`：
```c
#include <poll.h>
#include <stddef.h>
#include <time.h>
#include "event.h"

#define EV_MAX_FDS 16
#define EV_MAX_TIMERS 8

struct ev_fd { int fd; ev_fd_cb cb; void* arg; };
static struct { struct event_loop pub; struct ev_fd fds[EV_MAX_FDS]; int nfds; TIMER_EVENT* timers[EV_MAX_TIMERS]; int ntimers; } s_loop;

unsigned long long clock_time(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (unsigned long long)ts.tv_sec * 1000ULL + ts.tv_nsec / 1000000ULL;
}
struct event_loop* get_main_event_loop(void) { s_loop.pub.mn_now = clock_time(); return &s_loop.pub; }

void event_timer_init(TIMER_EVENT* t, int interval_ms, void (*cb)(struct event_loop*, struct event*, int), void* arg, int oneshot) {
    t->cb = cb; t->arg = arg; t->interval_ms = interval_ms; t->fire_at = 0; t->armed = 0; (void)oneshot;
}
void event_timer_start(struct event_loop* loop, TIMER_EVENT* t) {
    (void)loop;
    t->fire_at = clock_time() + (unsigned long long)t->interval_ms;
    t->armed = 1;
    for (int i = 0; i < s_loop.ntimers; i++) if (s_loop.timers[i] == t) return;
    if (s_loop.ntimers < EV_MAX_TIMERS) s_loop.timers[s_loop.ntimers++] = t;
}
int ev_reg_fd(struct event_loop* loop, int fd, ev_fd_cb cb, void* arg) {
    (void)loop;
    if (s_loop.nfds >= EV_MAX_FDS) return -1;
    s_loop.fds[s_loop.nfds].fd = fd; s_loop.fds[s_loop.nfds].cb = cb; s_loop.fds[s_loop.nfds].arg = arg;
    s_loop.nfds++;
    return 0;
}
void ev_unreg_fd(struct event_loop* loop, int fd) {
    (void)loop;
    for (int i = 0; i < s_loop.nfds; i++)
        if (s_loop.fds[i].fd == fd) { s_loop.fds[i] = s_loop.fds[--s_loop.nfds]; return; }
}
int event_loop_step(struct event_loop* loop, int max_wait_ms) {
    struct pollfd pfds[EV_MAX_FDS];
    for (int i = 0; i < s_loop.nfds; i++) { pfds[i].fd = s_loop.fds[i].fd; pfds[i].events = POLLIN; pfds[i].revents = 0; }
    int n = poll(pfds, s_loop.nfds, max_wait_ms);
    loop->mn_now = clock_time();
    for (int i = 0; i < s_loop.ntimers; i++) {
        TIMER_EVENT* t = s_loop.timers[i];
        if (t->armed && loop->mn_now >= t->fire_at) { t->armed = 0; t->cb(loop, NULL, 0); }
    }
    if (n > 0) {
        /* 快照後回呼：cb 可能 ev_unreg_fd 改動陣列 */
        struct ev_fd snap[EV_MAX_FDS]; int ns = s_loop.nfds;
        for (int i = 0; i < ns; i++) snap[i] = s_loop.fds[i];
        for (int i = 0; i < ns && i < EV_MAX_FDS; i++)
            if (pfds[i].revents & (POLLIN | POLLHUP | POLLERR)) snap[i].cb(loop, snap[i].fd, snap[i].arg);
    }
    return n;
}
void event_loop_run(struct event_loop* loop) { for (;;) event_loop_step(loop, 100); }
```

- [ ] **Step 4: 跑測試確認通過**

Run: `make host-event && tests/run_host_tests.sh`
Expected: `event OK`。

- [ ] **Step 5: Commit**

```bash
git add docs/multi-zone-poc/src/mzweb
git commit -m "feat(multi-zone): P7 T4 event loop 相容模組（poll 單例＋timer＋mn_now）"
```

---

### Task 5: webapi 最小 HTTP server

**Files:**
- Create: `docs/multi-zone-poc/src/mzweb/webapi.h`、`webapi.c`
- Test: `docs/multi-zone-poc/src/mzweb/tests/test_webapi.c`（server 殼）＋ `tests/http_test.py`（客戶端斷言）

**Interfaces:**
- Produces（websetsip.c 消費；呼叫點 websetsip.c:3015 鎖定，spec §五）:
```c
#define APP_REQUEST_CMD 1
#define HBI_WEB_SERVER "SIP-Player-2024"   /* 先放此值；Task 11 baseline 擷取後比對原廠 Server: 標頭字串修正 */
#define HBI_WEB_METHOD "GET, POST"         /* 同上，依 baseline 修正 */
typedef int (*http_callback_fn)(void* client, void* http_head, int request_type, const char* content, int content_len);
void init_web_listen(int port, http_callback_fn cb, struct event_loop* loop,
                     void* buf1, int len1, void* buf2, int len2, void* buf3, int len3,
                     char** request_url, int url_count,
                     char** care_key_name, int care_count, int flag);
void get_http_url(void* http_head, char** out_url, int* out_len);
void get_http_head(void* http_head, const char* name, char** out_value, int* out_len);
void web_snd_data(void* client, const char* buffer, int len);
/* P7 內部擴充（mzweb_zones.c 消費）：回傳 method 是否為 GET（1）/POST（0）*/
int mzweb_http_is_get(void* http_head);
```
- 行為（spec §3.1）：忽略 callback 回傳值；TLS 三槽與 flag 忽略；`request_url` 白名單忽略（dispatch 在 callback 內）；callback 結束仍未 `web_snd_data` → 回 `HTTP/1.1 404 Not Found`＋`Connection: close` 後關閉；併發上限 4；URL ≤2KB、headers ≤8KB、body ≤32KB、idle 30s；`SIGPIPE` ignore＋`MSG_NOSIGNAL`。

- [ ] **Step 1: 寫測試（server 殼＋python 斷言）**

`tests/test_webapi.c`（監聽 18080，echo 式 callback）：
```c
#include <stdio.h>
#include <string.h>
#include "event.h"
#include "webapi.h"
static int cb(void* client, void* http_head, int type, const char* content, int content_len) {
    char* url; int ulen;
    get_http_url(http_head, &url, &ulen);
    if (type == APP_REQUEST_CMD && ulen == 5 && strncmp("/echo", url, ulen) == 0) {
        char* auth; int alen;
        get_http_head(http_head, "Authorization", &auth, &alen);
        char body[512];
        int blen = snprintf(body, sizeof(body), "{\"auth_len\":%d,\"body_len\":%d,\"is_get\":%d}",
                            alen, content_len, mzweb_http_is_get(http_head));
        char resp[1024];
        int rlen = snprintf(resp, sizeof(resp),
            "HTTP/1.1 200 OK\r\nServer: %s\r\nContent-Type: application/json\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s",
            HBI_WEB_SERVER, blen, body);
        web_snd_data(client, resp, rlen);
    }
    /* 未知路由：不送 → webapi 應自動 404 */
    return 0;
}
int main(void) {
    struct event_loop* loop = get_main_event_loop();
    init_web_listen(18080, cb, loop, NULL, 0, NULL, 0, NULL, 0, NULL, 0, NULL, 0, 0);
    printf("listening 18080\n");
    fflush(stdout);
    event_loop_run(loop);
    return 0;
}
```
`tests/http_test.py`：
```python
import subprocess, time, urllib.request, urllib.error, socket, json, sys
p = subprocess.Popen(["build/test_webapi"])
time.sleep(0.5)
try:
    # 1) 正常 POST＋Authorization
    req = urllib.request.Request("http://127.0.0.1:18080/echo", data=b'{"x":1}',
                                 headers={"Authorization": "Bearer abcdef"})
    r = json.loads(urllib.request.urlopen(req, timeout=5).read())
    assert r == {"auth_len": 13, "body_len": 7, "is_get": 0}, r
    # 2) GET
    r = json.loads(urllib.request.urlopen("http://127.0.0.1:18080/echo", timeout=5).read())
    assert r["is_get"] == 1 and r["auth_len"] == 0, r
    # 3) 未知路由 → 404
    try:
        urllib.request.urlopen("http://127.0.0.1:18080/nope", timeout=5)
        raise AssertionError("expected 404")
    except urllib.error.HTTPError as e:
        assert e.code == 404
    # 4) 超長 URL → 拒絕（連線關閉或 4xx，不 crash）
    try:
        urllib.request.urlopen("http://127.0.0.1:18080/" + "a" * 4096, timeout=5)
    except Exception:
        pass
    # 5) 客戶端斷線不殺 server（SIGPIPE）：半途關 socket 後 server 仍活著
    s = socket.create_connection(("127.0.0.1", 18080)); s.send(b"GET /echo HTTP/1.1\r\n"); s.close()
    time.sleep(0.2)
    assert p.poll() is None, "server died (SIGPIPE?)"
    # 6) server 仍能服務
    r = json.loads(urllib.request.urlopen("http://127.0.0.1:18080/echo", timeout=5).read())
    assert r["is_get"] == 1
    print("webapi OK")
finally:
    p.kill()
```
Makefile 加：`COMPAT_TEST_webapi = event.c webapi.c socketbase.c`

- [ ] **Step 2: 跑測試確認失敗**

Run: `make host-webapi`
Expected: FAIL（`webapi.h` 不存在）。

- [ ] **Step 3: 實作 webapi.c**

`webapi.c`（重點骨架——完整實作依此結構，邊界值用 Global Constraints 的常數）：
```c
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <signal.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <unistd.h>
#include "event.h"
#include "socketbase.h"
#include "webapi.h"

#define MAX_CONNS   4
#define MAX_HEADERS 8192
#define MAX_URL     2048
#define MAX_BODY    32768
#define IDLE_MS     30000

struct conn {
    int fd; int used;
    char buf[MAX_HEADERS + MAX_BODY + 1];
    int len;                    /* 已累積 bytes */
    int hdr_end;                /* \r\n\r\n 位置；0=headers 未收齊 */
    int content_len;            /* 解析出的 Content-Length（無則 0） */
    int responded;              /* web_snd_data 已被呼叫 */
    unsigned long long last_io; /* idle timeout 用 */
    /* http_head 視圖（指進 buf） */
    char* url; int url_len;
    char* auth; int auth_len;   /* Authorization 值 */
    int is_get;
};
static struct conn s_conns[MAX_CONNS];
static http_callback_fn s_cb;
static struct event_loop* s_loop;
static int s_listen_fd = -1;

static void conn_close(struct conn* c) { ev_unreg_fd(s_loop, c->fd); close_socket(c->fd); c->used = 0; }

void web_snd_data(void* client, const char* buffer, int len) {
    struct conn* c = client;
    int off = 0;
    while (off < len) {
        int n = send(c->fd, buffer + off, len - off, MSG_NOSIGNAL);
        if (n <= 0) break;
        off += n;
    }
    c->responded = 1;
    conn_close(c);
}
void get_http_url(void* http_head, char** out_url, int* out_len) {
    struct conn* c = http_head; *out_url = c->url; *out_len = c->url_len;
}
void get_http_head(void* http_head, const char* name, char** out_value, int* out_len) {
    struct conn* c = http_head;
    if (strcasecmp(name, "Authorization") == 0) { *out_value = c->auth; *out_len = c->auth_len; }
    else { *out_value = NULL; *out_len = 0; }
}
int mzweb_http_is_get(void* http_head) { return ((struct conn*)http_head)->is_get; }

/* 解析：request line（method、url）＋逐行 headers（僅擷取 Authorization、Content-Length）。
 * headers 收齊（找到 \r\n\r\n）且 body 收滿 content_len 後：
 *   填 c->url/url_len/auth/auth_len/is_get → s_cb(c, c, APP_REQUEST_CMD, body, content_len)
 *   → callback 沒 respond 就送 404 並關閉。
 * 邊界：url_len > MAX_URL、hdr 區 > MAX_HEADERS、content_len > MAX_BODY → 直接關閉。 */
static void on_conn_readable(struct event_loop* loop, int fd, void* arg) { /* …read 累積＋上述流程… */ }
static void on_listen_readable(struct event_loop* loop, int fd, void* arg) {
    int cfd = accept(fd, NULL, NULL);
    if (cfd < 0) return;
    struct conn* c = NULL;
    for (int i = 0; i < MAX_CONNS; i++) if (!s_conns[i].used) { c = &s_conns[i]; break; }
    if (!c) { close(cfd); return; }                      /* 併發上限：超額直接關 */
    memset(c, 0, sizeof(*c)); c->fd = cfd; c->used = 1; c->last_io = clock_time();
    set_no_block(cfd);
    ev_reg_fd(loop, cfd, on_conn_readable, c);
}
void init_web_listen(int port, http_callback_fn cb, struct event_loop* loop,
                     void* b1, int l1, void* b2, int l2, void* b3, int l3,
                     char** urls, int nurls, char** care, int ncare, int flag) {
    (void)b1;(void)l1;(void)b2;(void)l2;(void)b3;(void)l3;(void)urls;(void)nurls;(void)care;(void)ncare;(void)flag;
    signal(SIGPIPE, SIG_IGN);
    s_cb = cb; s_loop = loop;
    s_listen_fd = socket(AF_INET, SOCK_STREAM, 0);
    int one = 1;
    setsockopt(s_listen_fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
    struct sockaddr_in a = {0};
    a.sin_family = AF_INET; a.sin_port = htons((unsigned short)port); a.sin_addr.s_addr = INADDR_ANY;
    bind(s_listen_fd, (struct sockaddr*)&a, sizeof(a));
    listen(s_listen_fd, 8);
    set_no_block(s_listen_fd);
    ev_reg_fd(loop, s_listen_fd, on_listen_readable, NULL);
}
```
`on_conn_readable` 完整實作（累積 `recv` 至 `\r\n\r\n`；`sscanf` request line 取 method/url；逐行找 `Authorization:` 與 `Content-Length:`；idle 逾時在 `event_loop_step` 前掃描——在 `webapi.c` 內另 `ev_reg_fd` 不了 timer 就借 conn 掃描：每次 readable 檢查 `clock_time()-last_io > IDLE_MS` 即關）。**實作時把整段寫完，不留 stub。**

- [ ] **Step 4: 跑測試確認通過**

Run: `make host-webapi && tests/run_host_tests.sh`
Expected: `webapi OK`（六個斷言全過，含 404 fallback、SIGPIPE 存活）。

- [ ] **Step 5: Commit**

```bash
git add docs/multi-zone-poc/src/mzweb
git commit -m "feat(multi-zone): P7 T5 webapi 最小 HTTP server（資源邊界＋404 fallback＋SIGPIPE 防護）"
```

---

### Task 6: 整編未修改 websetsip＋容器 19 路由 smoke

**Files:**
- Modify: `docs/multi-zone-poc/src/mzweb/Makefile`（`x86-orig` target：APPSRC 不含 patch/mzweb_zones/serve_index，先編原始碼）
- Create: `docs/multi-zone-poc/src/mzweb/tests/smoke_orig.py`

**Interfaces:**
- Consumes: T1–T5 全部相容模組。
- Produces: `build/mzweb-x86-orig`＝未修改原廠碼＋相容層的可執行檔（容器內可跑）。此 task 是「相容層正確性」的整合閘門。

- [ ] **Step 1: Makefile 加 orig target**

```makefile
x86-orig:
	mkdir -p build
	cp ../../firmware-reference/websetsip.c build/websetsip-orig.c
	cp ../../firmware-reference/main.c build/main.c
	$(CC_X86) $(CFLAGS) -o build/mzweb-x86-orig build/websetsip-orig.c build/main.c $(COMPAT)
```

- [ ] **Step 2: 編譯並修到綠**

Run: `make x86-orig`
Expected: 首輪大概率有缺符號/型別衝突（如 `strcasecmp` include、GBK 註解警告）。**警告可留、錯誤修到零**——缺什麼符號回頭補進對應相容模組（並補其單元測試）。GBK 源碼編譯若遇 `\x5C` 尾字節跳脫問題，逐處確認該字串是否影響行為（spec §六風險 5）。

- [ ] **Step 3: 容器 smoke — 服務起得來、路由有反應**

`tests/smoke_orig.py`：
```python
import subprocess, time, urllib.request, urllib.error, json, sys
# fixtures：websetsip 啟動要讀 /etc/ifcfg-eth0 的 SN（缺檔會靜默不啟動，spec §五）
open("/etc/ifcfg-eth0", "w").write("SN=P7TEST\n")
# /etc/ifcfg-sip 缺檔時 init 會自建預設（admin/123456）
p = subprocess.Popen(["build/mzweb-x86-orig"])
time.sleep(1)
try:
    # 1) 登入拿 token（預設 admin/123456）
    req = urllib.request.Request("http://127.0.0.1:80/auth/login",
        data=json.dumps({"username": "admin", "password": "123456"}).encode())
    body = json.loads(urllib.request.urlopen(req, timeout=5).read())
    token = body.get("token") or body.get("data", {}).get("token")
    assert token, body
    # 2) 帶 token 的 verify
    req = urllib.request.Request("http://127.0.0.1:80/auth/verify",
        headers={"Authorization": "Bearer " + token})
    urllib.request.urlopen(req, timeout=5)
    # 3) 無 termapp 環境：打 /get/call/status 應回錯誤（E008 類）而非 crash
    try:
        urllib.request.urlopen("http://127.0.0.1:80/get/call/status", timeout=5)
    except urllib.error.HTTPError:
        pass
    time.sleep(0.2)
    assert p.poll() is None, "server died"
    print("smoke_orig OK")
finally:
    p.kill()
```
Run:
```bash
docker run --rm --platform linux/amd64 -v "$PWD":/src -w /src python:3.12-alpine python3 tests/smoke_orig.py
```
Expected: `smoke_orig OK`。若 login 回應形狀與腳本假設不符，**以實際回應修腳本斷言**（這裡在確立相容層行為基準，不是在驗證原廠 JSON 形狀——那是 Task 11 對真機 baseline 的事）。

- [ ] **Step 4: Commit**

```bash
git add docs/multi-zone-poc/src/mzweb
git commit -m "feat(multi-zone): P7 T6 原廠 websetsip 整編通過＋容器 smoke（login/verify/無 termapp 不 crash）"
```

---

### Task 7: websetsip-p7.patch＋zones 轉呼＋GET / 內嵌頁

**Files:**
- Create: `docs/multi-zone-poc/src/mzweb/websetsip-p7.patch`
- Create: `docs/multi-zone-poc/src/mzweb/mzweb_zones.c`、`mzweb_zones.h`
- Copy: `device-web/firmware-integration/serve_index.c`、`web_index_gz.h` → `docs/multi-zone-poc/src/mzweb/`
- Test: `docs/multi-zone-poc/src/mzweb/tests/test_zones.py`＋`tests/fake_mzrelay3.py`

**Interfaces:**
- Consumes: `mzweb_http_is_get(void*)`（T5）、`web_snd_data`、`get_http_head`。
- Produces:
```c
/* mzweb_zones.h */
void mzweb_forward_zones(void* client, int is_set, const char* content, int content_len);
/* serve_index.c（既有素材） */
void request_get_index(void* client);
```

- [ ] **Step 1: 寫容器測試（含 fake mzrelay3）**

`tests/fake_mzrelay3.py`（127.0.0.1:8090，zones GET 回固定 16 區 JSON、POST echo 回 success）：
```python
from http.server import BaseHTTPRequestHandler, HTTPServer
import json, sys
ZONES = {"zones": [{"zone_id": i + 1, "multicast_address": "", "multicast_port": 0,
                    "priority": 0, "enabled": False, "audio_codec": "G.722"} for i in range(16)]}
class H(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)
    def do_GET(self):
        if self.path == "/get/sip/multicast/zones": self._send(200, ZONES)
        else: self._send(404, {})
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(n)) if n else {}
        if self.path == "/set/sip/multicast/zones":
            self._send(200, {"status": "success", "echo_zones": len(body.get("zones", []))})
        else: self._send(404, {})
    def log_message(self, *a): pass
HTTPServer(("127.0.0.1", 8090), H).serve_forever()
```
`tests/test_zones.py`：
```python
import subprocess, time, urllib.request, urllib.error, json
open("/etc/ifcfg-eth0", "w").write("SN=P7TEST\n")
relay = subprocess.Popen(["python3", "tests/fake_mzrelay3.py"])
p = subprocess.Popen(["build/mzweb-x86"])
time.sleep(1)
def login():
    req = urllib.request.Request("http://127.0.0.1:80/auth/login",
        data=json.dumps({"username": "admin", "password": "123456"}).encode())
    b = json.loads(urllib.request.urlopen(req, timeout=5).read())
    return b.get("token") or b.get("data", {}).get("token")
try:
    tok = login()
    H = {"Authorization": "Bearer " + tok}
    # 1) GET zones 需 token：無 token → 4xx（A003 慣例）
    try:
        urllib.request.urlopen("http://127.0.0.1:80/get/sip/multicast/zones", timeout=5)
        raise AssertionError("expected auth error")
    except urllib.error.HTTPError:
        pass
    # 2) GET zones 帶 token → 轉呼成功，16 筆
    r = json.loads(urllib.request.urlopen(
        urllib.request.Request("http://127.0.0.1:80/get/sip/multicast/zones", headers=H), timeout=5).read())
    assert len(r["zones"]) == 16, r
    # 3) POST zones 帶 token → echo 回 16
    req = urllib.request.Request("http://127.0.0.1:80/set/sip/multicast/zones",
        data=json.dumps({"zones": [{"zone_id": i + 1} for i in range(16)]}).encode(), headers=H)
    r = json.loads(urllib.request.urlopen(req, timeout=5).read())
    assert r["status"] == "success" and r["echo_zones"] == 16, r
    # 4) 前綴碰撞：舊 /set/sip/multicast 不可誤入 zones handler（無 termapp → 舊 handler 自身錯誤即可，不得回 echo_zones）
    req = urllib.request.Request("http://127.0.0.1:80/set/sip/multicast", data=b'{}', headers=H)
    try:
        r = json.loads(urllib.request.urlopen(req, timeout=5).read())
        assert "echo_zones" not in r, "prefix collision! old route hit zones handler"
    except urllib.error.HTTPError:
        pass
    # 5) GET / → 內嵌頁（gzip HTML，Content-Encoding: gzip）
    resp = urllib.request.urlopen("http://127.0.0.1:80/", timeout=5)
    assert resp.headers.get("Content-Encoding") == "gzip" and len(resp.read()) > 1000
    # 6) mzrelay3 離線 → 503 且不 crash
    relay.kill(); time.sleep(0.3)
    try:
        urllib.request.urlopen(urllib.request.Request(
            "http://127.0.0.1:80/get/sip/multicast/zones", headers=H), timeout=10)
        raise AssertionError("expected 503")
    except urllib.error.HTTPError as e:
        assert e.code == 503, e.code
    assert p.poll() is None
    print("zones OK")
finally:
    p.kill(); relay.poll() is None and relay.kill()
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `make x86-mzweb`
Expected: FAIL（patch／mzweb_zones.c 不存在）。

- [ ] **Step 3: 實作 mzweb_zones.c（loopback HTTP 轉呼）**

```c
/* mzweb_zones.c — zones 路由轉呼 mzrelay3 (127.0.0.1:8090)。
 * 職責切分（spec §3.2）：token 驗證在 websetsip.c patch 內；本檔只轉呼與回覆。 */
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <poll.h>
#include "webapi.h"
#include "mzweb_zones.h"

#define RELAY_ADDR "127.0.0.1"
#define RELAY_PORT 8090
#define RELAY_TIMEOUT_MS 2000
#define FWD_MAX 65536

static const char* SVC_UNAVAIL =
    "HTTP/1.1 503 Service Unavailable\r\nServer: " HBI_WEB_SERVER "\r\n"
    "Content-Type: application/json\r\nContent-Length: 57\r\nConnection: close\r\n\r\n"
    "{\"status\":\"error\",\"message\":\"zones service unavailable\"}";
/* 上面 Content-Length 必須等於 body 實際長度（57 = strlen 校驗寫死前先 assert） */

static int relay_rpc(int is_set, const char* content, int content_len, char* out, int out_cap) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return -1;
    struct sockaddr_in a = {0};
    a.sin_family = AF_INET; a.sin_port = htons(RELAY_PORT);
    inet_pton(AF_INET, RELAY_ADDR, &a.sin_addr);
    struct timeval tv = { RELAY_TIMEOUT_MS / 1000, (RELAY_TIMEOUT_MS % 1000) * 1000 };
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
    if (connect(fd, (struct sockaddr*)&a, sizeof(a)) < 0) { close(fd); return -1; }
    char req[512];
    int rlen = snprintf(req, sizeof(req),
        "%s /%s/sip/multicast/zones HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: %d\r\nConnection: close\r\n\r\n",
        is_set ? "POST" : "GET", is_set ? "set" : "get", is_set ? content_len : 0);
    if (send(fd, req, rlen, MSG_NOSIGNAL) != rlen) { close(fd); return -1; }
    if (is_set && content_len > 0 && send(fd, content, content_len, MSG_NOSIGNAL) != content_len) { close(fd); return -1; }
    int total = 0, n;
    while (total < out_cap - 1 && (n = recv(fd, out + total, out_cap - 1 - total, 0)) > 0) total += n;
    close(fd);
    out[total] = 0;
    return total > 0 ? total : -1;
}

void mzweb_forward_zones(void* client, int is_set, const char* content, int content_len) {
    char* out = malloc(FWD_MAX);
    if (!out) { web_snd_data(client, SVC_UNAVAIL, (int)strlen(SVC_UNAVAIL)); return; }
    int n = relay_rpc(is_set, content, content_len, out, FWD_MAX);
    if (n <= 0) web_snd_data(client, SVC_UNAVAIL, (int)strlen(SVC_UNAVAIL));
    else web_snd_data(client, out, n);   /* mzrelay3 的完整 HTTP 回應原樣轉回 */
    free(out);
}
```
`mzweb_zones.h`：
```c
#ifndef MZWEB_ZONES_H
#define MZWEB_ZONES_H
void mzweb_forward_zones(void* client, int is_set, const char* content, int content_len);
#endif
```
並 `cp ../../../device-web/firmware-integration/serve_index.c ../../../device-web/firmware-integration/web_index_gz.h .`（讀 `serve_index.c` 確認其 include 與函式名 `request_get_index(void* client)`；若名稱不同，以實際為準並回頭修 patch）。

- [ ] **Step 4: 產 websetsip-p7.patch**

對 `build/websetsip-orig.c`（GBK 原始）修改後 `diff -u` 產 patch。**修改內容（全部 ASCII 區域，hunks 錨定英文行）**：

(a) 檔頭 include 區之後加：
```c
#include "mzweb_zones.h"
extern void request_get_index(void* client);
```
(b) `http_callback` 的 if/else 鏈**最前端**（`if (len > 0)` 之後、`/auth/login` 判斷之前）插入——**zones 加 len 全等判斷（前綴碰撞防護）、`/` 加 len==1**：
```c
			if (len == (int)strlen("/get/sip/multicast/zones") &&
				strncmp("/get/sip/multicast/zones", url, len) == 0)
			{
				if (mzweb_check_token(client, http_head) == 0)
					mzweb_forward_zones(client, 0, NULL, 0);
			}
			else
			if (len == (int)strlen("/set/sip/multicast/zones") &&
				strncmp("/set/sip/multicast/zones", url, len) == 0)
			{
				if (mzweb_check_token(client, http_head) == 0)
					mzweb_forward_zones(client, 1, content, content_len);
			}
			else
			if (len == 1 && url[0] == '/')
			{
				request_get_index(client);
			}
			else
```
(c) `http_callback` 之前加 token 檢查函式（**逐字對照 `request_verify_token_cmd` 的比對邏輯與錯誤回覆格式**——含 `- 1` 怪癖與 A002/A003 回覆；失敗時本函式自己 `web_snd_data` 錯誤回應再回傳非 0）：
```c
/* P7: zones 路由 token 檢查。比對邏輯與錯誤回覆逐字複製自 request_verify_token_cmd（含 len == strlen(token) - 1 怪癖）。 */
static int mzweb_check_token(void* client, void* http_head)
{
	char* value = NULL;
	int len = 0;
	get_http_head(http_head, "Authorization", &value, &len);
	/* …以下與 request_verify_token_cmd 相同的存在性/前綴/長度/內容/過期檢查與 A003/A002 錯誤回覆… */
}
```
（實作時把該函式寫完整：從 `request_verify_token_cmd` 原文複製比對與 snprintf 回覆區塊，僅把「驗證成功回 200」分支改為 `return 0`、各失敗分支回覆後 `return -1`。）
(d) `http_callback` 函式末尾補 `return 0;`（消 UB，spec §3.1）。
(e) `request_url[19]` → `request_url[21]`＋兩行新元素（僅文件性；webapi 忽略白名單）：
```c
	request_url[19] = "/get/sip/multicast/zones";
	request_url[20] = "/set/sip/multicast/zones";
```
＋`init_web_listen(... request_url, 21, ...)`。

產 patch：
```bash
cp ../../firmware-reference/websetsip.c /tmp/ws-orig.c
# （在 build/websetsip-orig.c 上做完上述修改後）
diff -u /tmp/ws-orig.c build/websetsip-orig.c > websetsip-p7.patch || true
```
驗 patch 可重放：`make clean && make x86-mzweb` 需成功。

- [ ] **Step 5: 跑測試確認通過**

Run:
```bash
make x86-mzweb
docker run --rm --platform linux/amd64 -v "$PWD":/src -w /src python:3.12-alpine python3 tests/test_zones.py
```
Expected: `zones OK`（六個斷言全過，特別是 #4 前綴碰撞與 #6 離線 503）。

- [ ] **Step 6: 編 arm 目標確認交叉編譯通過**

Run: `make arm-mzweb && file build/mzweb-arm`
Expected: `ELF 32-bit LSB executable, ARM, statically linked`。

- [ ] **Step 7: Commit**

```bash
git add docs/multi-zone-poc/src/mzweb
git commit -m "feat(multi-zone): P7 T7 websetsip-p7.patch＋zones loopback 轉呼＋GET / 內嵌頁（容器測試通過）"
```

---

### Task 8: mzrelay3 REST 收攏 loopback＋免 token

**Files:**
- Modify: `docs/multi-zone-poc/src/mzrelay3.c`（REST bind ~:399、`has_bearer` ~:291、usage ~:15/:375）
- Modify: `docs/multi-zone-poc/src/mzrelay3.conf.example`
- Test: 容器手測（見 Step 3）

**Interfaces:**
- Produces: `mzrelay3 <dst_grp> <dst_port> <ttl> <ifaddr> <silence_ms> <rest_port> [zones.json] [rest_bind]`——新增第 8 個可選參數 `rest_bind`（預設 `0.0.0.0` 維持 P5 相容；P7 部署帶 `127.0.0.1`）。bind 位址為 loopback 時 REST 跳過 Bearer 檢查。

- [ ] **Step 1: 修改 mzrelay3.c**

- `main()` 參數解析加 `const char* rest_bind = argc > 8 ? argv[8] : "0.0.0.0";`（依既有 argv 索引風格對齊）。
- REST listen 的 `ra.sin_addr.s_addr = INADDR_ANY;` 改 `inet_pton(AF_INET, rest_bind, &ra.sin_addr);`。
- 全域 `static int s_rest_loopback = 0;` 於 main 設 `strcmp(rest_bind, "127.0.0.1") == 0`；auth 檢查處（`has_bearer` 呼叫點）改 `if (!s_rest_loopback && !has_bearer(...)) → 401`。
- usage 字串與 `mzrelay3.conf.example` 補第 8 欄說明。

- [ ] **Step 2: 交叉編譯（arm＋x86 測試版）**

```bash
cd docs/multi-zone-poc/src
docker run --rm --platform linux/amd64 -v "$PWD":/src -w /src --entrypoint gcc muslcc/x86_64:arm-linux-musleabi -march=armv7-a -static -no-pie -fno-pie -O2 -o mzrelay3 mzrelay3.c
docker run --rm --platform linux/amd64 -v "$PWD":/src -w /src --entrypoint gcc muslcc/x86_64:x86_64-linux-musl -static -no-pie -O2 -o /tmp/mzrelay3-x86 mzrelay3.c 2>/dev/null || \
docker run --rm --platform linux/amd64 -v "$PWD":/src -w /src --entrypoint gcc muslcc/x86_64:x86_64-linux-musl -static -no-pie -O2 -o mzrelay3-x86 mzrelay3.c
```
Expected: 兩目標編譯通過。

- [ ] **Step 3: 容器行為驗證**

```bash
docker run --rm --platform linux/amd64 -v "$PWD":/src -w /src python:3.12-alpine sh -c '
  ./mzrelay3-x86 239.192.1.1 2000 1 0.0.0.0 2000 8090 /tmp/z.json 127.0.0.1 &
  sleep 1
  python3 - <<EOF
import urllib.request, json
r = json.loads(urllib.request.urlopen("http://127.0.0.1:8090/get/sip/multicast/zones", timeout=5).read())
assert "zones" in r, r
print("loopback no-token OK")
EOF'
```
Expected: `loopback no-token OK`（無 Bearer 亦可讀）。再以 `0.0.0.0` 起服務重打同請求，Expected: 401（token 檢查仍在）。

- [ ] **Step 4: Commit**

```bash
git add docs/multi-zone-poc/src/mzrelay3.c docs/multi-zone-poc/src/mzrelay3.conf.example docs/multi-zone-poc/src/mzrelay3
git commit -m "feat(multi-zone): P7 T8 mzrelay3 REST 可配置 bind＋loopback 免 token"
```

---

### Task 9: p7diff 三階段線上比對 harness

**Files:**
- Create: `docs/multi-zone-poc/src/mzweb/tests/p7diff.py`
- Test: 本機自測（對 fake server 跑）

**Interfaces:**
- Produces: `python3 p7diff.py capture <base_url> <outdir>`（打完整 test matrix、存回應）與 `python3 p7diff.py compare <dir_a> <dir_b>`（三階段比對，spec §七.1）。exit code 0＝零差異。

- [ ] **Step 1: 實作 p7diff.py**

要點（完整寫出，不留 stub）：
- **Test matrix 寫死在檔內**（來源 `docs/firmware-reference/REFERENCE.md` §二 19 條：method、path、需 token 與否、範例 payload），外加錯誤案例：無 token 打需 token 路由（A003）、壞 token（A003）、壞 JSON body（E001）、未知路由 `/nope`、超長 URL。
- `capture`：先 `/auth/login`（憑證從環境變數 `P7_USER`/`P7_PASS`，預設 admin/123456）拿 token；逐案例送出，存 `<outdir>/<case_id>.json`：`{"status": code, "headers": {...}, "body_b64": ...}`（body 以 base64 存，GBK 字節保真）。
- `compare` 三階段（spec §七.1）：
  1. 結構：status code、header key 集合、body 若為 JSON → key 集合（遞迴）。
  2. 置換動態欄位為 `"<DYN>"` 後全文比對。動態 key path 白名單寫死：`token`、`uptime`、`cpu_usage`、`memory_*`、`disk_*`、`temperature`、`Date` header、`Content-Length`（隨動態值變動）。`/system/info` 整體僅做階段 1 結構比對（popen top 時序性，spec §六風險 7）。
  3. 列出被遮罩的差異明細到 stdout 供人工確認（case id＋path＋a/b 值）。
- 差異報告：逐 case PASS/FAIL＋diff 摘要。

- [ ] **Step 2: 本機自測**

用 python 起兩個行為相同的 fake server（可重用 `fake_mzrelay3.py` 模式，回固定 JSON），`capture` 兩次 → `compare` exit 0；改其中一個 fake 的一個欄位 → `compare` 非 0 且指出 case。
Run: `python3 tests/p7diff.py --selftest`（把上述自測寫進 `--selftest` 子命令）
Expected: `selftest OK`。

- [ ] **Step 3: Commit**

```bash
git add docs/multi-zone-poc/src/mzweb/tests/p7diff.py
git commit -m "feat(multi-zone): P7 T9 p7diff 三階段線上比對 harness（19 路由 matrix＋錯誤案例）"
```

---

### Task 10: mzdeploy.sh 擴充 mzweb 子命令

**Files:**
- Modify: `docs/multi-zone-poc/src/mzdeploy.sh`

**Interfaces:**
- Consumes: `mzctl.py`（put/sh）、既有 mzdeploy 子命令結構（**先讀整個腳本**，沿用其風格與既有函式）。
- Produces: `./mzdeploy.sh mzweb-install`（備份＋安裝＋重啟 web）、`mzweb-rollback`（還原＋重啟）、`status` 擴充 mzweb 檢查。

- [ ] **Step 1: 讀現有 mzdeploy.sh，依其結構加子命令**

行為（用既有的 ssh/put helper 實作）：
```
mzweb-install:
  [ -f /etc/sipweb/sipweb.orig ] || cp /etc/sipweb/sipweb /etc/sipweb/sipweb.orig   # 首次才備份，不覆蓋
  put build/mzweb-arm → /etc/sipweb/sipweb.new
  chmod +x; mv /etc/sipweb/sipweb.new /etc/sipweb/sipweb                            # mv 原子替換
  killall sipweb 2>/dev/null; sleep 2                                               # 原廠拉起機制 respawn（若無 respawn，直接 /etc/sipweb/sipweb &）
  驗證: wget -qO- http://127.0.0.1:80/get/device/status | head -c 64
mzweb-rollback:
  cp /etc/sipweb/sipweb.orig /etc/sipweb/sipweb; reboot
status（擴充）:
  ps | grep -v grep | grep sipweb；md5 比對 /etc/sipweb/sipweb 與本地 build/mzweb-arm
```
> 裝置端 sipweb 的拉起機制（inittab respawn？rcS？）在 Task 11 Step 1 現場確認後，把正確的重啟命令寫死進腳本。

- [ ] **Step 2: 語法檢查**

Run: `sh -n docs/multi-zone-poc/src/mzdeploy.sh`
Expected: 無輸出。

- [ ] **Step 3: Commit**

```bash
git add docs/multi-zone-poc/src/mzdeploy.sh
git commit -m "feat(multi-zone): P7 T10 mzdeploy 擴充 mzweb install/rollback/status"
```

---

### Task 11: 真機驗收 A — baseline 擷取→部署→19 路由 diff→CMS

**Files:**
- Create: `docs/multi-zone-poc/p7-acceptance.md`（驗收紀錄，本 task 起逐項填）

**Interfaces:**
- Consumes: T7 `build/mzweb-arm`、T8 mzrelay3、T9 `p7diff.py`、T10 mzdeploy。

- [ ] **Step 1: 裝置現場勘查（原廠 sipweb 拉起機制＋Server 標頭）**

```bash
cd docs/multi-zone-poc/src
python3 mzctl.py sh 'cat /etc/inittab 2>/dev/null; ls /etc/init.d/; ps | grep sipweb'
curl -s -D- -o /dev/null http://192.168.0.70/get/device/status
```
記錄：sipweb 由誰拉起（把正確重啟命令回填 T10 腳本）；真實 `Server:` 標頭值（回填 T5 `HBI_WEB_SERVER`／`HBI_WEB_METHOD`，若不同→改、重編、重跑 T7 測試）。

- [ ] **Step 2: ASSUMPTION 佐證（spec §3.4-2）**

```bash
python3 mzctl.py sh 'strings /opt/termapp | grep -c set_multicast_zones || echo 0'
```
Expected: `0`（termapp 不認得該命令）。非 0 → 停下，回報使用者再議。

- [ ] **Step 3: baseline 擷取（**替換前**，必先做）**

```bash
cd mzweb
python3 tests/p7diff.py capture http://192.168.0.70 baseline/
```
Expected: 全 matrix 擷取完成（含錯誤案例）。`baseline/` 不進版控（build 產物性質，加 `.gitignore`）。

- [ ] **Step 4: 部署 mzweb＋mzrelay3（loopback 版）**

```bash
cd .. && ./mzdeploy.sh mzweb-install
# mzrelay3 更新（帶第 8 參數 127.0.0.1）＋ S21mzrelay 的啟動參數行同步加 rest_bind
python3 mzctl.py put mzrelay3 /opt/mzrelay3 && python3 mzctl.py sh '/etc/init.d/S21mzrelay restart'
```
Expected: `status` 全綠；`http://192.168.0.70/` 回內嵌頁。

- [ ] **Step 5: 19 路由 diff**

```bash
cd mzweb
python3 tests/p7diff.py capture http://192.168.0.70 mzweb-run/
python3 tests/p7diff.py compare baseline/ mzweb-run/
```
Expected: exit 0；被遮罩差異逐條人工確認並記入 `p7-acceptance.md`。**任何未預期差異＝回去修相容層，不改 baseline。**

- [ ] **Step 6: CMS 實連**

開 CMS 桌面 app 連 `.70`：登入、設備狀態、音量讀寫、SIP 設定頁、組播頁、system info。
Expected: 全功能不炸；記入驗收紀錄。

- [ ] **Step 7: Commit（驗收紀錄）**

```bash
git add docs/multi-zone-poc/p7-acceptance.md docs/multi-zone-poc/src
git commit -m "test(multi-zone): P7 T11 真機驗收 A 通過 — baseline diff 零漂移＋CMS 實連"
```

---

### Task 12: 真機驗收 B — zones §四案例＋閉環＋韌性＋reboot＋文件收尾

**Files:**
- Modify: `docs/multi-zone-poc/p7-acceptance.md`、`docs/multi-zone-poc/README.md`、`docs/組播多監聽區-自研可行性評估與PoC計畫.md`（§七里程碑表加 P7 行）
- Memory: 更新 `multi-zone-selfbuild-poc.md`

**Interfaces:**
- Consumes: T11 已部署環境。

- [ ] **Step 1: zones 路由 §四 全案例（經 :80）**

以 curl（帶 token）逐案例打 `192.168.0.70:80`，比照需求單 §四：E001 各分支（位址非 224–239 首字節、port 出界、priority 重複/出界、codec 非白名單、半成品 disabled 列）、佔位列略檢通過、正常 16 筆寫入→`GET` 讀回一致→`mzctl.py sh 'cat /opt/mzzones.json'` 落檔一致、熱套用（改區後送流驗證 re-join，重用 P5 方法）。
Expected: 全過；mzrelay3 離線案例（`killall mzrelay3` 後打 GET → 503，`S21mzrelay restart` 恢復）。

- [ ] **Step 2: device-web 真瀏覽器閉環**

瀏覽器開 `http://192.168.0.70/`（內嵌頁）：載入 16 區→改→儲存→免重啟熱套用→重新載入一致（P5 閉環改經 :80；順帶覆蓋瀏覽器多連線）。
Expected: 通過；無殘留連線（`mzctl.py sh 'netstat -tn | grep :80'` 無累積 ESTABLISHED）。

- [ ] **Step 3: 韌性**

- termapp 停止：`killall termapp` 後逐打 19 條路由 → mzweb 不 crash、錯誤回應同 baseline 對應案例（E008 類）；`reboot` 恢復。
- 高負載：本機迴圈 100+ req/min 持續 10 分鐘打混合路由（跳過 `/system/restart`），前後 `mzctl.py sh 'cat /proc/$(pidof sipweb)/status | grep VmRSS'`。
Expected: RSS 平穩（漂移 < 200KB）、零 crash。

- [ ] **Step 4: reboot 恢復**

`mzctl.py sh 'reboot'` → 等 60s → mzweb（:80）與 mzrelay3（loopback REST）自動恢復、zones 設定仍在、`GET /` 出頁。
Expected: 全部自動恢復。

- [ ] **Step 5: 文件收尾＋memory**

- `README.md`：檔案表加 mzweb/、狀態行加 P7；`評估文件` §七表加 `P7 websetsip 整合 ✅`。
- `p7-acceptance.md` 補完全部結果。
- 更新 project memory `multi-zone-selfbuild-poc.md`：P7 完成、mzweb 架構一句話、回退路徑。

- [ ] **Step 6: Commit**

```bash
git add docs/multi-zone-poc docs/組播多監聽區-自研可行性評估與PoC計畫.md
git commit -m "feat(multi-zone): P7 websetsip 整合完成 — mzweb 真機驗收全過（diff 零漂移/zones §四/閉環/韌性/reboot）"
```

---

## Self-Review 紀錄

- **Spec coverage**：§3.1 相容層→T1–T5；§3.2 最小 diff／zones／GET / →T7；§3.3 mzrelay3→T8；§3.4 偏離→T7（不寫四 key）＋T11 Step 2（ASSUMPTION 佐證）；§四建置部署→T1/T10；§六風險→T5（邊界/SIGPIPE）、T6（GBK）、T12（RSS）；§七驗收 1→T9/T11、2→T12 S1-2、3→T12 S3、4→T12 S4。無缺口。
- **Placeholder scan**：T5 `on_conn_readable` 與 T7 patch (c) 的 token 函式為「結構＋來源指示（複製 request_verify_token_cmd 原文）」——來源碼不進版控故不能貼進計畫，已給完整結構與逐字複製指令，非 TBD。
- **Type consistency**：`mzweb_forward_zones(client, is_set, content, content_len)`（T7 定義=patch 呼叫）；`mzweb_http_is_get`（T5 產、T7 測試耗）；`TIMER_EVENT`／`event_loop` 簽名 T4=T5=websetsip.c 呼叫點。一致。

/* mzio.c — IO 動作 side-car daemon（spec §5）。
 * 單執行緒 poll(2)：GPIO value fd 的 POLLPRI（sysfs edge 中斷）＋ SIGHUP/SIGTERM 旗標；
 * tail/去抖 deadline 用 poll timeout。動作 multicast_ptt = 寫 MULTICAST_TX_ENABLED
 * ＋ sip.sdk set_sip_multicast_tx（termapp 執行 TX；spec 決策 1）。
 * 其餘 action：log not implemented 跳過。edge 寫入失敗＝該腳標故障、不輪詢（spec 決策 2）。 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <time.h>
#include <errno.h>
#include <sys/stat.h>
#include "cjson.h"
#include "keyvaluefile.h"
#include "mzsdk.h"
#include "mzio_core.h"

/* --- 路徑：環境變數覆蓋（供測試/部署彈性），無則預設 --- */
static const char* mzio_gpio_root(void) { const char* v = getenv("MZIO_GPIO_ROOT"); return v != NULL ? v : "/sys/class/gpio"; }
static const char* mzio_json_path(void) { const char* v = getenv("MZIO_JSON"); return v != NULL ? v : "/opt/mzio.json"; }
static const char* mzio_ifcfg_path(void) { const char* v = getenv("MZIO_IFCFG"); return v != NULL ? v : "/etc/ifcfg-sip"; }
static const char* mzio_state_path(void) { const char* v = getenv("MZIO_STATE"); return v != NULL ? v : "/tmp/mzio_state"; }
static const char* mzio_pidfile_path(void) { const char* v = getenv("MZIO_PIDFILE"); return v != NULL ? v : "/var/run/mzio.pid"; }

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
    char atype[24];         /* 非 ptt 動作記錄用（log not implemented） */
};

#define MZIO_MAX_CHAN 6

static int gpio_lookup(int id)
{
    size_t i;
    for (i = 0; i < sizeof(s_gpio_map) / sizeof(s_gpio_map[0]); i++)
        if (s_gpio_map[i].id == id) return s_gpio_map[i].linux_num;
    return -1;
}

static long long now_ms(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

/* --- config：讀檔/驗證/預設 --- */

static char* mzio_read_file(const char* path, int* out_len)
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

static cJSON* mzio_default_config(void)
{
    static const struct { int id; const char* mode; const char* contact; const char* trig;
                          int db; const char* atype; const char* aparam; }
    defs[6] = {
        { 1, "disabled", "NO", "edge",  30, "hangup",        ""    },
        { 2, "input",    "NO", "level", 30, "multicast_ptt", "300" },
        { 3, "disabled", "NO", "edge",  30, "hangup",        ""    },
        { 4, "disabled", "NO", "edge",  30, "hangup",        ""    },
        { 5, "disabled", "NO", "edge",  30, "hangup",        ""    },
        { 6, "disabled", "NO", "edge",  30, "hangup",        ""    },
    };
    cJSON* arr = cJSON_CreateArray();
    int i;
    for (i = 0; i < 6; i++)
    {
        cJSON* row = cJSON_CreateObject();
        cJSON* act;
        cJSON_AddNumberToObject(row, "id", defs[i].id);
        cJSON_AddStringToObject(row, "mode", defs[i].mode);
        cJSON_AddStringToObject(row, "contact", defs[i].contact);
        cJSON_AddStringToObject(row, "trigger", defs[i].trig);
        cJSON_AddNumberToObject(row, "debounce_ms", defs[i].db);
        act = cJSON_AddObjectToObject(row, "action");
        cJSON_AddStringToObject(act, "type", defs[i].atype);
        cJSON_AddStringToObject(act, "param", defs[i].aparam);
        cJSON_AddItemToArray(arr, row);
    }
    return arr;
}

/* 精簡版驗證（與 mzweb_txio.c 的 mztxio_validate_io_config 同規則，僅檢查用得到的欄；
 * 不 #include mzweb_txio.c——避免拖入 web 依賴）。 */
static const char* s_mode_vals[]    = { "input", "output", "disabled", NULL };
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

static int mzio_validate_row(cJSON* row)
{
    cJSON* id = cJSON_GetObjectItem(row, "id");
    cJSON* mode = cJSON_GetObjectItem(row, "mode");
    cJSON* trigger = cJSON_GetObjectItem(row, "trigger");
    cJSON* debounce = cJSON_GetObjectItem(row, "debounce_ms");
    cJSON* action = cJSON_GetObjectItem(row, "action");
    cJSON* atype;
    if (id == NULL || mode == NULL || trigger == NULL || debounce == NULL || action == NULL) return 0;
    if (!cJSON_IsNumber(id) || !cJSON_IsString(mode) || !cJSON_IsString(trigger) ||
        !cJSON_IsNumber(debounce) || !cJSON_IsObject(action)) return 0;
    if (id->valueint < 1 || id->valueint > 6) return 0;
    if (!in_list(cJSON_GetStringValue(mode), s_mode_vals)) return 0;
    if (!in_list(cJSON_GetStringValue(trigger), s_trigger_vals)) return 0;
    if (debounce->valueint < 0 || debounce->valueint > 200) return 0;
    atype = cJSON_GetObjectItem(action, "type");
    if (atype == NULL || !cJSON_IsString(atype)) return 0;
    if (!in_list(cJSON_GetStringValue(atype), s_action_vals)) return 0;
    return 1;
}

/* Minor 對抗審查修復：web 端（mzweb_txio.c）用 seen[] 拒收重複 id，daemon 端原本沒查，
 * 手改 /opt/mzio.json 塞兩列同 id 會對同一 gpio 開兩個 fd、雙 dispatch。此處鏡像同規則，
 * 視為壞值走既有 fail-closed 路徑（啟動 exit 1；SIGHUP 保留舊 config）。 */
static int mzio_validate_array(cJSON* arr)
{
    cJSON* row;
    int seen[7] = { 0 };   /* index 1..6 對應 id */
    if (arr == NULL || !cJSON_IsArray(arr)) return 0;
    cJSON_ArrayForEach(row, arr)
    {
        cJSON* id;
        if (!mzio_validate_row(row)) return 0;
        id = cJSON_GetObjectItem(row, "id");
        if (id->valueint >= 1 && id->valueint <= 6)
        {
            if (seen[id->valueint]) return 0;
            seen[id->valueint] = 1;
        }
    }
    return 1;
}

/* 讀 config → *out_arr（caller 擁有）。回傳 0=可用（含 fallback 到預設）、-1=壞值拒收
 * （is_reload=0：啟動模式，caller 應 exit 1；is_reload=1：SIGHUP 模式，caller 保留舊 config）。 */
static int mzio_load_config(cJSON** out_arr, int is_reload)
{
    int len = 0;
    char* buf = mzio_read_file(mzio_json_path(), &len);
    cJSON* root;
    cJSON* arr;
    if (buf == NULL)
    {
        if (!is_reload) fprintf(stderr, "mzio: no config at %s, using defaults\n", mzio_json_path());
        *out_arr = mzio_default_config();
        return 0;
    }
    root = cJSON_Parse(buf, len);
    free(buf);
    if (root == NULL)
    {
        fprintf(stderr, "mzio: bad JSON in %s, falling back to defaults\n", mzio_json_path());
        *out_arr = mzio_default_config();
        return 0;
    }
    arr = cJSON_DetachItemFromObject(root, "io_config");
    cJSON_Delete(root);
    if (arr == NULL || !cJSON_IsArray(arr))
    {
        if (arr != NULL) cJSON_Delete(arr);
        fprintf(stderr, "mzio: no io_config array in %s, falling back to defaults\n", mzio_json_path());
        *out_arr = mzio_default_config();
        return 0;
    }
    if (!mzio_validate_array(arr))
    {
        cJSON_Delete(arr);
        fprintf(stderr, "mzio: %s config invalid, %s\n", mzio_json_path(),
                is_reload ? "keeping previous config" : "refusing to start");
        return -1;
    }
    *out_arr = arr;
    return 0;
}

/* --- 動作分派：multicast_ptt --- */

static void set_tx_enabled(int on)
{
    struct key_value_file* kv = read_keyvalue_file(mzio_ifcfg_path());
    const char* cur;
    const char* want = on ? "true" : "false";
    if (kv == NULL) { fprintf(stderr, "mzio: cannot read ifcfg\n"); return; }
    if (on)
    {
        /* MTX-06 迴授防護：啟用發送前，TX 目標若與 RX 群組（位址+埠）完全相同，
         * 拒絕啟動——避免 PTT 按下後自我迴授。只擋啟用，停止（on==0）不受影響。 */
        const char* rx_a = find_key_value(kv, "MULTICAST_ADDRESS");
        const char* rx_p = find_key_value(kv, "MULTICAST_PORT");
        const char* tx_a = find_key_value(kv, "MULTICAST_TX_ADDRESS");
        const char* tx_p = find_key_value(kv, "MULTICAST_TX_PORT");
        if (mzio_tx_equals_rx(rx_a, rx_p, tx_a, tx_p))
        {
            fprintf(stderr, "mzio: TX target equals RX group, refusing to start (MTX-06)\n");
            free_keyvalue_file(kv);
            return;
        }
    }
    cur = find_key_value(kv, "MULTICAST_TX_ENABLED");
    if (cur == NULL) add_key_value(kv, "MULTICAST_TX_ENABLED", want);
    else if (strcmp(cur, want) == 0) { free_keyvalue_file(kv); return; } /* 已是目標值：不寫不通知 */
    else modify_key_value(kv, "MULTICAST_TX_ENABLED", want);
    /* M-1 對抗審查修復：原子寫失敗（fsync/rename 等）不得繼續通知 sip.sdk——設定檔
     * 仍是舊值，通知只會讓 termapp 誤以為已切換，狀態不一致。 */
    if (write_keyvalue_file(mzio_ifcfg_path(), kv) != 0)
    {
        fprintf(stderr, "mzio: ERROR write ifcfg failed, not notifying sip.sdk\n");
        free_keyvalue_file(kv);
        return;
    }
    free_keyvalue_file(kv);
    if (mzsdk_send("{\"command\": \"set_sip_multicast_tx\",\"cseq\": 1}\r\n\r\n") != 0)
    {
        usleep(200000);   /* 重試 1 次（spec §5.4） */
        if (mzsdk_send("{\"command\": \"set_sip_multicast_tx\",\"cseq\": 1}\r\n\r\n") != 0)
            fprintf(stderr, "mzio: sip.sdk notify failed\n");
    }
}

static void dispatch_act(struct chan* ch, enum mzio_act act)
{
    if (act == MZIO_ACT_NONE) return;
    if (!ch->is_ptt)
    {
        fprintf(stderr, "mzio: action %s not implemented\n", ch->atype);
        return;
    }
    if (act == MZIO_ACT_START_TX) set_tx_enabled(1);
    else if (act == MZIO_ACT_STOP_TX) set_tx_enabled(0);
}

/* --- GPIO sysfs 佈建 --- */

static int gpio_write_str(const char* path, const char* val)
{
    int fd = open(path, O_WRONLY);
    ssize_t n;
    size_t len = strlen(val);
    if (fd < 0) return -1;
    n = write(fd, val, len);
    close(fd);
    return (n == (ssize_t)len) ? 0 : -1;
}

/* export → direction=in → edge=both → open value(RDONLY) → 清 pending 中斷。
 * edge 寫失敗＝該腳標故障不輪詢：回傳 -1。 */
static int gpio_setup(int linux_num)
{
    char path[160];
    char buf[16];
    struct stat st;
    int fd;
    char c;

    snprintf(path, sizeof(path), "%s/gpio%d", mzio_gpio_root(), linux_num);
    if (stat(path, &st) != 0)
    {
        char epath[160];
        snprintf(epath, sizeof(epath), "%s/export", mzio_gpio_root());
        snprintf(buf, sizeof(buf), "%d", linux_num);
        gpio_write_str(epath, buf); /* EBUSY/已存在容忍：不檢查結果，下面 direction 會驗證真正可用性 */
    }

    snprintf(path, sizeof(path), "%s/gpio%d/direction", mzio_gpio_root(), linux_num);
    if (gpio_write_str(path, "in") != 0)
    {
        fprintf(stderr, "mzio: gpio%d direction unsupported, channel DISABLED\n", linux_num);
        return -1;
    }

    snprintf(path, sizeof(path), "%s/gpio%d/edge", mzio_gpio_root(), linux_num);
    if (gpio_write_str(path, "both") != 0)
    {
        fprintf(stderr, "mzio: gpio%d edge unsupported, channel DISABLED\n", linux_num);
        return -1;
    }

    snprintf(path, sizeof(path), "%s/gpio%d/value", mzio_gpio_root(), linux_num);
    fd = open(path, O_RDONLY);
    if (fd < 0)
    {
        fprintf(stderr, "mzio: gpio%d value open failed, channel DISABLED\n", linux_num);
        return -1;
    }
    lseek(fd, 0, SEEK_SET);
    read(fd, &c, 1); /* 清 pending 中斷 */
    return fd;
}

/* --- chans 組裝（啟動＋SIGHUP 共用） --- */

static int build_chans(cJSON* arr, struct chan* chans, int max)
{
    cJSON* row;
    int n = 0;
    cJSON_ArrayForEach(row, arr)
    {
        cJSON* idj;
        cJSON* mode;
        cJSON* contact;
        cJSON* debounce;
        cJSON* action;
        int id;
        int linux_num;
        int invert;
        int debounce_ms;
        int tail_ms = 0;
        int is_ptt = 0;
        const char* atype = NULL;

        if (n >= max) break;
        idj = cJSON_GetObjectItem(row, "id");
        mode = cJSON_GetObjectItem(row, "mode");
        if (idj == NULL || mode == NULL) continue;
        if (cJSON_GetStringValue(mode) == NULL || strcmp(cJSON_GetStringValue(mode), "input") != 0) continue;

        id = idj->valueint;
        linux_num = gpio_lookup(id);
        if (linux_num < 0) continue; /* 未對映 id：即使 config 標 input 也跳過 */

        contact = cJSON_GetObjectItem(row, "contact");
        debounce = cJSON_GetObjectItem(row, "debounce_ms");
        action = cJSON_GetObjectItem(row, "action");
        invert = (contact != NULL && cJSON_GetStringValue(contact) != NULL &&
                  strcmp(cJSON_GetStringValue(contact), "NC") == 0) ? 1 : 0;
        debounce_ms = (debounce != NULL) ? debounce->valueint : 30;

        if (action != NULL)
        {
            cJSON* atypej = cJSON_GetObjectItem(action, "type");
            cJSON* aparamj = cJSON_GetObjectItem(action, "param");
            atype = cJSON_GetStringValue(atypej);
            if (atype != NULL && strcmp(atype, "multicast_ptt") == 0)
            {
                is_ptt = 1;
                if (aparamj != NULL && cJSON_GetStringValue(aparamj) != NULL)
                {
                    /* M-2 對抗審查修復：daemon 對「手改 /opt/mzio.json」比 web 端寬容——
                     * 不拒收，但超界值 clamp 回預設 300ms 並告警，避免 atoi 失控值造成
                     * 失控去抖窗（web 端走 mztxio_validate_io_config 是嚴格拒收）。 */
                    const char* pstr = cJSON_GetStringValue(aparamj);
                    char* endptr = NULL;
                    long pval = strtol(pstr, &endptr, 10);
                    if (endptr == NULL || *endptr != 0 || pval < 0 || pval > 10000)
                    {
                        fprintf(stderr, "mzio: io%d action.param '%s' out of range, using default 300\n", id, pstr);
                        tail_ms = 300;
                    }
                    else
                    {
                        tail_ms = (int)pval;
                    }
                }
                /* I3 對抗審查修復：mzio_sm 只實作 level 語意（去抖後穩定即視為按住）。
                 * long_press/edge 目前會被當 level 處理，行為與宣告不符，需明確告警而非
                 * 靜默退化——v1 仍放行運作（web 端 schema 允許這些 trigger 值）。 */
                {
                    cJSON* trigj = cJSON_GetObjectItem(row, "trigger");
                    const char* trig = cJSON_GetStringValue(trigj);
                    if (trig != NULL && strcmp(trig, "level") != 0)
                        fprintf(stderr, "mzio: io%d trigger '%s' not implemented for multicast_ptt, treating as level\n",
                                id, trig);
                }
            }
        }

        chans[n].id = id;
        chans[n].linux_num = linux_num;
        chans[n].tail_ms = tail_ms;
        chans[n].is_ptt = is_ptt;
        chans[n].last_stable = 0;
        chans[n].atype[0] = 0;
        if (atype != NULL) { strncpy(chans[n].atype, atype, sizeof(chans[n].atype) - 1); }
        mzio_sm_init(&chans[n].sm, debounce_ms, tail_ms, invert);
        chans[n].fd = gpio_setup(linux_num);
        n++;
    }
    return n;
}

/* --- state 檔（tmp+rename；僅啟用腳；值=邏輯 pressed） --- */

static void write_state(struct chan* chans, int n)
{
    char final_path[256];
    char tmp_path[256];
    FILE* f;
    int i;
    int wrote = 0;
    snprintf(final_path, sizeof(final_path), "%s", mzio_state_path());
    snprintf(tmp_path, sizeof(tmp_path), "%s.tmp", final_path);
    f = fopen(tmp_path, "w");
    if (f == NULL) { fprintf(stderr, "mzio: cannot write state\n"); return; }
    fprintf(f, "{");
    for (i = 0; i < n; i++)
    {
        fprintf(f, "%s\"%d\":%d", wrote ? "," : "", chans[i].id, chans[i].last_stable);
        wrote = 1;
    }
    fprintf(f, "}");
    fclose(f);
    rename(tmp_path, final_path);
}

/* --- -t 組態自檢：不碰 GPIO 不開 socket --- */

static int selftest(void)
{
    cJSON* arr;
    cJSON* row;
    int enabled = 0;

    if (mzio_load_config(&arr, 0) != 0) return 1;

    cJSON_ArrayForEach(row, arr)
    {
        cJSON* idj = cJSON_GetObjectItem(row, "id");
        cJSON* modej = cJSON_GetObjectItem(row, "mode");
        int id = (idj != NULL) ? idj->valueint : 0;
        const char* mode = cJSON_GetStringValue(modej);
        int linux_num = gpio_lookup(id);

        if (linux_num < 0) { printf("io%d -> unmapped\n", id); continue; }
        if (mode != NULL && strcmp(mode, "input") == 0)
        {
            printf("io%d -> gpio%d (enabled)\n", id, linux_num);
            enabled++;
        }
        else
        {
            printf("io%d -> gpio%d (disabled)\n", id, linux_num);
        }
    }
    printf("mzio: %d enabled channel(s)\n", enabled);
    cJSON_Delete(arr);
    return 0;
}

/* --- 訊號 --- */

static volatile sig_atomic_t g_reload = 0;
static volatile sig_atomic_t g_stop = 0;

static void on_sighup(int sig) { (void)sig; g_reload = 1; }
static void on_sigterm(int sig) { (void)sig; g_stop = 1; }

int main(int argc, char** argv)
{
    struct chan chans[MZIO_MAX_CHAN];
    int n;
    int i;
    cJSON* arr;

    /* H-2 對抗審查修復：mzsdk_send 走 UNIX stream socket，若 sip.sdk 端已關閉讀端，
     * 寫入會產生 SIGPIPE，預設處置終止行程——daemon 不能因對端狀態被殺死。忽略後
     * send() 走 MSG_NOSIGNAL 的錯誤回傳路徑即可（見 mzsdk.c）。 */
    signal(SIGPIPE, SIG_IGN);

    if (argc > 1 && strcmp(argv[1], "-t") == 0) return selftest();

    if (mzio_load_config(&arr, 0) != 0) return 1;
    n = build_chans(arr, chans, MZIO_MAX_CHAN);
    cJSON_Delete(arr);

    /* 開機歸零（spec §5.4）：有 ptt 綁定且現殘留 ENABLED=true → 清零，避免孤兒推流 */
    {
        int any_ptt = 0;
        for (i = 0; i < n; i++) if (chans[i].is_ptt) any_ptt = 1;
        if (any_ptt)
        {
            struct key_value_file* kv = read_keyvalue_file(mzio_ifcfg_path());
            if (kv != NULL)
            {
                const char* cur = find_key_value(kv, "MULTICAST_TX_ENABLED");
                if (cur != NULL && strcmp(cur, "true") == 0) set_tx_enabled(0);
                free_keyvalue_file(kv);
            }
        }
    }

    signal(SIGHUP, on_sighup);
    signal(SIGTERM, on_sigterm);
    signal(SIGINT, on_sigterm);

    {
        FILE* pf = fopen(mzio_pidfile_path(), "w");
        if (pf != NULL) { fprintf(pf, "%d\n", (int)getpid()); fclose(pf); }
    }

    while (!g_stop)
    {
        struct pollfd pfds[MZIO_MAX_CHAN];
        int npoll = 0;
        long long mindl = -1;
        long long t;
        int timeout;
        int pr;
        int changed = 0;
        int pi;

        if (g_reload)
        {
            cJSON* newarr;
            g_reload = 0;
            /* C1 對抗審查修復：重建 chans 前先掃描舊 sm，任一 tx_on（按住中或 tail 未到期）
             * 就先停 TX，語意比照 SIGTERM 退出路徑（下方 564-567 行）。否則 build_chans
             * 對 sm 重新 init 會把 tx_on 歸零、但 MULTICAST_TX_ENABLED 已寫 true 且 termapp
             * 仍在推流，造成孤兒麥克風廣播（真機才會觸發：按住 PTT 中送 SIGHUP → 放開 →
             * 需確認 TX 已停，容器無 sysfs edge 無法自動化覆蓋此路徑）。 */
            for (i = 0; i < n; i++)
            {
                if (chans[i].sm.tx_on)
                {
                    set_tx_enabled(0);
                    fprintf(stderr, "mzio: SIGHUP reload while io%d TX active, stopping TX first\n", chans[i].id);
                }
            }
            if (mzio_load_config(&newarr, 1) == 0)
            {
                for (i = 0; i < n; i++) if (chans[i].fd >= 0) close(chans[i].fd);
                n = build_chans(newarr, chans, MZIO_MAX_CHAN);
                cJSON_Delete(newarr);
            }
            /* else：保留舊 config（已在 mzio_load_config 內 log） */
        }

        t = now_ms();
        for (i = 0; i < n; i++)
        {
            long long dl;
            if (chans[i].fd >= 0)
            {
                pfds[npoll].fd = chans[i].fd;
                pfds[npoll].events = POLLPRI | POLLERR;
                pfds[npoll].revents = 0;
                npoll++;
            }
            dl = mzio_sm_next_deadline(&chans[i].sm);
            if (dl >= 0 && (mindl < 0 || dl < mindl)) mindl = dl;
        }
        timeout = -1;
        if (mindl >= 0)
        {
            long long d = mindl - t;
            timeout = d < 0 ? 0 : (int)d;
        }

        pr = poll(pfds, (nfds_t)npoll, timeout);
        if (pr < 0)
        {
            if (errno == EINTR) continue;
            break;
        }

        t = now_ms();
        pi = 0;
        for (i = 0; i < n; i++)
        {
            if (chans[i].fd < 0) continue;
            if (pfds[pi].revents & (POLLPRI | POLLERR))
            {
                char c;
                lseek(chans[i].fd, 0, SEEK_SET);
                if (read(chans[i].fd, &c, 1) == 1)
                {
                    int raw = (c == '0') ? 0 : 1;
                    int prev = chans[i].sm.stable_pressed;
                    enum mzio_act act = mzio_sm_sample(&chans[i].sm, raw, t);
                    dispatch_act(&chans[i], act);
                    if (chans[i].sm.stable_pressed != prev) { chans[i].last_stable = chans[i].sm.stable_pressed; changed = 1; }
                }
            }
            pi++;
        }

        /* 去抖窗到期需重讀確認；否則單純 tick（tail deadline） */
        for (i = 0; i < n; i++)
        {
            int prev = chans[i].sm.stable_pressed;
            enum mzio_act act;
            if (chans[i].fd >= 0 && chans[i].sm.cand_since != 0 &&
                t - chans[i].sm.cand_since >= chans[i].sm.debounce_ms)
            {
                char c;
                lseek(chans[i].fd, 0, SEEK_SET);
                if (read(chans[i].fd, &c, 1) == 1)
                {
                    int raw = (c == '0') ? 0 : 1;
                    act = mzio_sm_sample(&chans[i].sm, raw, t);
                    dispatch_act(&chans[i], act);
                }
                else act = MZIO_ACT_NONE;
            }
            else
            {
                act = mzio_sm_tick(&chans[i].sm, t);
                dispatch_act(&chans[i], act);
            }
            if (chans[i].sm.stable_pressed != prev) { chans[i].last_stable = chans[i].sm.stable_pressed; changed = 1; }
        }

        if (changed) write_state(chans, n);
    }

    /* 退出：先停任何在送的 TX，不留孤兒推流 */
    for (i = 0; i < n; i++)
    {
        if (chans[i].sm.tx_on) { set_tx_enabled(0); break; }
    }
    for (i = 0; i < n; i++) if (chans[i].fd >= 0) close(chans[i].fd);
    unlink(mzio_pidfile_path());
    return 0;
}

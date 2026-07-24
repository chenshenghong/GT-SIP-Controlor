#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
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
    if (!kv) { fclose(f); return NULL; }
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
    if (!kv) return NULL;   /* 檔案不存在時 read_keyvalue_file 回 NULL；呼叫端漏檢查也不崩潰 */
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
    if (!kv) return;
    if (kv->n >= KV_MAX_LINES) return;
    struct kv_line* l = &kv->lines[kv->n++];
    l->is_kv = 1;
    snprintf(l->key, sizeof(l->key), "%s", key);
    snprintf(l->val, sizeof(l->val), "%s", val);
}
int write_keyvalue_file(const char* path, struct key_value_file* kv) {
    /* 原子寫：tmp+fflush+fsync+fclose+rename，避免掉電窗截斷/毀損整份設定檔
     * （PTT 熱路徑每按放各寫本檔 2 次；同範式見 mzweb_txio.c 寫 mzio.json）。
     * M-1 對抗審查修復：fwrite/fflush/fsync/fclose/rename 任一失敗即視為整體失敗——
     * 關檔、unlink tmp、保留原檔不動、回傳 -1，呼叫端不得誤以為已落盤。 */
    char tmp_path[1024];
    FILE* f;
    int err = 0;
    snprintf(tmp_path, sizeof(tmp_path), "%s.tmp", path);
    f = fopen(tmp_path, "w");
    if (!f) return -1;
    for (int i = 0; i < kv->n; i++) {
        int wr;
        if (kv->lines[i].is_kv) wr = fprintf(f, "%s=%s\n", kv->lines[i].key, kv->lines[i].val);
        else wr = fprintf(f, "%s\n", kv->lines[i].raw);
        if (wr < 0) { err = 1; break; }
    }
    if (!err && fflush(f) != 0) err = 1;
    if (!err && fsync(fileno(f)) != 0) err = 1;
    if (fclose(f) != 0) err = 1;
    if (err) {
        fprintf(stderr, "keyvaluefile: write %s failed, keeping original\n", tmp_path);
        unlink(tmp_path);
        return -1;
    }
    if (rename(tmp_path, path) != 0) {
        fprintf(stderr, "keyvaluefile: rename %s -> %s failed\n", tmp_path, path);
        unlink(tmp_path);
        return -1;
    }
    return 0;
}
void free_keyvalue_file(struct key_value_file* kv) { free(kv); }

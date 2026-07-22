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

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

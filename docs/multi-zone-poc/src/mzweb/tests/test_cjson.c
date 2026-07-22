#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "cjson.h"
int main(void) {
    const char* raw = "{\"username\":\"admin\",\"n\":7,\"b\":true}EXTRA-GARBAGE";
    /* 兩參數長度版：只吃前 35 bytes（"{...true}" 剛好結束於 index 34），尾隨垃圾不影響 */
    cJSON* root = cJSON_Parse(raw, 35);
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

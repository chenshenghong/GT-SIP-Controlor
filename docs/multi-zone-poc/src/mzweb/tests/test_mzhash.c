#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "mzhash.h"
int main(void){
    char h[128]; mzhash_make("123456",h,sizeof(h));
    assert(strncmp(h,"sha256$",7)==0);
    assert(mzhash_verify("123456",h)==1);
    assert(mzhash_verify("wrong",h)==0);
    assert(mzhash_verify("123456","123456")==1);        /* 舊明文相容 */
    assert(mzhash_is_legacy("123456")==1);
    assert(mzhash_is_legacy(h)==0);

    /* fail-closed 契約：mzhash_make 任何提前失敗路徑（含 password==NULL，
     * 與 salt/DRBG 失敗共用同一組 "out[0]=0; ...; return;" 程式碼形狀）都必須
     * 讓 out 落回空字串，絕不能是半成品/垃圾值——login 端（request_login_cmd）
     * 靠這個「out 為空即代表產雜湊失敗」的契約來決定要不要跳過本次遷移，
     * 若這裡沒有 fail-closed，login 端的 guard 也擋不住帳號被鎖死。
     * 真實 ctr_drbg 失敗難在容器內觸發，故用同一 return 路徑的 NULL 密碼分支代打。 */
    memset(h, 'X', sizeof(h));
    mzhash_make(NULL, h, sizeof(h));
    assert(h[0] == '\0');

    printf("mzhash OK\n");
    return 0;
}

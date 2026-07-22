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
    printf("mzhash OK\n");
    return 0;
}

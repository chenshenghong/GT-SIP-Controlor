#ifndef MZSDK_H
#define MZSDK_H
/* sip.sdk（termapp Unix socket 控制口）指令傳送。成功 0、失敗 -1。
 * 語意照原廠 websetsip.c snd_cmd_to_sip_svr：非阻塞 connect + poll 1s，送出後
 * 等回覆 1s（回覆內容不解析，只當送達確認；>4 bytes 視為成功）。 */
int mzsdk_send(const char* cmd);
#endif

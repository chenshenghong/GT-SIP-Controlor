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

#!/usr/bin/env python3
"""T6 (S-T6) SEC-09 + FW-01/02: request_get_device_status / request_get_sip_config
改用 cJSON 建構後的驗證。

三件事：
  1) FW-02：/get/device/status 回應為合法 JSON（json.loads 直接過，不需 cleanDirtyJSON），
     device_info/network_info 為 root 同層（不巢狀在 sip_status 內）。
  2) FW-01：broadcast_volume key 正確收尾（原廠 bug 是 `"broadcast_volume` 缺右引號）。
  3) SEC-09：cJSON 自動 escape —— 種一個含 `"` 與 `\\` 的 SIP 帳號（user_id），/get/sip/config
     仍回合法 JSON 且該欄位原樣可還原；同時種一個含 GBK 高位元組（中文）的 MODEL 值，驗證
     cJSON 不會把 GBK 高位元組 escape 成 \\uXXXX 或弄壞位元組 —— body 以 GBK decode 後中文不
     亂碼。
     注意：password 欄自 SEC-02（S-T7）起已恆遮蔽為 "********"（cJSON_AddStringToObject 寫死，
     不讀 PRIMARY_PASSWORD），故不能再拿密碼當 escape 驗證載體 —— 改用同樣經
     cJSON_AddStringToObject 輸出、未被遮蔽、且可由 config 控制的 user_id（對應
     PRIMARY_USER_ID）。
"""
import subprocess, time, urllib.request, urllib.error, json, re, sys

# --- fixtures ---------------------------------------------------------------
open("/etc/ifcfg-eth0", "w").write("SN=P7TEST\n")

# GBK 編碼的中文型號字串（"深圳測試機"），逐位元組寫入 ifcfg-sip，
# 模擬設定值本身就是 GBK 位元組（非 UTF-8）。
MODEL_GBK = "深圳測試機".encode("gbk")
# SEC-09 escape 驗證用 SIP 密碼：password 欄現恆遮蔽（SEC-02），這裡種含特殊字元的值只是
# 順便驗證「就算密碼含特殊字元，遮蔽輸出仍恆為 ********、不會被拿去 escape 或洩漏」。
RAW_PASSWORD = 'p@"ss\\word'
# SEC-09 escape 驗證真正載體：user_id 欄未被遮蔽、經 cJSON_AddStringToObject 輸出，
# 含一個雙引號與一個反斜線 —— 若 escape 壞掉，/get/sip/config 回應會變成不合法 JSON
# 或 json.loads 後此欄位值 round-trip 不回原值。
RAW_USER_ID = 'usr"a\\b'
assert '"' in RAW_USER_ID and "\\" in RAW_USER_ID, "RAW_USER_ID 測試載體本身必須含特殊字元才有鑑別力"

with open("/etc/ifcfg-sip", "wb") as f:
    f.write(b"WEB_USER=admin\n")
    f.write(b"WEB_PASSWORD=123456\n")
    f.write(b"WEB_PORT=80\n")
    f.write(b"CAP_VOL=80\n")
    f.write(b"PLAY_VOL=75\n")
    f.write(b"MODEL=" + MODEL_GBK + b"\n")
    f.write(("PRIMARY_PASSWORD=" + RAW_PASSWORD + "\n").encode("latin1"))
    f.write(("PRIMARY_USER_ID=" + RAW_USER_ID + "\n").encode("latin1"))
    f.write(b"PRIMARY_SERVER_ADDRESS=10.0.0.5\n")

p = subprocess.Popen(["build/mzweb-x86"])
time.sleep(1)


def login():
    r = urllib.request.Request(
        "http://127.0.0.1:80/auth/login",
        data=json.dumps({"username": "admin", "password": "123456"}).encode(),
    )
    body = urllib.request.urlopen(r, timeout=5).read().decode("latin1")
    return re.search(r'"token":\s*"([0-9a-f]+)', body).group(1)


try:
    tok = login()
    H = {"Authorization": "Bearer " + tok}

    # --- FW-01 / FW-02: /get/device/status -----------------------------------
    raw = urllib.request.urlopen(
        urllib.request.Request("http://127.0.0.1:80/get/device/status", headers=H),
        timeout=5,
    ).read()
    b = raw.decode("gbk", "replace")
    d = json.loads(b)  # 必須可直接 parse（不需 cleanDirtyJSON）——證明 FW-01/02 皆已修
    assert "device_info" in d and "network_info" in d, "device_info/network_info 不在 root（FW-02 未修）"
    assert "sip_status" in d, "sip_status 不見了"
    assert "device_info" not in d["sip_status"], "device_info 仍巢狀在 sip_status 內（FW-02 未修）"
    assert "network_info" not in d["sip_status"], "network_info 仍巢狀在 sip_status 內（FW-02 未修）"
    assert "broadcast_volume" in json.dumps(d), "broadcast_volume key 缺（FW-01 未修）"
    assert d["device_info"]["broadcast_volume"] == 75, d
    assert d["device_info"]["microphone_volume"] == 80, d
    assert d["device_info"]["model"] == "深圳測試機", (
        "GBK 高位元組疑似被 cJSON 破壞或轉義成 \\uXXXX", d["device_info"]["model"]
    )
    assert d["network_info"]["ip_allocation"] == "static", d

    # --- SEC-09: /get/sip/config ---------------------------------------------
    raw2 = urllib.request.urlopen(
        urllib.request.Request("http://127.0.0.1:80/get/sip/config", headers=H),
        timeout=5,
    ).read()
    b2 = raw2.decode("gbk", "replace")
    d2 = json.loads(b2)  # 含特殊字元 user_id 仍是合法 JSON —— 證明 cJSON escape 生效
    # 鑑別力佐證：wire 格式上必須真的看得到跳脫後的引號／反斜線（"\\\"" 與 "\\\\"），
    # 而不是 RAW_USER_ID 剛好無特殊字元、斷言僥倖過關。
    assert '\\"' in b2, ("wire 格式看不到跳脫後的引號 —— escape 疑似未生效", b2)
    assert "\\\\" in b2, ("wire 格式看不到跳脫後的反斜線 —— escape 疑似未生效", b2)
    assert d2["primary_line"]["user_id"] == RAW_USER_ID, (
        "SEC-09 escape 後 user_id 還原不一致", d2["primary_line"]["user_id"]
    )
    # SEC-02 回歸：password 欄即便種了含特殊字元的值，仍恆遮蔽，不可能等於 RAW_PASSWORD。
    assert d2["primary_line"]["password"] == "********", (
        "SEC-02 密碼應恆遮蔽為 ********", d2["primary_line"]["password"]
    )
    assert d2["primary_line"]["server_address"] == "10.0.0.5", d2
    assert isinstance(d2["primary_line"]["auto_answer"], bool), (
        "auto_answer 應為 JSON bool（未被誤 quote 成字串）", d2
    )
    assert isinstance(d2["multicast_config"]["multicast_port"], (int, float)), (
        "multicast_port 應為 JSON number", d2
    )

    print("sec09_fw OK")
finally:
    p.kill()

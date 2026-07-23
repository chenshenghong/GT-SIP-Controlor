#!/usr/bin/env python3
"""P7 T9：原廠 sipweb vs 自建 mzweb 線上行為三階段比對 harness。

用途（T11 真機驗收「19 條路由零漂移」的量測工具）：
  capture <base_url> <outdir>    對 base_url 打完整 test matrix，逐案例存回應。
  compare <dir_a> <dir_b>        三階段比對兩次 capture 的結果，exit 0＝零差異。
  --selftest                     起兩個行為相同的假 server 自我驗證（本檔 TDD）。

背景事實（決定下面比對策略，來自 T6 整編實測 / docs/firmware-reference/REFERENCE.md）：
  - 原廠 websetsip 恆回 HTTP 200，錯誤放在 body（status/error_code），非 HTTP 狀態碼。
  - body 常為 GBK，且 token 尾端可能帶一個未跳脫的 \n（原廠 off-by-one 怪癖）；
    capture 一律用 base64 保真存 body，compare 時才嘗試解碼。
  - test matrix（19 條路由）寫死在本檔（來源 docs/firmware-reference/REFERENCE.md §二），
    不在 runtime 讀該檔——因為它是 gitignored 廠商文件，真機/CI 未必存在。

Global constraints：純 python3 標準庫（urllib/http.server/base64/json/argparse 皆不用第三方套件）。
"""

import base64
import json
import os
import shutil
import sys
import tempfile
import threading
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer

DEFAULT_TIMEOUT = 5


# ---------------------------------------------------------------------------
# Test matrix：19 條原廠路由（REFERENCE.md §二編號）＋ 5 條錯誤案例。
# 執行順序刻意調整（非路由表編號順序）：
#   - auth_login 必須第一個跑（後續案例都要用它拿到的 token）。
#   - auth_logout 必須最後跑——原廠 token 是「全域單一 session」，logout 後
#     token 立即失效，若提早跑會讓後面所有需要 token 的案例全部失敗。
#   - payload 欄位名稱一律對齊韌體 websetsip.utf8.c 的 cJSON_GetObjectItem
#     實際鍵名（見各 case 行內註解標註的原始碼行號），確保請求打進路由「真正
#     的業務驗證邏輯」，而非停在通用「缺欄位」E001（假陰性）。
#   - 對「apply 會破壞真機且難復原」的路由，刻意送能命中『驗證拒絕』分支的
#     payload：set/sip/primary、set/sip/backup 缺一必要欄位（走 missing-key
#     拒絕，避免走到韌體 :1109 kill termapp）；set/network/config 送
#     network_mode:dhcp（命中韌體 :2095-2101『仅支持静态』拒絕）；
#     set/sip/multicast 送首字節非 224–239 的位址（命中 :2536-2547『非法组播
#     地址』拒絕）。既驗到路由真實業務邏輯的 parity，又不對真機破壞性 apply。
#   - system/restart 送 confirm:false：命中『成功但無副作用』分支（韌體
#     :2283-2287 只在 confirm==true 才啟動 reboot timer；false 直接成功回 200
#     status:success），驗證路由存在且不觸發真的 reboot。
#   - 對「apply 可輕易復原」的路由（set/device/volume、set/sip/codecs）送合法
#     值以驗證 apply 路徑 parity——⚠ capture 會改真機狀態，T11 需復原（見報告）。
#   - 真機驗收前應另行確認風險（見 task-9 報告 concerns）。
# ---------------------------------------------------------------------------

CASE_ORDER = [
    "case01_auth_login",
    "case03_auth_verify",
    "case05_get_device_status",
    "case06_set_device_volume",
    "case07_get_device_volume",
    "case08_get_sip_config",
    "case09_set_sip_primary",
    "case10_set_sip_backup",
    "case11_set_sip_parameters",
    "case12_set_sip_codecs",
    "case13_call_control",
    "case14_get_call_status",
    "case15_get_network_config",
    "case16_set_network_config",
    "case17_system_restart",
    "case18_system_info",
    "case19_set_sip_multicast",
    "case04_auth_change_password",
    "err_no_token",
    "err_bad_token",
    "err_bad_json",
    "err_unknown_route",
    "err_long_url",
    "case02_auth_logout",
]

# route_no 對應 REFERENCE.md §二 的編號，僅供報告追溯，不影響邏輯。
ROUTE_NO = {
    "case01_auth_login": 1, "case02_auth_logout": 2, "case03_auth_verify": 3,
    "case04_auth_change_password": 4, "case05_get_device_status": 5,
    "case06_set_device_volume": 6, "case07_get_device_volume": 7,
    "case08_get_sip_config": 8, "case09_set_sip_primary": 9,
    "case10_set_sip_backup": 10, "case11_set_sip_parameters": 11,
    "case12_set_sip_codecs": 12, "case13_call_control": 13,
    "case14_get_call_status": 14, "case15_get_network_config": 15,
    "case16_set_network_config": 16, "case17_system_restart": 17,
    "case18_system_info": 18, "case19_set_sip_multicast": 19,
    "err_no_token": None, "err_bad_token": None, "err_bad_json": None,
    "err_unknown_route": None, "err_long_url": None,
}

# /system/info 靠 popen("top -n 1") 取值，時序性強，只做結構比對（spec §六風險7）。
STAGE1_ONLY_CASES = {"case18_system_info"}

# 動態欄位白名單（key 名比對，遞迴適用於任何巢狀層級）；header 另外處理。
DYNAMIC_HEADER_KEYS = {"date", "content-length"}


def is_dynamic_key(key):
    k = key.lower()
    if k in ("token", "uptime", "temperature"):
        return True
    if k.startswith("cpu_") or k.startswith("memory_") or k.startswith("disk_"):
        return True
    return False


# ---------------------------------------------------------------------------
# HTTP 請求 helper：對長 URL / 連線失敗等狀況要 robust，不可讓 capture 中斷。
# ---------------------------------------------------------------------------

def http_request(base_url, method, path, headers=None, body=None, timeout=DEFAULT_TIMEOUT):
    url = base_url.rstrip("/") + path
    req = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            status = resp.getcode()
            hdrs = dict(resp.getheaders())
            raw = resp.read()
            return status, hdrs, raw
    except urllib.error.HTTPError as e:
        raw = e.read()
        hdrs = dict(e.headers.items()) if e.headers else {}
        return e.code, hdrs, raw
    except Exception as e:  # noqa: BLE001 — 連線層失敗（超長 URL、拒絕連線等）也要記錄不炸
        return -1, {}, ("EXCEPTION: %s: %s" % (type(e).__name__, e)).encode("utf-8")


def try_parse_json(raw_bytes):
    """依序嘗試 utf-8 / gbk / latin-1 解碼；strict=False 容忍原廠未跳脫的控制字元（\\n）。"""
    for enc in ("utf-8", "gbk", "latin-1"):
        try:
            text = raw_bytes.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
        try:
            return json.loads(text, strict=False)
        except (ValueError, TypeError):
            continue
    return None


def find_key(obj, key_name):
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k.lower() == key_name.lower() and isinstance(v, str):
                return v
            r = find_key(v, key_name)
            if r is not None:
                return r
    elif isinstance(obj, list):
        for item in obj:
            r = find_key(item, key_name)
            if r is not None:
                return r
    return None


def extract_token(raw_bytes):
    obj = try_parse_json(raw_bytes)
    if obj is None:
        return None
    return find_key(obj, "token")


# ---------------------------------------------------------------------------
# 逐 case 建構請求（method, path, headers, body_bytes）。
# ---------------------------------------------------------------------------

def build_case_request(case_id, token, user, pw):
    ct = {"Content-Type": "application/json"}

    def auth_hdr(tok):
        h = dict(ct)
        if tok is not None:
            # 原廠 token 尾端可能帶未跳脫的 \n（GBK off-by-one 怪癖）；HTTP header 值
            # 不可含 CR/LF，真送出前一律去尾 \r\n，與一般用戶端行為一致。
            h["Authorization"] = "Bearer " + tok.rstrip("\r\n")
        return h

    if case_id == "case01_auth_login":
        return "POST", "/auth/login", dict(ct), json.dumps({"username": user, "password": pw}).encode()
    if case_id == "case02_auth_logout":
        return "POST", "/auth/logout", auth_hdr(token), None
    if case_id == "case03_auth_verify":
        return "GET", "/auth/verify", auth_hdr(token), None
    if case_id == "case04_auth_change_password":
        # old==new：保持冪等，不真的改變密碼狀態。
        payload = {"old_password": pw, "new_password": pw}
        return "POST", "/auth/change_password", auth_hdr(token), json.dumps(payload).encode()
    if case_id == "case05_get_device_status":
        return "GET", "/get/device/status", {}, None
    if case_id == "case06_set_device_volume":
        # 韌體實際欄位：broadcast_volume + microphone_volume（皆 number，合法域 0-100；
        # websetsip.utf8.c :671-674 缺欄位檢查、:689-694 範圍檢查）。60/60 為合法值 →
        # 走 apply 路徑（寫 CAP_VOL/PLAY_VOL），驗 apply parity。
        # ⚠ capture 會改真機播放/採集音量（可復原）；T11 需復原原始音量。
        payload = {"broadcast_volume": 60, "microphone_volume": 60}
        return "POST", "/set/device/volume", auth_hdr(token), json.dumps(payload).encode()
    if case_id == "case07_get_device_volume":
        return "GET", "/get/device/volume", {}, None
    if case_id == "case08_get_sip_config":
        return "GET", "/get/sip/config", {}, None
    if case_id == "case09_set_sip_primary":
        # 韌體實際欄位（websetsip.utf8.c :961-967）：server_address / server_port /
        # user_id / password / auto_answer / register_timeout / transport_protocol，
        # 全為必要欄位。此 handler 無「非法值」拒絕分支——任一合法 payload 都會走到
        # :1106 寫檔並 :1109 `kill -9 termapp`（破壞性、殺掉 SIP 進程）。故刻意「缺
        # transport_protocol 一個必要欄位」→ 命中 :969-980 缺欄位 E001 拒絕，走進本
        # 路由真實的 7 欄位驗證邏輯（parity），但不觸及 kill termapp 破壞性 apply。
        payload = {"server_address": "192.168.0.100", "server_port": 5060, "user_id": "1000",
                   "password": "test1234", "auto_answer": False, "register_timeout": 3600}
        return "POST", "/set/sip/primary", auth_hdr(token), json.dumps(payload).encode()
    if case_id == "case10_set_sip_backup":
        # 韌體實際欄位（websetsip.utf8.c :1203-1209）：與 primary 同 7 欄位、同型別；
        # 缺欄位檢查 :1211-1222、型別檢查 :1224-1235，無「非法值」拒絕分支，合法 payload
        # 一樣會 kill termapp（apply）。故同 case09 策略：刻意缺 transport_protocol →
        # 命中 :1211-1222 缺欄位 E001 拒絕，驗真實驗證邏輯 parity 且非破壞性。
        payload = {"server_address": "192.168.0.101", "server_port": 5060, "user_id": "1001",
                   "password": "test1234", "auto_answer": False, "register_timeout": 3600}
        return "POST", "/set/sip/backup", auth_hdr(token), json.dumps(payload).encode()
    if case_id == "case11_set_sip_parameters":
        payload = {"local_port": 5060, "rtp_start_port": 10000, "rtp_end_port": 20000,
                   "rtp_timeout": 60, "echo_cancellation": True}
        return "POST", "/set/sip/parameters", auth_hdr(token), json.dumps(payload).encode()
    if case_id == "case12_set_sip_codecs":
        # 韌體實際欄位（websetsip.utf8.c :1635-1638）：g722 / g711_ulaw / g711_alaw /
        # opus，皆 bool（缺欄位 :1640-1648、型別 :1650-1658）。此 handler 對 bool 值無
        # 「非法值」拒絕分支（bool 恆合法），故用合法 bool → 走 apply（modify G722/PCMU
        # /PCMA/OPUS）驗 apply parity。
        # ⚠ capture 會改真機 codec 開關（可復原）；T11 需復原原始 codec 設定。
        payload = {"g722": True, "g711_ulaw": True, "g711_alaw": True, "opus": False}
        return "POST", "/set/sip/codecs", auth_hdr(token), json.dumps(payload).encode()
    if case_id == "case13_call_control":
        # hangup：無通話時通常是無副作用的 no-op，避免真的觸發撥號。
        return "POST", "/call/control", auth_hdr(token), json.dumps({"action": "hangup"}).encode()
    if case_id == "case14_get_call_status":
        return "GET", "/get/call/status", {}, None
    if case_id == "case15_get_network_config":
        return "GET", "/get/network/config", {}, None
    if case_id == "case16_set_network_config":
        # 韌體實際欄位（websetsip.utf8.c :2069-2073）：network_mode / ip_address /
        # subnet_mask / gateway（必要）＋ dns（選填）。必要欄位齊備才會走到 :2095-2101
        # 的 network_mode 值檢查（僅支援 "static"）。故送齊 4 個必要欄位＋不支援的
        # network_mode:"dhcp" → 命中 :2095-2101「仅支持静态网络设置」E001 拒絕；非破壞性
        # （reject 於 :2118 讀檔前，不寫 ETH0_SET_FILE、不啟動 :2172 reboot 定時器）。
        payload = {"network_mode": "dhcp", "ip_address": "192.168.0.70",
                   "subnet_mask": "255.255.255.0", "gateway": "192.168.0.1"}
        return "POST", "/set/network/config", auth_hdr(token), json.dumps(payload).encode()
    if case_id == "case17_system_restart":
        # 韌體實際欄位（websetsip.utf8.c :2268）：confirm（bool）。:2283-2287 僅在
        # confirm==true 才 event_timer_start(reboot_timer)；confirm:false 直接 break →
        # msg/code 皆 NULL → 走 :2304-2308 成功分支，回 HTTP 200 status:success。
        # 即 confirm:false 命中「成功但無副作用」分支（非驗證錯誤路徑），不觸發真的 reboot。
        return "POST", "/system/restart", auth_hdr(token), json.dumps({"confirm": False}).encode()
    if case_id == "case18_system_info":
        return "GET", "/system/info", {}, None
    if case_id == "case19_set_sip_multicast":
        # 韌體實際欄位（websetsip.utf8.c :2497-2500）：multicast_address（string）/
        # multicast_port（number）/ enabled（bool）/ audio_codec（string）。必要欄位齊備、
        # 型別正確才會走到 :2536-2547 的組播位址檢查（首字節須 224–239）。故送齊 4 欄位
        # ＋首字節非法的位址 192.168.1.1 → 命中 :2544-2546「非法组播地址」E001 拒絕；
        # 非破壞性（reject 於任何寫入/apply 前）。
        payload = {"multicast_address": "192.168.1.1", "multicast_port": 5004,
                   "enabled": True, "audio_codec": "G.722"}
        return "POST", "/set/sip/multicast", auth_hdr(token), json.dumps(payload).encode()
    if case_id == "err_no_token":
        return "GET", "/auth/verify", dict(ct), None
    if case_id == "err_bad_token":
        h = dict(ct)
        h["Authorization"] = "Bearer deadbeefdeadbeefdeadbeefdeadbeef"
        return "GET", "/auth/verify", h, None
    if case_id == "err_bad_json":
        return "POST", "/set/device/volume", auth_hdr(token), b"{not valid json"
    if case_id == "err_unknown_route":
        return "GET", "/nope", {}, None
    if case_id == "err_long_url":
        return "GET", "/" + "a" * 4096, {}, None
    raise ValueError("unknown case_id: " + case_id)


# ---------------------------------------------------------------------------
# capture
# ---------------------------------------------------------------------------

def capture(base_url, outdir, timeout=DEFAULT_TIMEOUT):
    os.makedirs(outdir, exist_ok=True)
    user = os.environ.get("P7_USER", "admin")
    pw = os.environ.get("P7_PASS", "123456")
    token = None
    for case_id in CASE_ORDER:
        method, path, headers, body = build_case_request(case_id, token, user, pw)
        status, hdrs, raw = http_request(base_url, method, path, headers, body, timeout)
        if case_id == "case01_auth_login":
            token = extract_token(raw)
        record = {"status": status, "headers": hdrs, "body_b64": base64.b64encode(raw).decode("ascii")}
        with open(os.path.join(outdir, case_id + ".json"), "w", encoding="utf-8") as f:
            json.dump(record, f, ensure_ascii=False, indent=2)
        print("[capture] %-28s %-5s %-30s -> %s" % (case_id, method, path[:30], status))
    print("capture done: %d cases -> %s" % (len(CASE_ORDER), outdir))


# ---------------------------------------------------------------------------
# compare：三階段
# ---------------------------------------------------------------------------

def key_paths(obj, prefix=""):
    """遞迴收集 JSON 物件的 key path 集合（list 不分索引，統一標記為 []）。"""
    paths = set()
    if isinstance(obj, dict):
        for k, v in obj.items():
            p = prefix + "." + k if prefix else k
            paths.add(p)
            paths |= key_paths(v, p)
    elif isinstance(obj, list):
        for item in obj:
            paths |= key_paths(item, prefix + "[]")
    return paths


def mask_dynamic(obj, prefix="", collected=None):
    """回傳把白名單動態欄位置換為 "<DYN>" 的副本；collected 蒐集 (path, 原始值) 供階段三明細。"""
    if collected is None:
        collected = []
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            p = prefix + "." + k if prefix else k
            if is_dynamic_key(k):
                collected.append((p, v))
                out[k] = "<DYN>"
            else:
                out[k] = mask_dynamic(v, p, collected)
        return out
    if isinstance(obj, list):
        return [mask_dynamic(item, prefix + "[]", collected) for item in obj]
    return obj


def mask_headers(headers):
    return {k.lower(): ("<DYN>" if k.lower() in DYNAMIC_HEADER_KEYS else v) for k, v in headers.items()}


def find_first_diff(a, b, path="$"):
    """找出兩個（已遮罩的）結構第一個不同之處，回傳描述字串；相同回傳 None。"""
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a:
                return "%s.%s: missing in A (b=%r)" % (path, k, b[k])
            if k not in b:
                return "%s.%s: missing in B (a=%r)" % (path, k, a[k])
            d = find_first_diff(a[k], b[k], "%s.%s" % (path, k))
            if d:
                return d
        return None
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            return "%s: list length differs (%d vs %d)" % (path, len(a), len(b))
        for i, (x, y) in enumerate(zip(a, b)):
            d = find_first_diff(x, y, "%s[%d]" % (path, i))
            if d:
                return d
        return None
    if type(a) is not type(b) or a != b:
        return "%s: %r vs %r" % (path, a, b)
    return None


def load_record(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def compare_dirs(dir_a, dir_b):
    files_a = {f[:-5] for f in os.listdir(dir_a) if f.endswith(".json")}
    files_b = {f[:-5] for f in os.listdir(dir_b) if f.endswith(".json")}
    all_ids = sorted(files_a | files_b)
    fail_count = 0

    for case_id in all_ids:
        if case_id not in files_a or case_id not in files_b:
            side = "A" if case_id not in files_a else "B"
            print("[FAIL] %s: 缺少 capture（%s 側沒有此檔）" % (case_id, side))
            fail_count += 1
            continue

        a = load_record(os.path.join(dir_a, case_id + ".json"))
        b = load_record(os.path.join(dir_b, case_id + ".json"))

        # --- 階段一：結構比對（status / header key 集合 / body JSON key 集合）---
        if a["status"] != b["status"]:
            print("[FAIL] %s: stage1 status 不同 (%s vs %s)" % (case_id, a["status"], b["status"]))
            fail_count += 1
            continue

        keys_a = {k.lower() for k in a["headers"].keys()}
        keys_b = {k.lower() for k in b["headers"].keys()}
        if keys_a != keys_b:
            print("[FAIL] %s: stage1 header-key-set 不同 (%s)" % (case_id, sorted(keys_a ^ keys_b)))
            fail_count += 1
            continue

        raw_a = base64.b64decode(a["body_b64"])
        raw_b = base64.b64decode(b["body_b64"])
        obj_a = try_parse_json(raw_a)
        obj_b = try_parse_json(raw_b)
        if (obj_a is None) != (obj_b is None):
            print("[FAIL] %s: stage1 body JSON 可解析性不同" % case_id)
            fail_count += 1
            continue

        if obj_a is not None:
            kp_a, kp_b = key_paths(obj_a), key_paths(obj_b)
            if kp_a != kp_b:
                print("[FAIL] %s: stage1 body-key-set 不同 (%s)" % (case_id, sorted(kp_a ^ kp_b)))
                fail_count += 1
                continue

        if case_id in STAGE1_ONLY_CASES:
            print("[PASS] %s: stage1-only（popen 時序性，跳過 stage2）status=%s" % (case_id, a["status"]))
            continue

        # --- 階段二：置換動態欄位為常數後全文比對 ---
        mh_a = mask_headers(a["headers"])
        mh_b = mask_headers(b["headers"])
        if obj_a is not None:
            coll_a, coll_b = [], []
            mb_a = mask_dynamic(obj_a, collected=coll_a)
            mb_b = mask_dynamic(obj_b, collected=coll_b)
            body_diff = find_first_diff(mb_a, mb_b)
        else:
            coll_a, coll_b = [], []
            body_diff = None if raw_a == raw_b else "raw body 不同（非 JSON，無動態欄位可遮罩）"

        header_diff = find_first_diff(mh_a, mh_b)
        if header_diff or body_diff:
            print("[FAIL] %s: stage2 遮罩後仍有差異 -> header:%s body:%s" % (case_id, header_diff, body_diff))
            fail_count += 1
            continue

        print("[PASS] %s: stage1+2 零差異 status=%s" % (case_id, a["status"]))

        # --- 階段三：列出被遮罩的差異明細（僅供人工確認，不影響 PASS/FAIL）---
        dyn_a = dict(coll_a)
        dyn_b = dict(coll_b)
        for p in sorted(set(dyn_a) | set(dyn_b)):
            va = dyn_a.get(p, "<missing>")
            vb = dyn_b.get(p, "<missing>")
            if va != vb:
                print("    [stage3] %s %s: a=%r b=%r" % (case_id, p, va, vb))

    print("\nTOTAL: %d cases, %d passed, %d failed" % (len(all_ids), len(all_ids) - fail_count, fail_count))
    return fail_count


# ---------------------------------------------------------------------------
# --selftest：起兩個行為相同的假 server，驗證 capture/compare 邏輯本身。
# ---------------------------------------------------------------------------

def make_fake_config(seed):
    return {
        "model": "SIP-Player-2024",
        "uptime": 1000 * seed,
        "cpu_usage": 10 * seed,
        "memory_used": 1000 * seed,
        "memory_total": 4096,
        "disk_used": 500 * seed,
        "disk_total": 2000,
        "temperature": 40 + seed,
        "volume": 60,
        "multicast": {"address": "", "port": 0, "enabled": False, "codec": "G.722"},
        "user": os.environ.get("P7_USER", "admin"),
        "password": os.environ.get("P7_PASS", "123456"),
        "_session": {"token": None},
    }


def make_fake_handler(config):
    class FakeHandler(BaseHTTPRequestHandler):
        CFG = config

        def log_message(self, *a):
            pass

        def _send_json(self, code, obj):
            body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            try:
                self.wfile.write(body)
            except Exception:
                pass

        def _read_body(self):
            n = int(self.headers.get("Content-Length", 0) or 0)
            return self.rfile.read(n) if n > 0 else b""

        def _check_token(self):
            auth = self.headers.get("Authorization", "")
            tok = auth[len("Bearer "):] if auth.startswith("Bearer ") else ""
            return tok != "" and tok == self.CFG["_session"].get("token")

        def do_GET(self):
            path, cfg = self.path, self.CFG
            if path == "/get/device/status":
                resp = {"status": "success", "model": cfg["model"],
                        "uptime": cfg["uptime"], "sip_registered": True,
                        "network": {"ip": "192.168.0.70"}}
                # selftest round3 用：注入一個額外 body key，製造 stage1 結構性差異
                # （body-key-set 不同），驗證 compare_dirs 的 stage1 失敗分支會被觸發。
                if cfg.get("_inject_extra"):
                    resp["extra_field"] = "unexpected"
                self._send_json(200, resp)
            elif path == "/get/device/volume":
                self._send_json(200, {"status": "success", "volume": cfg["volume"]})
            elif path == "/get/sip/config":
                self._send_json(200, {"status": "success",
                                       "primary_line": {"server_address": "192.168.0.1",
                                                         "port": 5060, "password": "secret"},
                                       "multicast_config": cfg["multicast"],
                                       "sip_parameters": {"local_port": 5060},
                                       "audio_codecs": {"g722": True}})
            elif path == "/get/call/status":
                self._send_json(200, {"status": "success", "call_state": "idle"})
            elif path == "/get/network/config":
                self._send_json(200, {"status": "success", "ipaddr": "192.168.0.70",
                                       "netmask": "255.255.255.0", "gateway": "192.168.0.1"})
            elif path == "/system/info":
                self._send_json(200, {"status": "success", "cpu_usage": cfg["cpu_usage"],
                                       "memory_used": cfg["memory_used"], "memory_total": cfg["memory_total"],
                                       "disk_used": cfg["disk_used"], "disk_total": cfg["disk_total"],
                                       "temperature": cfg["temperature"], "uptime": cfg["uptime"]})
            elif path == "/auth/verify":
                if self._check_token():
                    self._send_json(200, {"status": "success"})
                else:
                    self._send_json(200, {"status": "error", "error_code": "A003"})
            else:
                self._send_json(404, {"status": "error", "error_code": "E404"})

        def do_POST(self):
            path, cfg = self.path, self.CFG
            raw = self._read_body()

            if path == "/auth/login":
                try:
                    obj = json.loads(raw.decode("utf-8"))
                except Exception:
                    self._send_json(200, {"status": "error", "error_code": "E001"})
                    return
                if obj.get("username") == cfg["user"] and obj.get("password") == cfg["password"]:
                    token = uuid.uuid4().hex
                    cfg["_session"]["token"] = token
                    self._send_json(200, {"status": "success", "token": token, "expires_in": 3600})
                else:
                    self._send_json(200, {"status": "error", "error_code": "A001"})
                return

            if not self._check_token():
                self._send_json(200, {"status": "error", "error_code": "A003"})
                return

            try:
                obj = json.loads(raw.decode("utf-8"), strict=False) if raw else {}
            except Exception:
                self._send_json(200, {"status": "error", "error_code": "E001"})
                return

            if path == "/auth/logout":
                cfg["_session"]["token"] = None
                self._send_json(200, {"status": "success"})
            elif path == "/auth/change_password":
                self._send_json(200, {"status": "success"})
            elif path == "/set/device/volume":
                cfg["volume"] = obj.get("volume", cfg["volume"])
                self._send_json(200, {"status": "success", "volume": cfg["volume"]})
            elif path in ("/set/sip/primary", "/set/sip/backup", "/set/sip/parameters", "/set/sip/codecs"):
                self._send_json(200, {"status": "success"})
            elif path == "/call/control":
                self._send_json(200, {"status": "success", "action": obj.get("action")})
            elif path == "/set/network/config":
                if obj.get("type") != "static":
                    self._send_json(200, {"status": "error", "error_code": "A001"})
                else:
                    self._send_json(200, {"status": "success"})
            elif path == "/system/restart":
                if obj.get("confirm") is True:
                    self._send_json(200, {"status": "success", "rebooting": True})
                else:
                    self._send_json(200, {"status": "error", "error_code": "A001"})
            elif path == "/set/sip/multicast":
                cfg["multicast"] = obj
                self._send_json(200, {"status": "success"})
            else:
                self._send_json(404, {"status": "error", "error_code": "E404"})

    return FakeHandler


def start_fake_server(config):
    httpd = HTTPServer(("127.0.0.1", 0), make_fake_handler(config))
    port = httpd.server_address[1]
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    return httpd, port


def run_selftest():
    workdir = tempfile.mkdtemp(prefix="p7diff_selftest_")
    srv_a = srv_b = None
    try:
        # 兩個 fake server 動態欄位（uptime/cpu_usage/memory_used/disk_used/temperature）
        # 刻意用不同 seed，藉此驗證 stage2 遮罩確實忽略這些欄位。
        config_a = make_fake_config(seed=1)
        config_b = make_fake_config(seed=2)
        srv_a, port_a = start_fake_server(config_a)
        srv_b, port_b = start_fake_server(config_b)

        dir_a = os.path.join(workdir, "a")
        dir_b_pass = os.path.join(workdir, "b_pass")
        print("=== selftest：capture fake server A ===")
        capture("http://127.0.0.1:%d" % port_a, dir_a)
        print("=== selftest：capture fake server B（動態欄位刻意不同）===")
        capture("http://127.0.0.1:%d" % port_b, dir_b_pass)

        print("\n--- selftest round 1：A vs B，預期零差異（動態欄位應被遮罩忽略）---")
        rc1 = compare_dirs(dir_a, dir_b_pass)
        assert rc1 == 0, "selftest round1 應為 0 差異，實得 %d" % rc1

        # 蓄意改壞 B 的一個「非動態」欄位（device model），驗證比對器能抓出來。
        # 先把 round1 capture 過程中被 set 類路由改動的 state（volume/multicast）
        # 重置回初始值，確保 round2 與 round1 的唯一差異就是 model 這一個欄位。
        config_b["volume"] = 60
        config_b["multicast"] = {"address": "", "port": 0, "enabled": False, "codec": "G.722"}
        config_b["model"] = "SIP-Player-BROKEN"
        dir_b_fail = os.path.join(workdir, "b_fail")
        print("\n=== selftest：蓄意改壞 B 的 model 欄位，重新 capture ===")
        capture("http://127.0.0.1:%d" % port_b, dir_b_fail)

        print("\n--- selftest round 2：A vs B（已改壞），預期偵測到差異 ---")
        rc2 = compare_dirs(dir_a, dir_b_fail)
        assert rc2 > 0, "selftest round2 應偵測到差異，卻回報 0"
        assert rc2 >= 1, "selftest round2 差異數應 >= 1"

        # round3：stage1 結構性失敗。上面 round2 測的是「頂層純量改值」（走 stage2
        # 遮罩後全文比對）。這裡改測「結構」變異——讓 B 的 /get/device/status 回應多
        # 一個 body key（extra_field），驗證 compare_dirs 的 stage1 body-key-set 失敗
        # 分支確實會被觸發並回報非零。先把 model 復原成與 A 相同，排除 stage2 干擾，
        # 確保 case05 的唯一差異就是這個結構性多出來的 key（stage1 就會 FAIL 並 continue，
        # 根本走不到 stage2）。同 round2 先把 set 類路由改動過的 state（volume/
        # multicast）重置回初始值，確保 case05 以外的案例對 A 全部零差異。
        config_b["volume"] = 60
        config_b["multicast"] = {"address": "", "port": 0, "enabled": False, "codec": "G.722"}
        config_b["model"] = config_a["model"]
        config_b["_inject_extra"] = True
        dir_b_struct = os.path.join(workdir, "b_struct")
        print("\n=== selftest：讓 B 的 device/status 多回一個 body key，重新 capture ===")
        capture("http://127.0.0.1:%d" % port_b, dir_b_struct)

        print("\n--- selftest round 3：A vs B（結構多一 key），預期 stage1 結構失敗 ---")
        rc3 = compare_dirs(dir_a, dir_b_struct)
        assert rc3 > 0, "selftest round3 應偵測到 stage1 結構差異，卻回報 0"
    finally:
        if srv_a:
            srv_a.shutdown()
        if srv_b:
            srv_b.shutdown()
        shutil.rmtree(workdir, ignore_errors=True)

    print("\nselftest OK")


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def usage():
    print("usage:", file=sys.stderr)
    print("  p7diff.py capture <base_url> <outdir>", file=sys.stderr)
    print("  p7diff.py compare <dir_a> <dir_b>", file=sys.stderr)
    print("  p7diff.py --selftest", file=sys.stderr)


def main():
    argv = sys.argv[1:]
    if not argv:
        usage()
        sys.exit(2)

    if argv[0] == "--selftest":
        run_selftest()
        return

    if argv[0] == "capture":
        if len(argv) != 3:
            usage()
            sys.exit(2)
        capture(argv[1], argv[2])
        return

    if argv[0] == "compare":
        if len(argv) != 3:
            usage()
            sys.exit(2)
        rc = compare_dirs(argv[1], argv[2])
        sys.exit(1 if rc else 0)

    usage()
    sys.exit(2)


if __name__ == "__main__":
    main()

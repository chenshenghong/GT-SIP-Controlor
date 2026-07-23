#!/usr/bin/env python3
# mzscan.py — gt-sip-gw fleet pre-flight scanner（子專案 C）
# Spec: docs/superpowers/specs/2026-07-23-mzscan-inventory-design.md
import base64, json, re

DBP_PORT = 58001
# 同 src/main/dbpDiscover.ts 的 IFCFG-APP key 清單（QueryTool 抓包實證）
_KEY_NAMES = ["RegAddr","ServerPort","RegUser","RegPswd","OutVol","MicVol",
              "Key1A","Key1B","ConnectMode","SWversion","PTT","COR",
              "MQTT_NAME","MQTT_URL","CLIENT_ID","USER_NAME","USER_PASSWD",
              "CHECK","NTP","ROLE"]

def build_dbp_request():
    ifcfg = base64.b64encode(json.dumps({"key_name": _KEY_NAMES}).encode()).decode()
    return ("GET DBP/1.0\r\nCSeq: 1\r\nIFCFG-APP:%s\r\nIsBroadcast: 1\r\n\r\n" % ifcfg).encode("ascii")

_DBP_KEYMAP = {"IP": "ip", "MAC": "mac", "Ver": "fw_ver_dbp", "Type": "type", "Name": "name"}

def parse_dbp_reply(raw):
    text = raw.decode("gbk", "replace")
    if "DBP/" not in text:
        return None
    out = {}
    for line in re.split(r"[\r\n]+", text):
        if line.startswith("DBP/"):
            continue
        i = line.find(":")
        if i <= 0:
            continue
        k, v = line[:i].strip(), line[i + 1:].strip()
        if k in _DBP_KEYMAP:
            out[_DBP_KEYMAP[k]] = v
    return out if out.get("mac") else None

def merge_discovery(replies):
    """list[dict] -> {ip: record}; 同 ip 內容不一致 → dbp_conflict=True + dbp_variants。

    衝突定義：雙方都有的資料欄位值不同（只比較 key 交集，不含 meta 欄）。
    一方缺的欄位不算衝突；新欄位 merge 進 cur，記錄越掃越完整。
    """
    by_ip = {}
    for r in replies:
        ip = r.get("ip")
        if not ip:
            continue
        if ip not in by_ip:
            by_ip[ip] = dict(r)
            continue
        cur = by_ip[ip]
        # 計算兩筆記錄的 key 交集（排除 meta 欄 dbp_conflict/dbp_variants）
        cur_keys = {k for k in cur if k not in ("dbp_conflict", "dbp_variants")}
        r_keys = {k for k in r if k not in ("dbp_conflict", "dbp_variants")}
        intersection = cur_keys & r_keys

        # 衝突 = 交集中有任何欄位值不同
        has_conflict = any(cur[k] != r[k] for k in intersection)

        if has_conflict:
            # 首次衝突時，保存 cur 的原始狀態（不含 meta）
            if "dbp_variants" not in cur:
                cur["dbp_variants"] = [{k: cur[k] for k in cur_keys}]
            cur["dbp_variants"].append({k: r[k] for k in r_keys})
            cur["dbp_conflict"] = True
        else:
            # 無衝突：merge 新欄位（cur 更新為更完整的記錄）
            for k in r_keys:
                if k not in cur or cur[k] is None:
                    cur[k] = r[k]

    return by_ip

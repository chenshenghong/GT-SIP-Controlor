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
    """list[dict] -> {ip: record}; 同 ip 內容不一致 → dbp_conflict=True + dbp_variants。"""
    by_ip = {}
    for r in replies:
        ip = r.get("ip")
        if not ip:
            continue
        if ip not in by_ip:
            by_ip[ip] = dict(r)
            continue
        cur = by_ip[ip]
        base = {k: cur.get(k) for k in r if k not in ("dbp_conflict", "dbp_variants")}
        if base != {k: r.get(k) for k in r}:
            variants = cur.get("dbp_variants", [{k: cur[k] for k in cur
                                                if k not in ("dbp_conflict", "dbp_variants")}])
            variants.append(dict(r))
            cur["dbp_conflict"] = True
            cur["dbp_variants"] = variants
    return by_ip

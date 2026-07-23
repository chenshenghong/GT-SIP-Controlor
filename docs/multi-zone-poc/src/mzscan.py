#!/usr/bin/env python3
# mzscan.py — gt-sip-gw fleet pre-flight scanner（子專案 C）
# Spec: docs/superpowers/specs/2026-07-23-mzscan-inventory-design.md
import base64, json, re, ipaddress

DBP_PORT = 58001
TERMAPP_MD5_V211 = "b0eed3b30bd4fa4f1599a9475296fb6d"  # v2.1.1 NetPlayer, 1748236 bytes

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


def decide_fw_ver(termapp_md5, dbp_ver):
    """spec §四 韌體決策表。md5 為準；DBP 單源不足採信。"""
    if termapp_md5 == TERMAPP_MD5_V211:
        return "2.1.1"
    if termapp_md5 is not None and dbp_ver == "2.1.0":
        return "2.1.0"
    return "unknown"


def decide_web_type(sipweb_md5, mzweb_known_md5s, https_probe, http80_probe, loopback80_403):
    """spec §四 五層有序決策樹。"""
    if sipweb_md5 is not None and sipweb_md5 in mzweb_known_md5s:
        return "mzweb"
    if https_probe and https_probe.get("ok") and https_probe.get("status") == 401:
        return "https"
    if http80_probe and http80_probe.get("ok"):
        if http80_probe.get("status") == 200 and http80_probe.get("json"):
            return "lgw"
        if http80_probe.get("status") == 403 and loopback80_403 is True:
            return "hbi"
    return "unknown"


OPT_MIN_FREE_KB = 1478  # = 2*(mzrelay3 81KB + mzweb 402KB) + 512KB margin（spec §四）

_SIDECAR_KEYS = ("sidecar_relay_bin", "sidecar_relay_running", "sidecar_init", "sidecar_rest_ok")

def classify(f):
    """spec §四 分類矩陣，優先序由上而下。不變式：unknown 永不 done。"""
    # rule1: unreachable = DBP 確認不通「且」SSH 確認失敗（reachable_dbp=None 不算，應歸入 probe-incomplete）
    if f.get("reachable_dbp") is False and f.get("ssh_ok") is False:
        return "blocked:unreachable"
    # rule2: no-ssh = SSH 確認失敗
    if f.get("ssh_ok") is False:
        return "blocked:no-ssh"
    # rule3: /opt 不可用
    if f.get("opt_writable") is False or (
            f.get("opt_free_kb") is not None and f["opt_free_kb"] < OPT_MIN_FREE_KB):
        return "blocked:opt"
    # rule4: probe-incomplete = 資訊不足（任何關鍵欄 unknown/None）或衝突
    unknown = (f.get("fw_ver") == "unknown" or f.get("web_type") == "unknown"
               or f.get("opt_writable") is None or f.get("opt_free_kb") is None
               or f.get("ssh_ok") is None
               or any(f.get(k) is None for k in _SIDECAR_KEYS))
    if unknown or f.get("dbp_conflict") or f.get("hostkey_dup"):
        return "blocked:probe-incomplete"
    # rule5: 韌體需升級
    if f["fw_ver"] == "2.1.0":
        return "needs-fw-upgrade"
    # rule6: sidecar 不完整或非多區 Web
    if not all(f[k] for k in _SIDECAR_KEYS) or f["web_type"] != "mzweb":
        return "needs-sidecar"
    # rule7: 完成
    return "done"

def find_hostkey_dups(rows):
    seen, dups = set(), set()
    for r in rows:
        fp = r.get("ssh_hostkey_fp")
        if fp is None:
            continue
        if fp in seen:
            dups.add(fp)
        seen.add(fp)
    return dups


def _norm_mac(m):
    """Normalize MAC: remove - and : separators, convert to lowercase. None → None."""
    return re.sub(r"[-:]", "", m).lower() if m else None


def parse_fleet(text):
    """Parse fleet.txt: each line is 'IP[,MAC]', skip comments and blanks.

    Raises ValueError with line number if IP format is invalid or IP is duplicated.
    Returns list of {ip, mac} dicts (mac=None if not specified).
    """
    rows = []
    seen_ips = set()
    for ln, line in enumerate(text.splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = [p.strip() for p in line.split(",")]
        try:
            ipaddress.ip_address(parts[0])
        except ValueError:
            raise ValueError("fleet.txt line %d: bad IP %r" % (ln, parts[0]))
        if parts[0] in seen_ips:
            raise ValueError("fleet.txt line %d: duplicate IP %r" % (ln, parts[0]))
        seen_ips.add(parts[0])
        rows.append({"ip": parts[0], "mac": parts[1] if len(parts) > 1 and parts[1] else None})
    return rows


def reconcile(expected, discovered):
    """Reconcile expected fleet against discovered devices.

    expected: list[{ip, mac}] from parse_fleet
    discovered: dict[ip_str -> {mac, ...}] from merge_discovery

    Returns {
        "missing": sorted list of IPs in expected but not discovered,
        "unexpected": sorted list of IPs in discovered but not expected,
        "mac_mismatch": list of {ip, expected_mac, seen_mac} for MAC differences
                        (MAC comparison ignores case and - vs : separator)
    }
    """
    exp_ips = {e["ip"] for e in expected}
    out = {
        "missing": sorted(exp_ips - set(discovered)),
        "unexpected": sorted(set(discovered) - exp_ips),
        "mac_mismatch": []
    }
    for e in expected:
        d = discovered.get(e["ip"])
        # MAC 比對：expected 有 MAC「且」discovered 有 MAC「且」兩者正規化後不同 → mismatch
        # discovered 未觀測到 MAC（mac=None）不算 mismatch（三態：已知/不同/未知）
        if d and e["mac"] and d.get("mac") and _norm_mac(e["mac"]) != _norm_mac(d.get("mac")):
            out["mac_mismatch"].append({
                "ip": e["ip"],
                "expected_mac": e["mac"],
                "seen_mac": d.get("mac")
            })
    return out


# 單次 SSH 往返收齊全部設備側事實（busybox sh 相容）。TERMCFG 命令為 Task 8 真機實查後的定稿：
# 初值先用 grep 掃 /opt 常見 config；.70 實查若得出確切檔案路徑則改為直讀該檔。
PROBE_CMD = (
    'echo "===MD5TERMAPP==="; md5sum /opt/termapp 2>&1;'
    'echo "===MD5SIPWEB==="; md5sum /etc/sipweb/sipweb 2>&1;'
    'echo "===FILES==="; ls /opt/mzrelay3 /etc/init.d/S21mzrelay 2>/dev/null;'
    'echo "===PS==="; ps | grep mzrelay3 | grep -v grep;'
    'echo "===DF==="; df /opt 2>&1;'
    'echo "===OPTWRITE==="; F=/opt/.mzscan.$$;'
    ' if [ -e "$F" ]; then echo EXISTS; else (touch "$F" && rm "$F" && echo WRITE_OK) 2>/dev/null'
    ' || echo WRITE_FAIL; fi;'
    'echo "===TERMCFG==="; grep -rh "MULTICAST_ADDRESS" /opt 2>/dev/null | head -3;'
    'echo "===LOOPBACK80==="; printf "GET /auth/login HTTP/1.1\\r\\nHost:127.0.0.1\\r\\n'
    'Connection: close\\r\\n\\r\\n" | nc 127.0.0.1 80 2>/dev/null | head -1;'
    'echo "===END==="'
)

_MD5_RE = re.compile(r"^([0-9a-f]{32})\s", re.M)

def _sections(out):
    parts = re.split(r"===([A-Z0-9]+)===\n?", out)
    # parts = [prefix, TAG, body, TAG, body, ...]
    return {parts[i]: parts[i + 1] for i in range(1, len(parts) - 1, 2)}

def parse_probe_output(out):
    s = _sections(out)
    f = dict.fromkeys(("termapp_md5", "sipweb_md5", "sidecar_relay_bin",
                       "sidecar_relay_running", "sidecar_init", "opt_writable",
                       "opt_free_kb", "loopback80_403", "termapp_multicast_addr"))
    for tag, key in (("MD5TERMAPP", "termapp_md5"), ("MD5SIPWEB", "sipweb_md5")):
        m = _MD5_RE.search(s.get(tag, ""))
        f[key] = m.group(1) if m else None
    if "FILES" in s:
        f["sidecar_relay_bin"] = "/opt/mzrelay3" in s["FILES"]
        f["sidecar_init"] = "/etc/init.d/S21mzrelay" in s["FILES"]
    if "PS" in s:
        f["sidecar_relay_running"] = "mzrelay3" in s["PS"]
    if "DF" in s:
        m = re.search(r"^\S+\s+\d+\s+\d+\s+(\d+)\s", s["DF"], re.M)
        f["opt_free_kb"] = int(m.group(1)) if m else None
    if "OPTWRITE" in s:
        body = s["OPTWRITE"]
        f["opt_writable"] = True if "WRITE_OK" in body else (False if "WRITE_FAIL" in body else None)
    if "TERMCFG" in s:
        m = re.search(r"MULTICAST_ADDRESS\s*=\s*(\S+)", s["TERMCFG"])
        f["termapp_multicast_addr"] = m.group(1) if m else None
    if "LOOPBACK80" in s and s["LOOPBACK80"].strip():
        f["loopback80_403"] = "403" in s["LOOPBACK80"].splitlines()[0]
    return f

#!/usr/bin/env python3
# mzscan.py — gt-sip-gw fleet pre-flight scanner（子專案 C）
# Spec: docs/superpowers/specs/2026-07-23-mzscan-inventory-design.md
import base64, json, re, ipaddress, sys, datetime, uuid, collections, argparse

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
    """spec §四 分類矩陣，優先序由上而下。不變式：unknown 永不 done。

    schema 2 起 action 僅供人讀統計；B 路由以 mzstate verdict 為準（spec D+E §七）。"""
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
               or f.get("ssh_ok") is None or f.get("ssh_hostkey_fp") is None
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

def sidecar_partial(f):
    """spec 非阻斷修正 4：sidecar 四項「部分綠」（非全 true 亦非全 false）→ True（半套安裝）。

    全 true（已完整裝好）或全 false（尚未部署，正常初始狀態）皆非半套，回 False。
    任一欄為 None（unknown）時，classify 早已判 blocked:probe-incomplete，此函式的呼叫方
    只在 needs-sidecar/done 分支使用，故不特別處理 None 語意。
    """
    vals = [bool(f.get(k)) for k in _SIDECAR_KEYS]
    return any(vals) and not all(vals)


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


# 單次 SSH 往返收齊全部設備側事實（busybox sh 相容）。TERMCFG 段實查結論（Task 8，.70 真機）：
# 單槽 termapp 並無獨立 key=value config 檔——grep -rl MULTICAST_ADDRESS /opt 只命中 /opt/termapp
# 本身（該字串是編譯進二進位的 bare key 名稱，非 "KEY=value" 賦值；/etc、/opt/cfg、/var、/tmp、/mnt
# 皆無命中；/proc/<termapp_pid>/environ 亦無此變數）。busybox grep 對二進位逐行輸出不含 NUL 汙染
# （已驗證 od -c 輸出為單行 "MULTICAST_ADDRESS\n"），故現有 grep 對 §四 TERMCFG 段落解析安全、
# 無需改讀特定檔案。維持 grep 版本，termapp_multicast_addr 在此類設備上恆為 unknown（spec 明定
# 不擋分類，僅供 E 參考）。
#
# REST8090 段（Task 8 smoke 發現的真機事實，非原設計）：mzrelay3 啟動參數把 REST bind 在
# 127.0.0.1:8090（`netstat -tlnp` 實測，非 0.0.0.0），故從跳板機遠端 HTTP GET 必連線被拒——
# 這是側車既有安全設計（loopback-only），非可調的部署缺陷。改為與 LOOPBACK80 同手法、經 SSH
# 在設備本機以 nc 對 127.0.0.1:8090 探測（busybox 無 curl/wget，已用 which 確認）；不需
# Authorization header（loopback 免驗證，已實測驗證）。
# 審查修訂：只驗狀態列 200 不夠——:8090 若被其他服務占用、回 200 但非 zones JSON 會誤判
# sidecar_rest_ok=True，故多抓 body 供 parse 端嚴格 json.loads 驗證。
# Codex PR 審查修正：16 區 zones JSON 約 2KB，原 head -c 512 會截斷造成嚴格解析誤殺真設備，
# 改 head -c 8192。
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
    'echo "===REST8090==="; printf "GET /get/sip/multicast/zones HTTP/1.1\\r\\n'
    'Host:127.0.0.1\\r\\nConnection: close\\r\\n\\r\\n" | nc 127.0.0.1 8090 2>/dev/null | head -c 8192;'
    # head -c 截斷不保證輸出以換行結尾——若 body 剛好無尾端換行，緊接著的
    # echo "===MD5SIDECAR===" 會與 JSON 最後一個位元組黏在同一行（真機 .70 smoke 實測
    # 教訓，原發生在 END tag）。這裡補一個空 echo 強制換行，確保後續 tag 落在獨立行。
    'echo;'
    # ---- schema 2 新段落（spec D+E §七）----
    'echo "===MD5SIDECAR==="; md5sum /opt/mzrelay3 /etc/sipweb/sipweb /opt/mzio'
    ' /etc/init.d/S21mzrelay /etc/init.d/S21mzio 2>&1;'
    'echo "===IFCFGSIP==="; grep -E "^MULTICAST_(ADDRESS|PORT|ENABLED)=" /etc/ifcfg-sip 2>&1;'
    'echo "===CERT==="; ls -l /etc/sipweb/mz.crt /etc/sipweb/mz.key 2>&1;'
    ' md5sum /etc/sipweb/mz.crt 2>/dev/null;'
    'echo "===MZIO==="; ls /opt/mzio /etc/init.d/S21mzio 2>/dev/null;'
    ' ps | grep mzio | grep -v grep;'
    # MZSTATE 段刻意放最後（對抗審查 M-3）：marker 原文帶回，若被塞入字面 ===END===
    # 會提早終止 ssh_run 串流——放最後使截斷只損及 marker 本身（→視同缺），
    # 不波及其他事實段造成整機卡 21。
    'echo "===MZSTATE==="; head -c 8192 /opt/mzstate.json 2>&1; echo;'
    'echo "===END==="'
)

_MD5_RE = re.compile(r"^([0-9a-f]{32})\s", re.M)

def _status_token(line, code):
    """HTTP 狀態列第 2 欄精確 token 比對（避免 '200' in '...1200...' 這類子字串誤中）。"""
    parts = line.split()
    return len(parts) >= 2 and parts[1] == code

def _rest8090_ok(raw):
    """REST8090 段判定：狀態列須精確 200，且 body 須為嚴格合法 JSON object，且含
    list 型別的 "zones" 欄位——阻斷性修正 2：先前只驗首字元 {/[ 或子字串 "zones" 會
    fail-open（{}、{not-json、任意 array 皆誤判 True）。改嚴格 json.loads 驗證。"""
    if not raw:
        return None
    # 真機 .70 smoke 實測發現：pty ONLCR 會把 printf 內建的字面 \r\n 再轉一次，導致遠端
    # HTTP 回應在跨 pty 傳回時每行都變成 \r\r\n（雙 \r）。splitlines() 會把落單的 \r 當成
    # 獨立行界，讓 lines.index("") 抓到錯誤的（過早的）header/body 分界，使真正的 header
    # 欄位被誤併入 body 造成嚴格 JSON 解析失敗。統一先去除所有 \r 正規化為純 \n 行界。
    raw = raw.replace("\r", "")
    lines = raw.splitlines()
    if not lines:
        return None
    if not _status_token(lines[0], "200"):
        return False
    try:
        blank = lines.index("")
    except ValueError:
        return False  # 無 header/body 分界 → 無可驗證 body
    body_lines = [l for l in lines[blank + 1:] if l.strip()]
    if not body_lines:
        return False
    body = "\n".join(body_lines)
    try:
        parsed = json.loads(body)
    except ValueError:
        return False  # 無效 JSON（截斷/畸形）
    return isinstance(parsed, dict) and isinstance(parsed.get("zones"), list)

def _sections(out):
    # TAG 錨定整行（^...$，flags=re.M）防止 body 內偶現 ===XXX=== 樣式（如 TERMCFG grep 結果）錯位切段
    parts = re.split(r"^===([A-Z0-9]+)===\s*$", out, flags=re.M)
    # parts = [prefix, TAG, body, TAG, body, ...]
    return {parts[i]: parts[i + 1] for i in range(1, len(parts) - 1, 2)}

def parse_probe_output(out):
    s = _sections(out)
    f = dict.fromkeys(("termapp_md5", "sipweb_md5", "sidecar_relay_bin",
                       "sidecar_relay_running", "sidecar_init", "opt_writable",
                       "opt_free_kb", "loopback80_403", "termapp_multicast_addr",
                       "sidecar_rest_ok"))
    for tag, key in (("MD5TERMAPP", "termapp_md5"), ("MD5SIPWEB", "sipweb_md5")):
        m = _MD5_RE.search(s.get(tag, ""))
        f[key] = m.group(1) if m else None
    if "FILES" in s:
        f["sidecar_relay_bin"] = "/opt/mzrelay3" in s["FILES"]
        f["sidecar_init"] = "/etc/init.d/S21mzrelay" in s["FILES"]
    if "PS" in s:
        f["sidecar_relay_running"] = "mzrelay3" in s["PS"]
    if "DF" in s:
        # df 輸出可能折行（Available 欄），\s 容錯跨換行；穩定版應改用 column(1) index 定位
        m = re.search(r"^\S+\s+\d+\s+\d+\s+(\d+)\s", s["DF"], re.M)
        f["opt_free_kb"] = int(m.group(1)) if m else None
    if "OPTWRITE" in s:
        body = s["OPTWRITE"]
        # WRITE_OK → True（成功寫入）；WRITE_FAIL → False（寫入失敗）；
        # EXISTS（殘留測試檔）→ None（未實測寫入，狀態未知）
        f["opt_writable"] = True if "WRITE_OK" in body else (False if "WRITE_FAIL" in body else None)
    if "TERMCFG" in s:
        m = re.search(r"MULTICAST_ADDRESS\s*=\s*(\S+)", s["TERMCFG"])
        f["termapp_multicast_addr"] = m.group(1) if m else None
    if "LOOPBACK80" in s:
        body = s["LOOPBACK80"].strip()
        if body:  # 確保有非空白內容
            f["loopback80_403"] = _status_token(body.splitlines()[0], "403")
    if "REST8090" in s:
        body = s["REST8090"].strip()
        if body:  # 確保有非空白內容（REST 未啟動/連線被拒時 nc 無輸出，保持 None=unknown）
            f["sidecar_rest_ok"] = _rest8090_ok(body)
    return f


# ---- schema 2 事實欄（spec D+E §七）----
_SIDECAR_PATHS = {"mzrelay3": "/opt/mzrelay3", "mzweb": "/etc/sipweb/sipweb",
                  "mzio": "/opt/mzio", "S21mzrelay": "/etc/init.d/S21mzrelay",
                  "S21mzio": "/etc/init.d/S21mzio"}


def _md5_tristate(section, path):
    for line in section.splitlines():
        if path not in line:
            continue
        m = re.match(r"^([0-9a-f]{32})\s", line)
        if m:
            return {"state": "present", "md5": m.group(1)}
        if "No such file" in line:
            return {"state": "absent", "md5": None}
        return {"state": "error", "md5": None}
    return {"state": "error", "md5": None}   # 段落沒提到該路徑＝探測異常


def _ls_exists(section, path):
    for line in section.splitlines():
        if path in line and not re.match(r"^[0-9a-f]{32}\s", line):
            return "No such file" not in line
    return None


def _key_perm_ok(section):
    for line in section.splitlines():
        if "/etc/sipweb/mz.key" in line and line.startswith("-"):
            return line[:10] == "-rw-------"
    return None


def parse_probe_v2(out):
    s = _sections(out)
    f = {}
    sec = s.get("MD5SIDECAR", "")
    f["sidecar_md5s"] = {name: _md5_tristate(sec, p)
                         for name, p in _SIDECAR_PATHS.items()}
    body = s.get("MZSTATE", "").strip()
    if "No such file" in body:
        f["mzstate_marker"] = {"state": "absent", "raw": None}
    elif body:
        f["mzstate_marker"] = {"state": "present", "raw": body}
    else:
        f["mzstate_marker"] = {"state": "error", "raw": None}
    ifc = s.get("IFCFGSIP", "")
    m = re.search(r"^MULTICAST_ADDRESS=(\S+)", ifc, re.M)
    f["singleslot_mc_addr"] = m.group(1) if m else None
    m = re.search(r"^MULTICAST_PORT=(\d+)", ifc, re.M)
    f["singleslot_mc_port"] = int(m.group(1)) if m else None
    m = re.search(r"^MULTICAST_ENABLED=(\S+)", ifc, re.M)
    f["singleslot_enabled"] = (m.group(1) == "true") if m else None
    cert = s.get("CERT", "")
    f["cert_crt_exists"] = _ls_exists(cert, "/etc/sipweb/mz.crt")
    f["cert_key_exists"] = _ls_exists(cert, "/etc/sipweb/mz.key")
    f["cert_key_perm_ok"] = _key_perm_ok(cert)
    m = _MD5_RE.search(cert)
    f["cert_crt_md5"] = m.group(1) if m else None
    has_io = "MZIO" in s
    io = s.get("MZIO", "")
    io_lines = io.splitlines()
    # MZIO 段混雜 ls 輸出（整行=路徑）與 ps 輸出（開頭=PID）。真機 .70 實測：busybox ps
    # 命令欄是全路徑 /opt/mzio，不能用「行含 /」區分——改以 PID 開頭辨識 ps 行。
    ps_lines = [l for l in io_lines if re.match(r"\s*\d+\s", l)]
    f["mzio_bin"] = any(l.strip() == "/opt/mzio" for l in io_lines) if has_io else None
    f["mzio_init"] = any(l.strip() == "/etc/init.d/S21mzio" for l in io_lines) if has_io else None
    f["mzio_running"] = any("mzio" in l for l in ps_lines) if has_io else None
    return f


def v2_none_facts():
    """v2 欄位全-unknown 骨架。函式而非模組常數：每 row 取新副本，避免跨 row 共享巢狀 dict。"""
    return {
        "sidecar_md5s": {name: {"state": "error", "md5": None}
                         for name in _SIDECAR_PATHS},
        "mzstate_marker": {"state": "error", "raw": None},
        "singleslot_mc_addr": None, "singleslot_mc_port": None,
        "singleslot_enabled": None,
        "cert_crt_exists": None, "cert_key_exists": None,
        "cert_key_perm_ok": None, "cert_crt_md5": None,
        "mzio_bin": None, "mzio_running": None, "mzio_init": None,
    }


# Task 6: I/O 層 — DBP 收發、pty-SSH、host-key 指紋、HTTP/REST 探測
import socket, time, os, pty, select, signal, hashlib, subprocess, ssl, urllib.request, urllib.error
import getpass
from concurrent.futures import ThreadPoolExecutor


SSH_PORT = 9521
SSH_USER = "root"
_SSH_OPTS = ["-p", str(SSH_PORT), "-oHostKeyAlgorithms=+ssh-rsa",
             "-oPubkeyAcceptedAlgorithms=+ssh-rsa",
             "-oKexAlgorithms=+diffie-hellman-group-exchange-sha256,"
             "diffie-hellman-group14-sha1,diffie-hellman-group1-sha1",
             "-oStrictHostKeyChecking=no", "-oUserKnownHostsFile=/dev/null",
             "-oConnectTimeout=8", "-oNumberOfPasswordPrompts=1", "-oLogLevel=ERROR"]


def dbp_sweep(broadcast, targets, timeout=4.0, retries=3):
    """broadcast=True 對 255.255.255.255 廣播；否則對 targets 逐台 unicast。回原始回應 dict 列表。"""
    req = build_dbp_request()
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    sock.bind(("", 0))
    sock.settimeout(0.5)
    dests = ["255.255.255.255"] if broadcast else targets
    replies, deadline, next_send, sent = [], time.time() + timeout, 0.0, 0
    try:
        while time.time() < deadline:
            if sent < retries and time.time() >= next_send:
                for d in dests:
                    try:
                        sock.sendto(req, (d, DBP_PORT))
                    except OSError:
                        pass
                sent += 1
                next_send = time.time() + 0.6
            try:
                data, _addr = sock.recvfrom(4096)
                r = parse_dbp_reply(data)
                if r:
                    replies.append(r)
            except OSError:  # socket.timeout 是 OSError 子類，此捕捉包含廣播 unicast 時的 ConnectionRefusedError 等
                pass
    finally:
        sock.close()
    return replies


def ssh_run(ip, pw, cmd, timeout=15.0, done=b"===END==="):
    """泛化版單次 SSH（原 ssh_probe 本體；mzstate mark 等重用）。回 (輸出, None) 或 (None, 錯誤字串)。

    重要約束：必須保持 pty.fork + os.execvp(argv list) 形式，絕不改成 shell=True 或本地 shell 拼接。
    這保證 cmd 內的 $$ 在遠端 busybox sh 展開（每連線唯一 PID），避免本地展開造成的測檔名撞名。
    """
    argv = ["ssh", *_SSH_OPTS, "%s@%s" % (SSH_USER, ip), cmd]
    pid, fd = pty.fork()
    if pid == 0:
        try:
            os.execvp(argv[0], argv)
        except OSError:
            pass
        os._exit(127)
    buf, sent, deadline = b"", False, time.time() + timeout
    try:
        while time.time() < deadline:
            r, _, _ = select.select([fd], [], [], 0.5)
            if fd not in r:
                continue
            try:
                d = os.read(fd, 4096)
            except OSError:
                break
            if not d:
                break
            buf += d
            if not sent and b"assword" in buf:
                os.write(fd, (pw + "\n").encode())
                sent = True
            if done in buf:
                break
    finally:
        try:
            os.close(fd)
        except OSError:
            pass
        try:
            os.kill(pid, signal.SIGKILL)   # timeout/異常時殺殘留 ssh
        except OSError:
            pass
        try:
            os.waitpid(pid, 0)
        except OSError:
            pass
    out = buf.decode("utf-8", "replace")
    if done.decode() not in out:
        return None, "ssh timeout/incomplete (%d bytes)" % len(buf)
    return out, None


def ssh_probe(ip, pw, timeout=15.0):
    """單次 SSH 跑 PROBE_CMD（相容包裝）。"""
    return ssh_run(ip, pw, PROBE_CMD, timeout)


def _parse_keyscan_line(line):
    """Parse single ssh-keyscan output line, return SHA256 fingerprint or None if invalid."""
    if line.startswith("#"):
        return None
    parts = line.split()
    if len(parts) < 3:
        return None
    try:
        digest = hashlib.sha256(base64.b64decode(parts[2])).digest()
        return "SHA256:" + base64.b64encode(digest).decode().rstrip("=")
    except (ValueError, Exception):  # ValueError/binascii.Error for malformed base64
        return None


def _remaining(deadline, floor=1):
    """單台總預算 deadline 剩餘秒數，下限 floor（避免 0/負值傳給下游 timeout 參數）。"""
    return max(floor, deadline - time.time())


def hostkey_fp(ip, timeout=8):
    """ssh-keyscan -t rsa → SHA256 指紋（base64 key 部分）。失敗回 None。"""
    try:
        keyscan_t = max(1, int(round(timeout)))
        out = subprocess.run(["ssh-keyscan", "-p", str(SSH_PORT), "-T", str(keyscan_t),
                              "-t", "rsa", ip],
                             capture_output=True, text=True, timeout=timeout + 4).stdout
    except (subprocess.TimeoutExpired, OSError):
        return None
    for line in out.splitlines():
        fp = _parse_keyscan_line(line)
        if fp:
            return fp
    return None


def _http_get(url, headers=None, timeout=5, insecure=False):
    ctx = ssl._create_unverified_context() if insecure else None
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            body = resp.read(512)
            isjson = body.lstrip()[:1] in (b"{", b"[")
            return {"ok": True, "status": resp.status, "json": isjson}
    except urllib.error.HTTPError as e:
        return {"ok": True, "status": e.code, "json": False}
    except (urllib.error.URLError, OSError, ssl.SSLError):
        return None


def http_probe(ip, timeout=5):
    """跳板機側 web 行為探測（不持設備 web token、不登入）。

    Task 8 真機實查：REST :8090 為 mzrelay3 啟動參數固定 bind 在 127.0.0.1（loopback-only 安全設計），
    跳板機遠端連線必被拒——sidecar_rest_ok 改經 SSH 在設備本機以 nc 探測（見 PROBE_CMD 的 REST8090 段/
    parse_probe_output），不再由本函式負責。
    """
    http80 = _http_get("http://%s/auth/login" % ip, timeout=timeout)
    https = _http_get("https://%s/get/device/status" % ip, insecure=True, timeout=timeout)
    return {"http80": http80, "https": https}


# Task 7: inventory 組裝、原子輸出、摘要表、probe_device、CLI main
SCHEMA_VERSION = "2"
PRODUCER = "mzscan/2.0"

def build_inventory(rows, recon, expect_meta, started, finished):
    fin = datetime.datetime.fromisoformat(finished)
    inv = {"schema_version": SCHEMA_VERSION, "scan_id": str(uuid.uuid4()),
           "producer": PRODUCER, "started_at": started, "finished_at": finished,
           "valid_until": (fin + datetime.timedelta(hours=24)).isoformat()}
    if expect_meta is None:
        # discovery report 模式：不產 action（spec §五）
        rows = [{k: v for k, v in r.items() if k != "action"} for r in rows]
    else:
        inv["expect_file"] = expect_meta
        inv["reconciliation"] = recon
    counts = collections.Counter(r.get("action", "discovered") for r in rows)
    inv["summary"] = dict(counts)
    inv["devices"] = rows
    return inv

def write_atomic(path, obj):
    tmp = path + (".tmp.%d" % os.getpid())
    with open(tmp, "w") as fh:
        json.dump(obj, fh, ensure_ascii=False, indent=1)
    os.replace(tmp, path)

def summary_table(inv):
    lines = ["== mzscan %s  devices=%d ==" % (inv["scan_id"][:8], len(inv["devices"]))]
    for action, n in sorted(inv["summary"].items()):
        ips = [d["ip"] for d in inv["devices"] if d.get("action", "discovered") == action]
        lines.append("  %-22s %3d  %s" % (action, n, " ".join(ips[:8])
                                          + (" …" if len(ips) > 8 else "")))
    recon = inv.get("reconciliation")
    if recon:
        lines.append("  missing=%s unexpected=%s mac_mismatch=%d"
                     % (recon["missing"] or "-", recon["unexpected"] or "-",
                        len(recon["mac_mismatch"])))
    return "\n".join(lines)


# Task 8 定稿：mzweb-arm build md5（2026-07-23 build，401888 bytes；
# 來源：`md5sum docs/multi-zone-poc/src/mzweb/build/mzweb-arm`）。
# 真機 .70 交叉驗證：/etc/sipweb/sipweb md5 與本地 build 相同，無需額外收錄舊值。
MZWEB_KNOWN_MD5S = {"170631635316f2b2ca7aa20e91a81e47"}
# main() 若帶 --mzweb-bin 會再 add() 本地覆蓋值（見 main()），供現場帶不同 build 時使用。

_PROBE_UNKNOWN_CHECK_KEYS = ("termapp_md5", "sipweb_md5", "opt_writable", "loopback80_403",
                             "sidecar_relay_bin", "sidecar_relay_running", "sidecar_init",
                             "opt_free_kb", "sidecar_rest_ok")

def probe_device(ip, dbp_rec, pw, timeout=15.0):
    """單台完整深探組 row。任何未預期例外皆保底回傳含 crashed 錯誤的 row，絕不讓 ex.map 整批中斷。"""
    try:
        deadline = time.time() + timeout
        row = {"ip": ip, "mac": (dbp_rec or {}).get("mac"),
               "fw_ver_dbp": (dbp_rec or {}).get("fw_ver_dbp"),
               "reachable_dbp": dbp_rec is not None,
               "dbp_conflict": bool((dbp_rec or {}).get("dbp_conflict")), "errors": []}
        if row["dbp_conflict"]:
            row["dbp_variants"] = dbp_rec["dbp_variants"]
        row["ssh_hostkey_fp"] = hostkey_fp(ip, timeout=_remaining(deadline))
        if row["ssh_hostkey_fp"] is None:
            row["errors"].append("ssh_hostkey_fp unknown (keyscan failed)")
        out, err = ssh_probe(ip, pw, _remaining(deadline))
        row["ssh_ok"] = out is not None
        if err:
            row["errors"].append(err)
        facts = parse_probe_output(out) if out else dict.fromkeys(
            ("termapp_md5", "sipweb_md5", "sidecar_relay_bin", "sidecar_relay_running",
             "sidecar_init", "opt_writable", "opt_free_kb", "loopback80_403",
             "termapp_multicast_addr", "sidecar_rest_ok"))
        row.update(facts)
        row.update(parse_probe_v2(out) if out else v2_none_facts())
        hp = http_probe(ip, timeout=_remaining(deadline))
        row["fw_ver"] = decide_fw_ver(facts["termapp_md5"], row["fw_ver_dbp"])
        row["web_type"] = decide_web_type(facts["sipweb_md5"], MZWEB_KNOWN_MD5S,
                                          hp["https"], hp["http80"], facts["loopback80_403"])
        if row["fw_ver"] == "unknown":
            row["errors"].append(
                "fw_ver unknown (termapp_md5=%r dbp_ver=%r: md5/DBP 矛盾或雙缺)"
                % (facts["termapp_md5"], row["fw_ver_dbp"]))
        if row["web_type"] == "unknown":
            row["errors"].append(
                "web_type unknown (sipweb_md5=%r https=%r http80=%r loopback80_403=%r)"
                % (facts["sipweb_md5"], hp["https"], hp["http80"], facts["loopback80_403"]))
        for k in _PROBE_UNKNOWN_CHECK_KEYS:
            if facts.get(k) is None:
                row["errors"].append("probe %s unknown" % k)
        return row
    except Exception as e:  # 保底：任何未預期例外都不能讓整批 ex.map 中斷
        return {"ip": ip, "mac": None, "fw_ver_dbp": None, "reachable_dbp": None,
                "dbp_conflict": False, "ssh_hostkey_fp": None, "ssh_ok": None,
                "termapp_md5": None, "sipweb_md5": None, "sidecar_relay_bin": None,
                "sidecar_relay_running": None, "sidecar_init": None, "opt_writable": None,
                "opt_free_kb": None, "loopback80_403": None, "termapp_multicast_addr": None,
                "sidecar_rest_ok": None, "fw_ver": "unknown", "web_type": "unknown",
                "errors": ["probe_device crashed: %r" % (e,)], **v2_none_facts()}

def main(argv=None):
    ap = argparse.ArgumentParser(description="gt-sip-gw fleet pre-flight scanner")
    ap.add_argument("--expect", help="fleet.txt: IP[,MAC] per line")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--timeout", type=float, default=15.0)
    ap.add_argument("--mzweb-bin", help="local mzweb-arm build to trust as mzweb md5")
    ap.add_argument("--manifest", help="mzmanifest.json to trust its mzweb md5 (spec D+E §七)")
    ap.add_argument("--out", default=".", help="output dir")
    args = ap.parse_args(argv)
    pw = os.environ.get("MZSCAN_SSH_PW")
    if pw is None and sys.stdin.isatty():
        pw = getpass.getpass("MZSCAN_SSH_PW (root SSH password): ")
    if pw is None:
        print("MZSCAN_SSH_PW not set", file=sys.stderr)
        return 2
    if args.mzweb_bin:
        MZWEB_KNOWN_MD5S.add(hashlib.md5(open(args.mzweb_bin, "rb").read()).hexdigest())
    if args.manifest:
        MZWEB_KNOWN_MD5S.add(json.load(open(args.manifest))["components"]["mzweb"]["md5"])
    if not MZWEB_KNOWN_MD5S:
        # 正常執行下 MZWEB_KNOWN_MD5S 恆非空（Task 8 已內嵌定稿常數）；此分支只在該常數被
        # 上游意外清空/覆寫成空集合時才會觸發，保留作防禦性檢查——非空時 web_type 永不可能
        # 判為 mzweb，等同該次掃描 mzweb 偵測整批失效，值得警示。
        print("WARNING: MZWEB_KNOWN_MD5S is empty; web_type will never classify as mzweb "
              "this run (use --mzweb-bin to add a local build md5, or check the constant "
              "wasn't cleared)", file=sys.stderr)
    started = datetime.datetime.now().isoformat(timespec="seconds")

    expected = None
    if args.expect is not None:
        expected = parse_fleet(open(args.expect).read())
        if not expected:
            print("--expect file has no valid entries: %s" % args.expect, file=sys.stderr)
            return 2
    discovered = merge_discovery(dbp_sweep(broadcast=True, targets=[]))
    if expected is not None:           # missing 台 unicast 補掃（spec §七）
        missing = [e["ip"] for e in expected if e["ip"] not in discovered]
        if missing:
            discovered.update(merge_discovery(dbp_sweep(broadcast=False, targets=missing)))
    targets = sorted(set(discovered) | ({e["ip"] for e in expected} if expected is not None else set()))
    print("discovered %d, probing %d ..." % (len(discovered), len(targets)))

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        rows = list(ex.map(lambda ip: probe_device(ip, discovered.get(ip), pw, args.timeout),
                           targets))
    # 先算 dups、標 hostkey_dup，再對每台 classify（classify 讀 hostkey_dup 欄，順序不可顛倒）
    dups = find_hostkey_dups(rows)
    for r in rows:
        r["hostkey_dup"] = r.get("ssh_hostkey_fp") in dups
    if expected is not None:
        for r in rows:
            r["action"] = classify(r)
            if r["action"] == "needs-sidecar" and sidecar_partial(r):
                r["sidecar_partial"] = True
    if dups:
        print("!! duplicate host-key fingerprints (possible MITM): %s" % dups, file=sys.stderr)

    finished = datetime.datetime.now().isoformat(timespec="seconds")
    recon = reconcile(expected, discovered) if expected is not None else None
    meta = {"file": args.expect, "count": len(expected)} if expected is not None else None
    inv = build_inventory(rows, recon, meta, started, finished)
    out_path = os.path.join(args.out, "inventory-%s.json"
                            % datetime.datetime.now().strftime("%Y%m%d-%H%M%S"))
    write_atomic(out_path, inv)
    print(summary_table(inv))
    print("inventory: %s" % out_path)
    return 0

if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
# mzstate.py — side-car 版本標記/冪等判定＋完整性鎖定（子專案 D+E）
# Spec: docs/superpowers/specs/2026-07-24-mzstate-version-lock-design.md (v2.1)
import argparse, datetime, hashlib, json, os, re, sys, subprocess, socket, ssl

COMPONENTS = ("mzrelay3", "mzweb", "mzio", "S21mzrelay", "S21mzio")

EXIT_READY = 0
EXIT_USAGE = 2
EXIT_NEEDS_DEPLOY = 10
EXIT_NEEDS_FW_UPGRADE = 11
EXIT_DRIFT = 12
EXIT_NOT_READY_CONFIG = 13
EXIT_UNKNOWN_FW = 14
EXIT_NEEDS_MARK = 15
EXIT_UNREACHABLE = 20
EXIT_PROBE_INCOMPLETE = 21
EXIT_SCHEMA_MISMATCH = 22
EXIT_STALE_INVENTORY = 23

_MD5_HEX = re.compile(r"^[0-9a-f]{32}$")


class ManifestError(Exception):
    pass


class SchemaMismatch(Exception):
    pass


class StaleInventory(Exception):
    pass


def load_manifest(path):
    try:
        m = json.load(open(path))
    except (OSError, ValueError) as e:
        raise ManifestError("manifest unreadable: %s" % e)
    if m.get("schema_version") != "1":
        raise ManifestError("manifest schema_version must be '1'")
    comps = m.get("components") or {}
    for name in COMPONENTS:
        c = comps.get(name)
        if not c or not c.get("path") or not _MD5_HEX.match(c.get("md5") or ""):
            raise ManifestError("manifest component %s missing/bad md5" % name)
    t = m.get("termapp") or {}
    if not t.get("known_versions") or not t.get("desired_version"):
        raise ManifestError("manifest termapp section incomplete")
    cfg = m.get("config") or {}
    if not cfg.get("mc_out_group") or not isinstance(cfg.get("mc_out_port"), int):
        raise ManifestError("manifest config section incomplete")
    return m


def manifest_digest(path):
    return hashlib.md5(open(path, "rb").read()).hexdigest()


# gen-manifest：build 產物相對 src_dir 的固定路徑
_BUILD_PATHS = {"mzrelay3": "mzrelay3", "mzweb": "mzweb/build/mzweb-arm",
                "mzio": "mzweb/build/mzio-arm", "S21mzrelay": "S21mzrelay",
                "S21mzio": "S21mzio"}
_DEVICE_PATHS = {"mzrelay3": "/opt/mzrelay3", "mzweb": "/etc/sipweb/sipweb",
                 "mzio": "/opt/mzio", "S21mzrelay": "/etc/init.d/S21mzrelay",
                 "S21mzio": "/etc/init.d/S21mzio"}
_DEFAULT_TERMAPP = {"path": "/opt/termapp",
                    "known_versions": {"b0eed3b30bd4fa4f1599a9475296fb6d": "2.1.1"},
                    "desired_version": "2.1.1"}
_DEFAULT_CONFIG = {"mc_out_group": "239.192.1.1", "mc_out_port": 2000}


def gen_manifest(src_dir, release, out_path, prev):
    comps = {}
    for name in COMPONENTS:   # 先驗全部產物在，才寫檔（fail-closed，不產半份）
        p = os.path.join(src_dir, _BUILD_PATHS[name])
        if not os.path.isfile(p):
            raise ManifestError("missing build artifact: %s" % p)
        comps[name] = {"path": _DEVICE_PATHS[name],
                       "md5": hashlib.md5(open(p, "rb").read()).hexdigest()}
    out = {"schema_version": "1", "release": release, "components": comps,
           "termapp": (prev or {}).get("termapp") or _DEFAULT_TERMAPP,
           "config": (prev or {}).get("config") or _DEFAULT_CONFIG}
    tmp = out_path + ".tmp.%d" % os.getpid()
    with open(tmp, "w") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)
    os.replace(tmp, out_path)


def component_state(desired_md5, marker_md5, actual):
    """spec §5.1 六列矩陣。drift 需要 marker 基準線（no-marker-no-drift）。"""
    if actual["state"] == "error":
        return "unknown"
    if actual["state"] == "absent":
        return "missing"
    if actual["md5"] == desired_md5:
        return "ok"
    if marker_md5 is None:
        return "missing"          # 無基準線：工廠機/rollback 後 → 走重佈收斂
    if actual["md5"] == marker_md5:
        return "outdated"
    return "drift"


def decide_fw(termapp_md5, dbp_ver, manifest):
    """spec §5.2 md5 優先層級：known md5 為直接證據；未知 md5 才需 DBP 交叉。"""
    if termapp_md5 is None:
        return "probe_error", []
    known = manifest["termapp"]["known_versions"]
    desired = manifest["termapp"]["desired_version"]
    if termapp_md5 in known:
        ver = known[termapp_md5]
        if ver == desired:
            return "ok", []
        w = ([] if dbp_ver in (None, ver) else
             ["termapp md5 says %s but DBP says %r" % (ver, dbp_ver)])
        return "needs_upgrade", w
    if dbp_ver == "2.1.0":
        return "needs_upgrade", []
    return "unknown_fw", []


VERDICT_BY_EXIT = {0: "READY", 10: "NEEDS_DEPLOY", 11: "NEEDS_FW_UPGRADE",
                   12: "DRIFT", 13: "NOT_READY_CONFIG", 14: "UNKNOWN_FW",
                   15: "NEEDS_MARK", 20: "UNREACHABLE", 21: "PROBE_INCOMPLETE"}

_DEPLOY_ACTION = {"mzrelay3": "deploy_mzrelay3", "S21mzrelay": "deploy_mzrelay3",
                  "mzweb": "install_mzweb", "mzio": "install_mzio",
                  "S21mzio": "install_mzio"}


def parse_marker(raw):
    """Parse mzstate marker JSON; strict schema_version==1 guard."""
    if raw is None or len(raw) > 8192:
        return None
    try:
        m = json.loads(raw)
    except ValueError:
        return None
    return m if isinstance(m, dict) and m.get("schema_version") == "1" else None


def decide_device(row, manifest, cert):
    """spec §5.3 整機裁決優先序。回 verdict/exit_code/required_actions/checks/..."""
    ip = row.get("ip")
    out = {"ip": ip, "components": {}, "checks": {}, "warnings": [], "reasons": []}

    def fin(code, actions, reason=None):
        out["verdict"] = VERDICT_BY_EXIT[code]
        out["exit_code"] = code
        out["required_actions"] = actions
        if reason:
            out["reasons"].append(reason)
        return out

    if not row.get("ssh_ok"):
        return fin(EXIT_UNREACHABLE, ["retry_probe"], "ssh probe failed")

    marker_info = row.get("mzstate_marker") or {"state": "error", "raw": None}
    marker = parse_marker(marker_info.get("raw")) if marker_info["state"] == "present" else None
    if marker_info["state"] == "present" and marker is None:
        out["warnings"].append("marker unparseable — treated as absent")
    mcomp = (marker or {}).get("components", {})

    # 元件態
    states = {}
    for name in COMPONENTS:
        actual = (row.get("sidecar_md5s") or {}).get(name) or {"state": "error", "md5": None}
        st = component_state(manifest["components"][name]["md5"],
                             (mcomp.get(name) or {}).get("md5"), actual)
        states[name] = st
        out["components"][name] = {"state": st, "actual_md5": actual.get("md5"),
                                   "marker_md5": (mcomp.get(name) or {}).get("md5")}

    # checks（觀測值；判定必需清單 null → 21）
    fw_status, fw_warn = decide_fw(row.get("termapp_md5"), row.get("fw_ver_dbp"), manifest)
    out["warnings"] += fw_warn
    c = out["checks"]
    c["termapp_fw"] = manifest["termapp"]["known_versions"].get(row.get("termapp_md5"))
    c["singleslot_mc"] = (None if row.get("singleslot_mc_addr") is None
                          else "%s:%s" % (row["singleslot_mc_addr"],
                                          row.get("singleslot_mc_port")))
    c["singleslot_enabled"] = row.get("singleslot_enabled")
    c["relay_running"] = row.get("sidecar_relay_running")
    c["rest_ok"] = row.get("sidecar_rest_ok")
    c["mzio_running"] = row.get("mzio_running")
    c["mzweb_https_ok"] = cert.get("tls_ok")
    c["cert_files_ok"] = (row.get("cert_crt_exists") and row.get("cert_key_exists")
                          and row.get("cert_key_perm_ok"))
    if cert.get("tls_ok"):          # 服務活著才驗 SAN/效期；掛掉走 restart 路徑
        c["cert_san_ok"], c["cert_expiry_ok"] = cert.get("san_ok"), cert.get("expiry_ok")
    else:
        c["cert_san_ok"] = c["cert_expiry_ok"] = "n/a-service-down"

    # 21 A 層：無條件必需事實（元件 md5/termapp/marker 可讀性）——缺任一不得做任何裁決。
    # B 層（服務/config 事實）只在元件全 ok、進入 13/15/READY 判定前才必需：
    # 站內 .140 實測（2026-07-24）——工廠未部署機 rest_ok/singleslot 天然 None（無 sidecar、
    # 工廠 ifcfg 無鍵），若無條件擋 21 會讓整批工廠機卡在重試佇列進不了 10。
    required_null = ([n for n, s in states.items() if s == "unknown"]
                     + (["termapp_md5"] if fw_status == "probe_error" else []))
    if marker_info["state"] == "error":
        required_null.append("mzstate_marker")
    if required_null:
        return fin(EXIT_PROBE_INCOMPLETE, ["retry_probe"],
                   "probe incomplete: %s" % ",".join(sorted(set(required_null))))

    if fw_status == "unknown_fw":
        return fin(EXIT_UNKNOWN_FW, ["manual_review"],
                   "termapp md5 %s unclassifiable (no DBP cross-evidence)"
                   % row.get("termapp_md5"))
    if fw_status == "needs_upgrade":
        acts = ["fw_upgrade"]
        return fin(EXIT_NEEDS_FW_UPGRADE, acts, "termapp is %s, desired %s"
                   % (c["termapp_fw"] or "old", manifest["termapp"]["desired_version"]))
    drifted = [n for n in COMPONENTS if states[n] == "drift"]
    if drifted:
        return fin(EXIT_DRIFT, ["manual_review"],
                   "drift (actual≠marker≠desired): %s" % ",".join(drifted))
    need = [n for n in COMPONENTS if states[n] in ("missing", "outdated")]
    if need:
        acts = []
        for n in COMPONENTS:                       # 固定順序去重
            if n in need and _DEPLOY_ACTION[n] not in acts:
                acts.append(_DEPLOY_ACTION[n])
        for n in need:
            out["reasons"].append("%s: %s" % (n, states[n]))
        return fin(EXIT_NEEDS_DEPLOY, acts)

    # 21 B 層：元件全 ok 才走到這裡——config/服務判定（13/15/READY）前，其必需事實不得為 None。
    # 例外（對抗審查 I-1）：relay_running is False 是 down 的定性鐵證，此時 rest_ok 天然 None
    # （daemon 沒 listening→nc 連線拒→零輸出），不算探測不完整——放行到 13 走 restart_services。
    service_null = ([k for k in ("singleslot_mc", "singleslot_enabled", "relay_running",
                                 "mzio_running", "cert_files_ok",
                                 "mzweb_https_ok") if c[k] is None]
                    + (["rest_ok"] if c["rest_ok"] is None
                       and c["relay_running"] is not False else [])
                    + (["cert_san_ok"] if c["cert_san_ok"] is None else [])
                    + (["cert_expiry_ok"] if c["cert_expiry_ok"] is None else []))
    if service_null:
        return fin(EXIT_PROBE_INCOMPLETE, ["retry_probe"],
                   "probe incomplete (config-stage facts): %s"
                   % ",".join(sorted(set(service_null))))

    # 13：config/runtime
    acts, why = [], []
    if not (c["relay_running"] and c["rest_ok"] and c["mzweb_https_ok"]
            and c["mzio_running"]):
        acts.append("restart_services"); why.append("service down")
    if c["cert_san_ok"] is False or c["cert_expiry_ok"] is False or not c["cert_files_ok"]:
        acts.append("regen_cert"); why.append("cert invalid")
    desired_mc = "%s:%s" % (manifest["config"]["mc_out_group"],
                            manifest["config"]["mc_out_port"])
    if c["singleslot_mc"] != desired_mc or c["singleslot_enabled"] is not True:
        acts.append("fix_singleslot"); why.append("singleslot %r != %s"
                                                  % (c["singleslot_mc"], desired_mc))
    if acts:
        return fin(EXIT_NOT_READY_CONFIG, acts, "; ".join(why))

    # 15：全就緒唯標記
    stale = (marker is None or
             any((mcomp.get(n) or {}).get("md5") != manifest["components"][n]["md5"]
                 for n in COMPONENTS))
    if stale:
        return fin(EXIT_NEEDS_MARK, ["mark"], "marker missing/stale")

    # cert md5 漂移 warning（不擋 READY）
    mk_crt = ((marker or {}).get("cert") or {}).get("crt_md5")
    if mk_crt and row.get("cert_crt_md5") and mk_crt != row["cert_crt_md5"]:
        out["warnings"].append("cert crt_md5 drifted since deploy (legit re-keygen?)")
    return fin(EXIT_READY, [])


def have_openssl():
    try:
        return subprocess.run(["openssl", "version"], capture_output=True,
                              timeout=10).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def san_matches(text, ip):
    """SAN 比對：IP Address:<ip> token 精確相等（禁止子字串誤放行，spec §六）。"""
    return bool(re.search(r"IP Address:%s(?=[,\s]|$)" % re.escape(ip), text))


def inspect_der(der, ip):
    """DER 餵跳板機 openssl；回 (san_ok, expiry_ok)。"""
    p = subprocess.run(["openssl", "x509", "-inform", "DER", "-noout",
                        "-checkend", "0", "-text"],
                       input=der, capture_output=True, timeout=15)
    expiry_ok = p.returncode == 0            # -checkend 0：過期→rc 1
    return san_matches(p.stdout.decode("utf-8", "replace"), ip), expiry_ok


def check_cert(ip, port=443, timeout=8):
    """B 端 TLS 握手取 DER→openssl 驗 SAN/效期（spec §六）。
    openssl 缺→三欄全 None（→21）；TLS 連線失敗→tls_ok=False（→13 restart 路徑）。"""
    if not have_openssl():
        return {"tls_ok": None, "san_ok": None, "expiry_ok": None}
    ctx = ssl._create_unverified_context()
    try:
        with socket.create_connection((ip, port), timeout=timeout) as s:
            with ctx.wrap_socket(s, server_hostname=ip) as tls:
                der = tls.getpeercert(binary_form=True)
    except (OSError, ssl.SSLError):
        return {"tls_ok": False, "san_ok": None, "expiry_ok": None}
    san_ok, expiry_ok = inspect_der(der, ip)
    return {"tls_ok": True, "san_ok": san_ok, "expiry_ok": expiry_ok}


# --- mark：all-or-nothing 寫標/刪條目/lock（spec §四）---

def merge_marker(existing, actuals, components, delete, release, now_iso, crt_md5):
    for x in delete:
        if x not in COMPONENTS:
            raise ValueError("--delete only accepts component names (not %r); "
                             "cert entry is only-update" % x)
    m = {"schema_version": "1", "release": release, "written_at": now_iso,
         "components": dict(((existing or {}).get("components") or {})),
         "cert": dict(((existing or {}).get("cert") or {"crt_md5": None}))}
    for name in components:
        m["components"][name] = {"md5": actuals[name], "deployed_at": now_iso}
    for name in delete:
        m["components"].pop(name, None)
    if crt_md5 is not None:
        m["cert"]["crt_md5"] = crt_md5
    return m


MARK_PROBE_CMD = (
    'echo "===MD5SIDECAR==="; md5sum /opt/mzrelay3 /etc/sipweb/sipweb /opt/mzio'
    ' /etc/init.d/S21mzrelay /etc/init.d/S21mzio 2>&1;'
    'echo "===CRT==="; md5sum /etc/sipweb/mz.crt 2>/dev/null;'
    # MZSTATE 放最後：marker 內容注入 ===END=== 只損 marker 段（同 mzscan M-3 防護）
    'echo "===MZSTATE==="; head -c 8192 /opt/mzstate.json 2>&1; echo;'
    'echo "===END==="')


def _mark_probe(ip, pw):
    import mzscan
    out, err = mzscan.ssh_run(ip, pw, MARK_PROBE_CMD)
    if out is None:
        return None, None, err
    s = mzscan._sections(out)
    actuals = {n: mzscan._md5_tristate(s.get("MD5SIDECAR", ""), p)
               for n, p in mzscan._SIDECAR_PATHS.items()}
    body = s.get("MZSTATE", "").strip()
    raw = None if ("No such file" in body or not body) else body
    mm = re.search(r"^([0-9a-f]{32})\s", s.get("CRT", ""), re.M)
    return actuals, raw, (mm.group(1) if mm else None)


def _pid_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except (PermissionError, OSError):
        return True   # 無法確認就當存活（保守，不誤收）


def lock_is_stale(owner_text, now_epoch, local_hostname, pid_alive_fn=_pid_alive):
    """owner 格式 '<hostname> <pid> <epoch>'。同主機、齡>120s、pid 已死 → 可自動回收
    （spec §四縱深政策落地；異主機/解析失敗 → False，維持人工 break-glass）。"""
    try:
        host, pid_s, ts_s = owner_text.split()[:3]
        pid, ts = int(pid_s), int(ts_s)
    except (ValueError, IndexError):
        return False
    if host != local_hostname or now_epoch - ts <= 120:
        return False
    return not pid_alive_fn(pid)


def _try_lock(ip, pw, hostname):
    import mzscan
    # if/then 而非 && 鏈：mkdir 成功但 owner 寫失敗不得回 LOCK_FAIL（會留殘鎖假死）
    lock_cmd = ('if mkdir /opt/.mzstate.lock 2>/dev/null; then'
                ' echo "%s %d $(date +%%s)" > /opt/.mzstate.lock/owner 2>/dev/null;'
                ' echo LOCK_OK;'
                ' else echo LOCK_FAIL; cat /opt/.mzstate.lock/owner 2>/dev/null; date +%%s;'
                ' fi; echo "===END==="' % (hostname, os.getpid()))
    return mzscan.ssh_run(ip, pw, lock_cmd)


def _mark_put(ip, pw, marker_obj):
    """lock（owner 檔＋同主機死鎖自動回收）→ 上傳 tmp → md5 複驗 → mv+sync → unlock。
    失敗 raise RuntimeError。

    注意：上傳走 mzctl.py put（其密碼為 fleet 統一 root 密碼常數）；ssh_run 用 MZSCAN_SSH_PW。
    fleet 密碼若日後分裂，兩者須一起改。"""
    import mzscan, tempfile
    src_dir = os.path.dirname(os.path.abspath(__file__))
    hostname = socket.gethostname()
    out, err = _try_lock(ip, pw, hostname)
    if out and "LOCK_FAIL" in out:
        # 對抗審查 M-2：檢查殘鎖是否為本主機已死 worker 所留——是則自動回收重試一次
        lines = [l.strip() for l in out.replace("\r", "").splitlines() if l.strip()]
        owner_line = next((l for l in lines if l.split()[:1] and not l.startswith("LOCK")
                           and len(l.split()) >= 3), "")
        now_line = next((l for l in reversed(lines) if l.isdigit()), "0")
        if lock_is_stale(owner_line, int(now_line), hostname):
            mzscan.ssh_run(ip, pw, 'rm -rf /opt/.mzstate.lock; echo "===END==="')
            out, err = _try_lock(ip, pw, hostname)
    if not out or "LOCK_OK" not in out:
        raise RuntimeError("marker lock busy/failed on %s (%s) — "
                           "inspect /opt/.mzstate.lock/owner; break-glass: "
                           "rm -rf /opt/.mzstate.lock" % (ip, err))
    try:
        fd, local = tempfile.mkstemp(suffix=".json"); os.close(fd)
        with open(local, "w") as fh:
            json.dump(marker_obj, fh, ensure_ascii=False, indent=1)
        remote_tmp = "/opt/.mzstate.upload"
        subprocess.run(["python3", os.path.join(src_dir, "mzctl.py"),
                        "put", local, remote_tmp],
                       env=dict(os.environ, MZHOST=ip),
                       capture_output=True, text=True, timeout=90)
        chk, _ = mzscan.ssh_run(ip, pw,
            'md5sum %s 2>&1; echo "===END==="' % remote_tmp)
        want = hashlib.md5(open(local, "rb").read()).hexdigest()
        if not chk or want not in chk:
            raise RuntimeError("marker upload verify failed on %s" % ip)
        out2, _ = mzscan.ssh_run(ip, pw,
            'mv %s /opt/mzstate.json && sync && echo MV_OK; echo "===END==="'
            % remote_tmp)
        if not out2 or "MV_OK" not in out2:
            raise RuntimeError("marker mv/sync failed on %s" % ip)
    finally:
        mzscan.ssh_run(ip, pw, 'rm -rf /opt/.mzstate.lock; echo "===END==="')


def run_mark(args, manifest, pw, probe_fn, put_fn):
    if args.components is None:
        comps = list(COMPONENTS)
    elif args.components == "":
        comps = []                       # 只刪不驗（mzdeploy rollback 用）
    else:
        comps = [c.strip() for c in args.components.split(",")]
    dele = [c.strip() for c in args.delete.split(",")] if args.delete else []
    bad = [c for c in comps + dele if c not in COMPONENTS]
    if bad:
        print("mark: unknown component(s): %s" % bad, file=sys.stderr); return EXIT_USAGE
    res = probe_fn(args.probe, pw)
    if res[0] is None:
        print("mark: probe failed: %s" % (res[2],), file=sys.stderr); return 1
    actuals, marker_raw, crt_md5 = res
    mism = [n for n in comps
            if actuals[n]["state"] != "present"
            or actuals[n]["md5"] != manifest["components"][n]["md5"]]
    if mism:                                       # all-or-nothing＋防洗白
        for n in mism:
            print("mark: %s actual %r != manifest %s — refusing to mark"
                  % (n, actuals[n], manifest["components"][n]["md5"]), file=sys.stderr)
        return 1
    now = datetime.datetime.now().isoformat(timespec="seconds")
    new = merge_marker(parse_marker(marker_raw),
                       {n: actuals[n]["md5"] for n in comps}, comps, dele,
                       manifest["release"], now, crt_md5)
    try:
        put_fn(args.probe, new)
    except RuntimeError as e:
        print("mark: %s" % e, file=sys.stderr); return 1
    print("marked %s: components=%s delete=%s" % (args.probe, comps, dele))
    return 0


def cmd_mark(args, manifest):
    pw = os.environ.get("MZSCAN_SSH_PW")
    if not pw:
        print("MZSCAN_SSH_PW not set", file=sys.stderr); return EXIT_USAGE
    return run_mark(args, manifest, pw, _mark_probe,
                    lambda ip, obj: _mark_put(ip, pw, obj))


def validate_inventory(inv, allow_stale, now_iso):
    if inv.get("schema_version") != "2":
        raise SchemaMismatch(
            "inventory schema %r not consumable — re-scan with updated mzscan (schema 2)"
            % inv.get("schema_version"))
    vu = inv.get("valid_until")
    if not allow_stale and (not vu or vu < now_iso):
        raise StaleInventory("inventory expired at %s — re-scan (or pass --allow-stale)" % vu)


def build_report(decisions, manifest_release, manifest_digest, scan_id):
    return {"schema_version": "1", "manifest_release": manifest_release,
            "manifest_digest": manifest_digest, "scan_id": scan_id,
            "devices": decisions}


def _human_line(d):
    extra = "" if d["exit_code"] == 0 else " " + "; ".join(d["reasons"])[:120]
    return "%s %s(%d)%s" % (d["ip"], d["verdict"], d["exit_code"], extra)


def _write_json_atomic(path, obj):
    tmp = path + ".tmp.%d" % os.getpid()
    with open(tmp, "w") as fh:
        json.dump(obj, fh, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def main(argv=None):
    ap = argparse.ArgumentParser(prog="mzstate")
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("decide")
    d.add_argument("--inventory"); d.add_argument("--probe")
    d.add_argument("--json"); d.add_argument("--allow-stale", action="store_true")
    d.add_argument("--manifest",
                   default=os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                        "mzmanifest.json"))
    g = sub.add_parser("gen-manifest")
    g.add_argument("--release",
                   default=datetime.date.today().isoformat())
    m = sub.add_parser("mark")     # Task 7 填實作；先佔位以固定 CLI 形狀
    m.add_argument("--probe", required=True)
    m.add_argument("--components"); m.add_argument("--delete")
    m.add_argument("--manifest",
                   default=os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                        "mzmanifest.json"))
    args = ap.parse_args(argv)
    src_dir = os.path.dirname(os.path.abspath(__file__))

    if args.cmd == "gen-manifest":
        out = os.path.join(src_dir, "mzmanifest.json")
        prev = None
        if os.path.exists(out):
            try:
                prev = json.load(open(out))
            except ValueError:
                prev = None
        try:
            gen_manifest(src_dir, args.release, out, prev)
        except ManifestError as e:
            print("gen-manifest: %s" % e, file=sys.stderr); return EXIT_USAGE
        print("wrote %s" % out); return 0

    try:
        manifest = load_manifest(args.manifest)
    except ManifestError as e:
        print("mzstate: %s" % e, file=sys.stderr); return EXIT_USAGE
    mdigest = manifest_digest(args.manifest)

    if args.cmd == "mark":
        return cmd_mark(args, manifest)          # Task 7

    if not have_openssl():
        print("WARNING: openssl not found on jumpbox — cert checks will be null "
              "and devices will verdict PROBE_INCOMPLETE(21)", file=sys.stderr)

    if args.probe:                                # 單台
        pw = os.environ.get("MZSCAN_SSH_PW")
        if not pw:
            print("MZSCAN_SSH_PW not set", file=sys.stderr); return EXIT_USAGE
        import mzscan
        row = mzscan.probe_device(args.probe, None, pw)
        dec = decide_device(row, manifest, check_cert(args.probe))
        print(_human_line(dec))
        if args.json:
            rep = build_report([dec], manifest["release"], mdigest, None)
            _write_json_atomic(args.json, rep)
        return dec["exit_code"]

    if not args.inventory or not args.json:      # 批次：--json 必填
        print("decide batch mode requires --inventory and --json", file=sys.stderr)
        return EXIT_USAGE
    try:
        inv = json.load(open(args.inventory))
    except (OSError, ValueError) as e:
        print("mzstate: bad inventory: %s" % e, file=sys.stderr); return EXIT_USAGE
    now = datetime.datetime.now().isoformat(timespec="seconds")
    try:
        validate_inventory(inv, args.allow_stale, now)
    except SchemaMismatch as e:
        print("mzstate: %s" % e, file=sys.stderr); return EXIT_SCHEMA_MISMATCH
    except StaleInventory as e:
        print("mzstate: %s" % e, file=sys.stderr); return EXIT_STALE_INVENTORY

    decisions = []
    for row in inv.get("devices", []):
        cert = check_cert(row["ip"]) if row.get("ip") and row.get("ssh_ok") else \
               {"tls_ok": None, "san_ok": None, "expiry_ok": None}
        dec = decide_device(row, manifest, cert)
        if args.allow_stale:
            dec["warnings"].append("decided from stale inventory (--allow-stale)")
        decisions.append(dec)
        print(_human_line(dec))
    rep = build_report(decisions, manifest["release"], mdigest, inv.get("scan_id"))
    _write_json_atomic(args.json, rep)
    return 0 if all(x["exit_code"] == 0 for x in decisions) else 1


if __name__ == "__main__":
    sys.exit(main())

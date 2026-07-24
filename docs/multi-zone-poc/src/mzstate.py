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

    # 21：判定必需事實（spec §5.3 清單）
    required_null = ([n for n, s in states.items() if s == "unknown"]
                     + [k for k in ("singleslot_mc", "singleslot_enabled", "relay_running",
                                    "rest_ok", "mzio_running", "cert_files_ok",
                                    "mzweb_https_ok") if c[k] is None]
                     + (["cert_san_ok"] if c["cert_san_ok"] is None else [])
                     + (["cert_expiry_ok"] if c["cert_expiry_ok"] is None else [])
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


def cmd_mark(args, manifest):
    raise NotImplementedError          # Task 7


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
        cert = check_cert(row["ip"]) if row.get("ssh_ok") else \
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

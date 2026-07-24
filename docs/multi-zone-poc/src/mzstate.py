#!/usr/bin/env python3
# mzstate.py — side-car 版本標記/冪等判定＋完整性鎖定（子專案 D+E）
# Spec: docs/superpowers/specs/2026-07-24-mzstate-version-lock-design.md (v2.1)
import argparse, hashlib, json, os, re, sys

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

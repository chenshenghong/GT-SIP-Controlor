# mzstate（D 版本標記/冪等＋E 完整性鎖定）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建 `mzstate.py`（判定核心＋CLI）＋`mzmanifest.json`＋mzscan schema "2" 擴充＋mzdeploy 寫標整合，讓 B 批次編排器對 52 台 fleet 每台機器可判定 skip/F/deploy/config/mark/人工/重試，且可安全重跑。

**Architecture:** 三工具分職——mzscan（感知，SSH 單往返收事實）→ mzstate（裁決，desired/marker/actual 三方比對＋整機優先序）→ mzdeploy（執行，成功後經 `mzstate mark` 寫設備標記檔 `/opt/mzstate.json`）。Spec：`docs/superpowers/specs/2026-07-24-mzstate-version-lock-design.md`（v2.1，雙審通過，**實作時逐節對照**）。

**Tech Stack:** Python 3 stdlib-only（跳板機）、BusyBox sh（設備）、unittest、pty-SSH（沿 mzscan/mzctl 慣例）、跳板機 openssl（cert 解析）。

## Global Constraints

- 全部程式在 `docs/multi-zone-poc/src/` 下；Python **stdlib-only**（跳板機約束，沿 C spec）；設備端只有 BusyBox（無 jq/python/openssl/curl）。
- 測試：`test_mzstate.py` 與 `test_mzscan.py` 同目錄，unittest；跑法 `cd docs/multi-zone-poc/src && python3 -m unittest test_mzstate -v`（回歸連跑 `python3 -m unittest test_mzscan test_mzstate -v`）。
- 退出碼（spec §5.2，逐字）：0 READY／10 NEEDS_DEPLOY／11 NEEDS_FW_UPGRADE／12 DRIFT／13 NOT_READY_CONFIG／14 UNKNOWN_FW／15 NEEDS_MARK／20 UNREACHABLE／21 PROBE_INCOMPLETE；呼叫層 2 usage／22 SCHEMA_MISMATCH／23 STALE_INVENTORY。
- 五件元件名（固定順序）：`mzrelay3, mzweb, mzio, S21mzrelay, S21mzio`；路徑見 manifest。
- 單槽 desired：`239.192.1.1:2000`＋`MULTICAST_ENABLED=true`（`/etc/ifcfg-sip`，2026-07-24 .70 實查定案）。
- 設備 SSH：root/`BcastTerm2`/9521（密碼經 `MZSCAN_SSH_PW` env）；真機驗證用 `.70`（`192.168.0.70`）。
- **開工前跑一次 `bash scripts/gitnexus-fresh.sh`**；最終 commit 前跑 GitNexus `detect_changes()`。
- 每 task 結尾 commit；訊息用 `feat(mzstate):`／`feat(mzscan):`／`fix(mzdeploy):` 前綴。

---

### Task 1: mzmanifest — 載入/驗證/digest＋gen-manifest

**Files:**
- Create: `docs/multi-zone-poc/src/mzstate.py`
- Create: `docs/multi-zone-poc/src/test_mzstate.py`
- Create（由 gen-manifest 產出）: `docs/multi-zone-poc/src/mzmanifest.json`

**Interfaces:**
- Produces: `COMPONENTS`（tuple，上方固定順序）、`load_manifest(path) -> dict`（驗證失敗 raise `ManifestError`）、`manifest_digest(path) -> str`（檔案 md5 hex）、`gen_manifest(src_dir, release, out_path, prev) -> None`（缺產物 raise `ManifestError`）、exit code 常數 `EXIT_READY=0 ... EXIT_STALE_INVENTORY=23`（全表見 Global Constraints）。
- Consumes: 無（首個 task）。

- [ ] **Step 1: 失敗測試**

```python
# test_mzstate.py
import json, os, tempfile, unittest
import mzstate

VALID_MANIFEST = {
    "schema_version": "1", "release": "2026-07-24",
    "components": {
        "mzrelay3":   {"path": "/opt/mzrelay3",          "md5": "a"*32, "version": "p7"},
        "mzweb":      {"path": "/etc/sipweb/sipweb",     "md5": "b"*32, "version": "6.1.2-txio"},
        "mzio":       {"path": "/opt/mzio",              "md5": "c"*32, "version": "1.0"},
        "S21mzrelay": {"path": "/etc/init.d/S21mzrelay", "md5": "d"*32},
        "S21mzio":    {"path": "/etc/init.d/S21mzio",    "md5": "e"*32},
    },
    "termapp": {"path": "/opt/termapp",
                "known_versions": {"b0eed3b30bd4fa4f1599a9475296fb6d": "2.1.1"},
                "desired_version": "2.1.1"},
    "config": {"mc_out_group": "239.192.1.1", "mc_out_port": 2000},
}

def write_tmp_manifest(obj):
    fd, p = tempfile.mkstemp(suffix=".json"); os.close(fd)
    with open(p, "w") as fh: json.dump(obj, fh)
    return p

class TestManifest(unittest.TestCase):
    def test_load_valid(self):
        p = write_tmp_manifest(VALID_MANIFEST)
        m = mzstate.load_manifest(p)
        self.assertEqual(m["components"]["mzweb"]["md5"], "b"*32)
        self.assertEqual(mzstate.COMPONENTS,
                         ("mzrelay3", "mzweb", "mzio", "S21mzrelay", "S21mzio"))

    def test_load_rejects_missing_component(self):
        bad = json.loads(json.dumps(VALID_MANIFEST)); del bad["components"]["mzio"]
        with self.assertRaises(mzstate.ManifestError):
            mzstate.load_manifest(write_tmp_manifest(bad))

    def test_load_rejects_bad_schema(self):
        bad = dict(VALID_MANIFEST, schema_version="9")
        with self.assertRaises(mzstate.ManifestError):
            mzstate.load_manifest(write_tmp_manifest(bad))

    def test_load_rejects_bad_md5(self):
        bad = json.loads(json.dumps(VALID_MANIFEST))
        bad["components"]["mzweb"]["md5"] = "not-a-md5"
        with self.assertRaises(mzstate.ManifestError):
            mzstate.load_manifest(write_tmp_manifest(bad))

    def test_digest_is_file_md5(self):
        p = write_tmp_manifest(VALID_MANIFEST)
        import hashlib
        self.assertEqual(mzstate.manifest_digest(p),
                         hashlib.md5(open(p, "rb").read()).hexdigest())

class TestGenManifest(unittest.TestCase):
    def test_gen_fail_closed_on_missing_artifact(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(mzstate.ManifestError):
                mzstate.gen_manifest(d, "r1", os.path.join(d, "out.json"), prev=None)
            self.assertFalse(os.path.exists(os.path.join(d, "out.json")))

    def test_gen_writes_md5s_and_preserves_termapp(self):
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "mzweb/build"))
            for rel in ("mzrelay3", "mzweb/build/mzweb-arm", "mzweb/build/mzio-arm",
                        "S21mzrelay", "S21mzio"):
                with open(os.path.join(d, rel), "wb") as fh: fh.write(rel.encode())
            out = os.path.join(d, "out.json")
            mzstate.gen_manifest(d, "r1", out, prev=VALID_MANIFEST)
            m = json.load(open(out))
            import hashlib
            self.assertEqual(m["components"]["mzrelay3"]["md5"],
                             hashlib.md5(b"mzrelay3").hexdigest())
            self.assertEqual(m["termapp"], VALID_MANIFEST["termapp"])   # 手寫段保留
            self.assertEqual(m["config"], VALID_MANIFEST["config"])
            self.assertEqual(m["release"], "r1")

if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd docs/multi-zone-poc/src && python3 -m unittest test_mzstate -v`
Expected: FAIL/ERROR（`No module named 'mzstate'`）

- [ ] **Step 3: 最小實作（mzstate.py 起頭）**

```python
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
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd docs/multi-zone-poc/src && python3 -m unittest test_mzstate -v`
Expected: 全 PASS

- [ ] **Step 5: 產出真 manifest 並 commit**

```bash
cd docs/multi-zone-poc/src
python3 -c "import mzstate; mzstate.gen_manifest('.', '2026-07-24', 'mzmanifest.json', None)"
python3 -c "import mzstate; mzstate.load_manifest('mzmanifest.json'); print('manifest OK')"
git add mzstate.py test_mzstate.py mzmanifest.json
git commit -m "feat(mzstate): manifest 載入/驗證/digest＋gen-manifest（fail-closed）"
```

（若 `mzweb/build/mzio-arm` 等產物不在本機，先 `cd mzweb && make arm && make arm-mzio`；仍缺則 gen-manifest 會 fail-closed——此時 manifest 留待有產物的機器產，本 task 其餘照 commit。）

---

### Task 2: mzscan schema "2" — 新事實欄＋ssh_run 泛化＋--manifest

**Files:**
- Modify: `docs/multi-zone-poc/src/mzscan.py`（PROBE_CMD、parse_probe_output、probe_device、SCHEMA_VERSION、main）
- Modify: `docs/multi-zone-poc/src/test_mzscan.py`（既有測試對 schema 的斷言若寫死 "1" 需同步）
- Test: `docs/multi-zone-poc/src/test_mzstate.py`（新增 TestScanV2 類——新 parse 邏輯的測試放這裡，與 D/E 一起維護）

**Interfaces:**
- Produces（schema "2" 每台 row 新欄，供 Task 4 消費）:
  - `sidecar_md5s`: `{comp: {"state": "present"|"absent"|"error", "md5": str|None}}`（五件全鍵）
  - `mzstate_marker`: `{"state": "present"|"absent"|"error", "raw": str|None}`（raw≤8192B）
  - `singleslot_mc_addr: str|None`、`singleslot_mc_port: int|None`、`singleslot_enabled: bool|None`
  - `cert_crt_exists: bool|None`、`cert_key_exists: bool|None`、`cert_key_perm_ok: bool|None`、`cert_crt_md5: str|None`
  - `mzio_bin: bool|None`、`mzio_running: bool|None`、`mzio_init: bool|None`
- Produces: `mzscan.ssh_run(ip, pw, cmd, timeout) -> (out|None, err|None)`（泛化版；`ssh_probe` 變成 `ssh_run(ip, pw, PROBE_CMD, t)` 包裝，供 mzstate mark 重用）
- Consumes: Task 1 無直接依賴（`--manifest` 參數讀 manifest 檔餵 `MZWEB_KNOWN_MD5S`，用 `json.load` 即可、不 import mzstate）。

- [ ] **Step 1: 失敗測試（test_mzstate.py 追加）**

```python
import mzscan

SCAN2_PROBE_SAMPLE = """===MD5SIDECAR===
1111111111111111111111111111aaaa  /opt/mzrelay3
2222222222222222222222222222bbbb  /etc/sipweb/sipweb
md5sum: /opt/mzio: No such file or directory
4444444444444444444444444444dddd  /etc/init.d/S21mzrelay
md5sum: /etc/init.d/S21mzio: No such file or directory
===MZSTATE===
head: /opt/mzstate.json: No such file or directory
===IFCFGSIP===
MULTICAST_ADDRESS=239.192.1.1
MULTICAST_PORT=2000
MULTICAST_ENABLED=true
===CERT===
-rw-r--r--    1 root  root  1234 Jan  1 00:00 /etc/sipweb/mz.crt
-rw-------    1 root  root  1675 Jan  1 00:00 /etc/sipweb/mz.key
9999999999999999999999999999ffff  /etc/sipweb/mz.crt
===MZIO===
/opt/mzio
===END===
"""

class TestScanV2Parse(unittest.TestCase):
    def setUp(self):
        self.f = mzscan.parse_probe_v2(SCAN2_PROBE_SAMPLE)

    def test_sidecar_md5_tristate(self):
        s = self.f["sidecar_md5s"]
        self.assertEqual(s["mzrelay3"], {"state": "present", "md5": "1"*28 + "aaaa"})
        self.assertEqual(s["mzio"], {"state": "absent", "md5": None})
        self.assertEqual(s["S21mzio"], {"state": "absent", "md5": None})

    def test_marker_absent(self):
        self.assertEqual(self.f["mzstate_marker"], {"state": "absent", "raw": None})

    def test_marker_present_raw(self):
        out = SCAN2_PROBE_SAMPLE.replace(
            "head: /opt/mzstate.json: No such file or directory", '{"x":1}')
        f = mzscan.parse_probe_v2(out)
        self.assertEqual(f["mzstate_marker"], {"state": "present", "raw": '{"x":1}'})

    def test_singleslot(self):
        self.assertEqual(self.f["singleslot_mc_addr"], "239.192.1.1")
        self.assertEqual(self.f["singleslot_mc_port"], 2000)
        self.assertIs(self.f["singleslot_enabled"], True)

    def test_cert_facts(self):
        self.assertIs(self.f["cert_crt_exists"], True)
        self.assertIs(self.f["cert_key_exists"], True)
        self.assertIs(self.f["cert_key_perm_ok"], True)   # -rw------- = 0600
        self.assertEqual(self.f["cert_crt_md5"], "9"*28 + "ffff")

    def test_cert_key_perm_bad(self):
        out = SCAN2_PROBE_SAMPLE.replace("-rw-------    1 root  root  1675",
                                         "-rw-r--r--    1 root  root  1675")
        self.assertIs(mzscan.parse_probe_v2(out)["cert_key_perm_ok"], False)

    def test_mzio_facts(self):
        self.assertIs(self.f["mzio_bin"], True)     # ls 有列 /opt/mzio
        self.assertIs(self.f["mzio_init"], False)   # 未列 S21mzio
        self.assertIs(self.f["mzio_running"], False)

    def test_schema_version_is_2(self):
        self.assertEqual(mzscan.SCHEMA_VERSION, "2")
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd docs/multi-zone-poc/src && python3 -m unittest test_mzstate.TestScanV2Parse -v`
Expected: FAIL（`parse_probe_v2` 不存在）

- [ ] **Step 3: 實作 mzscan 擴充**

3a. `PROBE_CMD` 在 `'echo; echo "===END==="'` **之前**插入（維持 END 收尾）：

```python
    'echo "===MD5SIDECAR==="; md5sum /opt/mzrelay3 /etc/sipweb/sipweb /opt/mzio'
    ' /etc/init.d/S21mzrelay /etc/init.d/S21mzio 2>&1;'
    'echo "===MZSTATE==="; head -c 8192 /opt/mzstate.json 2>&1; echo;'
    'echo "===IFCFGSIP==="; grep -E "^MULTICAST_(ADDRESS|PORT|ENABLED)=" /etc/ifcfg-sip 2>&1;'
    'echo "===CERT==="; ls -l /etc/sipweb/mz.crt /etc/sipweb/mz.key 2>&1;'
    ' md5sum /etc/sipweb/mz.crt 2>/dev/null;'
    'echo "===MZIO==="; ls /opt/mzio /etc/init.d/S21mzio 2>/dev/null;'
    ' ps | grep mzio | grep -v grep;'
```

3b. 新函式 `parse_probe_v2(out)`（呼叫既有 `_sections`；`parse_probe_output` 不動，v2 欄位獨立函式、`probe_device` 兩個都呼叫並 `row.update()`）：

```python
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

def parse_probe_v2(out):
    s = _sections(out)
    f = {}
    sec = s.get("MD5SIDECAR", "")
    f["sidecar_md5s"] = {name: _md5_tristate(sec, p)
                         for name, p in _SIDECAR_PATHS.items()}
    mz = s.get("MZSTATE", "")
    body = mz.strip()
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
    f["cert_crt_exists"] = ("/etc/sipweb/mz.crt" in cert and "No such file" not in
                            "".join(l for l in cert.splitlines() if "mz.crt" in l and "md5" not in l)) or None
    # ↑ 簡化：實作時逐行判——ls 行含 mz.crt 且非 "No such file" → True；含 "No such file" → False；無行 → None
    f["cert_crt_exists"] = _ls_exists(cert, "/etc/sipweb/mz.crt")
    f["cert_key_exists"] = _ls_exists(cert, "/etc/sipweb/mz.key")
    f["cert_key_perm_ok"] = _key_perm_ok(cert)
    m = _MD5_RE.search(cert)
    f["cert_crt_md5"] = m.group(1) if m else None
    io = s.get("MZIO", "")
    f["mzio_bin"] = "/opt/mzio" in io if io.strip() or "MZIO" in s else None
    f["mzio_init"] = "/etc/init.d/S21mzio" in io if "MZIO" in s else None
    f["mzio_running"] = bool(re.search(r"\bmzio\b(?!\.)", "\n".join(
        l for l in io.splitlines() if "/" not in l))) if "MZIO" in s else None
    return f

def _ls_exists(section, path):
    for line in section.splitlines():
        if path in line and "md5" not in line and not re.match(r"^[0-9a-f]{32}\s", line):
            return "No such file" not in line
    return None

def _key_perm_ok(section):
    for line in section.splitlines():
        if "/etc/sipweb/mz.key" in line and line.startswith("-"):
            return line[:10] == "-rw-------"
    return None
```

（`mzio_running` 判定：MZIO 段的 `ps` 輸出行含獨立 token `mzio`；ls 行以 `/` 開頭故排除。實作時以測試微調 regex。）

3c. `ssh_probe` 泛化：

```python
def ssh_run(ip, pw, cmd, timeout=15.0, done=b"===END==="):
    """泛化版單次 SSH（原 ssh_probe 本體，cmd 參數化；mzstate mark 重用）。"""
    # …原 ssh_probe 全文搬入，PROBE_CMD 改 cmd，"===END===" 改 done 參數…

def ssh_probe(ip, pw, timeout=15.0):
    return ssh_run(ip, pw, PROBE_CMD, timeout)
```

3d. `probe_device` 內 `row.update(facts)` 之後加：`row.update(parse_probe_v2(out) if out else _V2_NONE_FACTS)`，其中 `_V2_NONE_FACTS` 是全 None/error 的骨架 dict（照 Interfaces 欄位表；`sidecar_md5s` 五鍵全 `{"state":"error","md5":None}`、`mzstate_marker={"state":"error","raw":None}`）。保底 except 分支的 row 也補同骨架。

3e. `SCHEMA_VERSION = "2"`、`PRODUCER = "mzscan/2.0"`；`main()` 加 `ap.add_argument("--manifest")`，有給則 `MZWEB_KNOWN_MD5S.add(json.load(open(args.manifest))["components"]["mzweb"]["md5"])`。

3f. mzscan `action` 欄降級聲明：在 `classify()` docstring 加一行「schema 2 起 action 僅供人讀統計；B 路由以 mzstate verdict 為準（spec D+E §七）」。

- [ ] **Step 4: 跑測試（新＋回歸）**

Run: `cd docs/multi-zone-poc/src && python3 -m unittest test_mzscan test_mzstate -v`
Expected: 全 PASS（88 舊測試若有寫死 schema "1"/producer 的斷言，同步改為 "2"/"mzscan/2.0"——這是預期中的契約 bump，非破壞）

- [ ] **Step 5: Commit**

```bash
git add mzscan.py test_mzscan.py test_mzstate.py
git commit -m "feat(mzscan): schema 2——sidecar 五件 md5 三態/marker/ifcfg-sip 單槽/cert/mzio 事實欄＋ssh_run 泛化＋--manifest"
```

---

### Task 3: 元件級三方比對＋fw 判定（md5 優先層級）

**Files:**
- Modify: `docs/multi-zone-poc/src/mzstate.py`
- Test: `docs/multi-zone-poc/src/test_mzstate.py`

**Interfaces:**
- Produces:
  - `component_state(desired_md5: str, marker_md5: str|None, actual: {"state","md5"}) -> str`
    回 `"ok"|"missing"|"outdated"|"drift"|"unknown"`（spec §5.1 六列矩陣；呼叫方另行處理 marker-stale 註記）
  - `decide_fw(termapp_md5: str|None, dbp_ver: str|None, manifest) -> (status, warnings)`
    status ∈ `"ok"|"needs_upgrade"|"unknown_fw"|"probe_error"`；warnings 為 list[str]
- Consumes: Task 1 `load_manifest` 結構。

- [ ] **Step 1: 失敗測試**

```python
class TestComponentState(unittest.TestCase):
    D = "d"*32; M = "m"*32; X = "x"*32
    def cs(self, marker, state, md5):
        return mzstate.component_state(self.D, marker, {"state": state, "md5": md5})

    def test_row1_ok_any_marker(self):
        self.assertEqual(self.cs(self.D, "present", self.D), "ok")
        self.assertEqual(self.cs(None,   "present", self.D), "ok")      # marker 缺仍 ok
        self.assertEqual(self.cs(self.M, "present", self.D), "ok")      # marker stale 仍 ok
    def test_row2_missing_file_absent(self):
        self.assertEqual(self.cs(self.D, "absent", None), "missing")
        self.assertEqual(self.cs(None,   "absent", None), "missing")
    def test_row3_outdated(self):
        self.assertEqual(self.cs(self.M, "present", self.M), "outdated")
    def test_row4_drift_needs_marker_baseline(self):
        self.assertEqual(self.cs(self.M, "present", self.X), "drift")
    def test_row5_no_marker_no_drift(self):
        self.assertEqual(self.cs(None, "present", self.X), "missing")   # 工廠機：非 drift
    def test_row6_unknown_on_probe_error(self):
        self.assertEqual(self.cs(self.D, "error", None), "unknown")

class TestDecideFw(unittest.TestCase):
    def setUp(self):
        self.m = json.loads(json.dumps(VALID_MANIFEST))
        self.m["termapp"]["known_versions"]["0"*32] = "2.1.0"   # 已回填的舊版
    V211 = "b0eed3b30bd4fa4f1599a9475296fb6d"

    def test_known_desired_ok(self):
        self.assertEqual(mzstate.decide_fw(self.V211, "2.1.1", self.m)[0], "ok")
    def test_known_old_dbp_missing_upgrades(self):        # Codex 二輪 Critical
        st, w = mzstate.decide_fw("0"*32, None, self.m)
        self.assertEqual(st, "needs_upgrade"); self.assertEqual(w, [])
    def test_known_old_dbp_conflict_upgrades_with_warning(self):
        st, w = mzstate.decide_fw("0"*32, "9.9.9", self.m)
        self.assertEqual(st, "needs_upgrade"); self.assertTrue(w)
    def test_unknown_md5_dbp_210_upgrades(self):
        self.assertEqual(mzstate.decide_fw("f"*32, "2.1.0", self.m)[0], "needs_upgrade")
    def test_unknown_md5_no_cross_is_unknown_fw(self):
        self.assertEqual(mzstate.decide_fw("f"*32, None, self.m)[0], "unknown_fw")
        self.assertEqual(mzstate.decide_fw("f"*32, "2.1.1", self.m)[0], "unknown_fw")
    def test_none_md5_is_probe_error(self):
        self.assertEqual(mzstate.decide_fw(None, "2.1.0", self.m)[0], "probe_error")
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `python3 -m unittest test_mzstate.TestComponentState test_mzstate.TestDecideFw -v`
Expected: FAIL（函式不存在）

- [ ] **Step 3: 實作**

```python
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
```

- [ ] **Step 4: 跑測試確認通過**

Run: `python3 -m unittest test_mzstate -v` → 全 PASS

- [ ] **Step 5: Commit**

```bash
git add mzstate.py test_mzstate.py
git commit -m "feat(mzstate): 元件三方比對六列矩陣（no-marker-no-drift）＋fw md5 優先層級判定"
```

---

### Task 4: 整機裁決 decide_device＋required_actions 推導

**Files:**
- Modify: `docs/multi-zone-poc/src/mzstate.py`
- Test: `docs/multi-zone-poc/src/test_mzstate.py`

**Interfaces:**
- Produces: `decide_device(row, manifest, cert) -> dict`
  - `row`＝mzscan schema-2 device row（Task 2 欄位）；`cert`＝`{"tls_ok": bool|None, "san_ok": bool|None, "expiry_ok": bool|None}`（Task 5 產）
  - 回 `{"ip", "verdict", "exit_code", "required_actions", "components", "checks", "warnings", "reasons"}`（spec §5.3 形狀；marker 從 `row["mzstate_marker"]["raw"]` 內部解析）
  - `parse_marker(raw: str|None) -> dict|None`（嚴格解析；壞 JSON/超限 → None＋由呼叫方記 warning）
- Consumes: Task 3 `component_state`/`decide_fw`；Task 1 manifest。

- [ ] **Step 1: 失敗測試（核心組合；helper 造 row）**

```python
def mk_row(**over):
    """全綠 READY 基準 row（對 VALID_MANIFEST），測試逐項扭曲。"""
    md5s = {n: {"state": "present", "md5": VALID_MANIFEST["components"][n]["md5"]}
            for n in mzstate.COMPONENTS}
    marker = {"schema_version": "1", "release": "r", "written_at": "t",
              "components": {n: {"md5": md5s[n]["md5"], "deployed_at": "t"}
                             for n in mzstate.COMPONENTS},
              "cert": {"crt_md5": "9"*32}}
    row = {"ip": "192.168.0.70", "ssh_ok": True, "fw_ver_dbp": "2.1.1",
           "termapp_md5": "b0eed3b30bd4fa4f1599a9475296fb6d",
           "sidecar_md5s": md5s,
           "mzstate_marker": {"state": "present", "raw": json.dumps(marker)},
           "singleslot_mc_addr": "239.192.1.1", "singleslot_mc_port": 2000,
           "singleslot_enabled": True,
           "cert_crt_exists": True, "cert_key_exists": True,
           "cert_key_perm_ok": True, "cert_crt_md5": "9"*32,
           "sidecar_relay_running": True, "sidecar_rest_ok": True,
           "mzio_bin": True, "mzio_running": True, "mzio_init": True,
           "errors": []}
    row.update(over)
    return row

CERT_OK = {"tls_ok": True, "san_ok": True, "expiry_ok": True}

class TestDecideDevice(unittest.TestCase):
    def d(self, row, cert=CERT_OK):
        return mzstate.decide_device(row, VALID_MANIFEST, cert)

    def test_ready(self):
        r = self.d(mk_row())
        self.assertEqual((r["verdict"], r["exit_code"], r["required_actions"]),
                         ("READY", 0, []))

    def test_unreachable(self):
        r = self.d(mk_row(ssh_ok=False))
        self.assertEqual(r["exit_code"], 20)
        self.assertEqual(r["required_actions"], ["retry_probe"])
        self.assertEqual(r["components"], {}); self.assertEqual(r["checks"], {})

    def test_probe_incomplete_on_unknown_md5(self):
        row = mk_row(); row["sidecar_md5s"]["mzio"] = {"state": "error", "md5": None}
        self.assertEqual(self.d(row)["exit_code"], 21)

    def test_unknown_fw_terminal_manual(self):
        r = self.d(mk_row(termapp_md5="f"*32, fw_ver_dbp=None))
        self.assertEqual(r["exit_code"], 14)
        self.assertEqual(r["required_actions"], ["manual_review"])

    def test_fw_upgrade_masks_but_reports_components(self):
        row = mk_row(termapp_md5="f"*32, fw_ver_dbp="2.1.0")
        r = self.d(row)
        self.assertEqual(r["exit_code"], 11)
        self.assertEqual(r["required_actions"][0], "fw_upgrade")

    def test_drift_beats_deploy(self):
        row = mk_row()
        row["sidecar_md5s"]["mzweb"] = {"state": "present", "md5": "5"*32}   # ≠desired ≠marker
        row["sidecar_md5s"]["mzio"] = {"state": "absent", "md5": None}        # missing 並存
        r = self.d(row)
        self.assertEqual(r["exit_code"], 12)
        self.assertEqual(r["required_actions"], ["manual_review"])

    def test_fresh_factory_is_deploy_not_drift(self):
        row = mk_row(mzstate_marker={"state": "absent", "raw": None})
        row["sidecar_md5s"]["mzweb"] = {"state": "present", "md5": "5"*32}   # 原廠 web
        r = self.d(row)
        self.assertEqual(r["exit_code"], 10)
        self.assertIn("install_mzweb", r["required_actions"])

    def test_deploy_ordered_actions(self):
        row = mk_row(mzstate_marker={"state": "absent", "raw": None})
        for n in row["sidecar_md5s"]:
            row["sidecar_md5s"][n] = {"state": "absent", "md5": None}
        r = self.d(row)
        self.assertEqual(r["exit_code"], 10)
        self.assertEqual(r["required_actions"],
                         ["deploy_mzrelay3", "install_mzweb", "install_mzio"])

    def test_config_singleslot(self):
        r = self.d(mk_row(singleslot_mc_addr="239.9.9.9"))
        self.assertEqual(r["exit_code"], 13)
        self.assertEqual(r["required_actions"], ["fix_singleslot"])

    def test_config_cert_san(self):
        r = self.d(mk_row(), cert={"tls_ok": True, "san_ok": False, "expiry_ok": True})
        self.assertEqual(r["exit_code"], 13)
        self.assertEqual(r["required_actions"], ["regen_cert"])

    def test_service_down_is_restart_not_21(self):
        # TLS 連不上（服務掛）→ mzweb_https_ok=False → 13/restart，san/expiry 不列必需
        r = self.d(mk_row(), cert={"tls_ok": False, "san_ok": None, "expiry_ok": None})
        self.assertEqual(r["exit_code"], 13)
        self.assertIn("restart_services", r["required_actions"])

    def test_needs_mark_on_absent_marker_all_ok(self):
        r = self.d(mk_row(mzstate_marker={"state": "absent", "raw": None}))
        self.assertEqual(r["exit_code"], 15)
        self.assertEqual(r["required_actions"], ["mark"])

    def test_needs_mark_on_unparseable_marker(self):
        r = self.d(mk_row(mzstate_marker={"state": "present", "raw": "{broken"}))
        self.assertEqual(r["exit_code"], 15)
        self.assertTrue(r["warnings"])   # unparseable 記 warning

    def test_cert_md5_drift_only_warns(self):
        r = self.d(mk_row(cert_crt_md5="8"*32))   # ≠ marker 記錄的 9*32
        self.assertEqual(r["exit_code"], 0)
        self.assertTrue(any("crt_md5" in w for w in r["warnings"]))
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `python3 -m unittest test_mzstate.TestDecideDevice -v` → FAIL

- [ ] **Step 3: 實作**

```python
VERDICT_BY_EXIT = {0: "READY", 10: "NEEDS_DEPLOY", 11: "NEEDS_FW_UPGRADE",
                   12: "DRIFT", 13: "NOT_READY_CONFIG", 14: "UNKNOWN_FW",
                   15: "NEEDS_MARK", 20: "UNREACHABLE", 21: "PROBE_INCOMPLETE"}

_DEPLOY_ACTION = {"mzrelay3": "deploy_mzrelay3", "S21mzrelay": "deploy_mzrelay3",
                  "mzweb": "install_mzweb", "mzio": "install_mzio",
                  "S21mzio": "install_mzio"}

def parse_marker(raw):
    if raw is None or len(raw) > 8192:
        return None
    try:
        m = json.loads(raw)
    except ValueError:
        return None
    return m if isinstance(m, dict) and m.get("schema_version") == "1" else None

def decide_device(row, manifest, cert):
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
```

- [ ] **Step 4: 跑測試確認通過**

Run: `python3 -m unittest test_mzstate -v` → 全 PASS

- [ ] **Step 5: Commit**

```bash
git add mzstate.py test_mzstate.py
git commit -m "feat(mzstate): 整機裁決優先序＋required_actions 決定性推導（spec §5.2/5.3）"
```

---

### Task 5: cert 檢查（TLS DER→openssl）＋preflight

**Files:**
- Modify: `docs/multi-zone-poc/src/mzstate.py`
- Test: `docs/multi-zone-poc/src/test_mzstate.py`

**Interfaces:**
- Produces: `have_openssl() -> bool`；`check_cert(ip, port=443, timeout=8) -> {"tls_ok": bool|None, "san_ok": bool|None, "expiry_ok": bool|None}`
  - openssl 缺 → 三欄全 None（→ decide 判 21）；TLS 連線失敗 → `{"tls_ok": False, "san_ok": None, "expiry_ok": None}`（→ 13 restart）
  - `parse_openssl_text(text, ip) -> (san_ok, )`：SAN 比對＝`IP Address:<ip>` **token 精確相等**
- Consumes: Task 4 的 `decide_device(cert=...)` 形狀。

- [ ] **Step 1: 失敗測試（解析層純函式＋整合層用本機自簽測試憑證）**

```python
import subprocess, ssl, socket

OPENSSL_TEXT_SAMPLE = """\
        X509v3 extensions:
            X509v3 Subject Alternative Name:
                IP Address:192.168.1.1
"""

class TestCertParse(unittest.TestCase):
    def test_san_exact_match(self):
        self.assertTrue(mzstate.san_matches(OPENSSL_TEXT_SAMPLE, "192.168.1.1"))
    def test_san_no_substring_false_positive(self):      # Codex 二輪 Minor
        self.assertFalse(mzstate.san_matches(OPENSSL_TEXT_SAMPLE, "192.168.1.10"))
        self.assertFalse(mzstate.san_matches(
            OPENSSL_TEXT_SAMPLE.replace("192.168.1.1", "192.168.1.10"), "192.168.1.1"))

@unittest.skipUnless(mzstate.have_openssl(), "openssl not on jumpbox")
class TestCertRoundtrip(unittest.TestCase):
    def test_selfsigned_der_parses(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            crt, key = os.path.join(d, "c.pem"), os.path.join(d, "k.pem")
            subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048",
                            "-keyout", key, "-out", crt, "-days", "5", "-nodes",
                            "-subj", "/CN=test",
                            "-addext", "subjectAltName=IP:192.168.0.70"],
                           check=True, capture_output=True)
            der = subprocess.run(["openssl", "x509", "-in", crt, "-outform", "DER"],
                                 check=True, capture_output=True).stdout
            san_ok, expiry_ok = mzstate.inspect_der(der, "192.168.0.70")
            self.assertTrue(san_ok); self.assertTrue(expiry_ok)
            self.assertFalse(mzstate.inspect_der(der, "192.168.0.7")[0])
```

- [ ] **Step 2: 跑測試確認失敗** → FAIL（函式不存在）

- [ ] **Step 3: 實作**

```python
import subprocess, socket, ssl

def have_openssl():
    try:
        return subprocess.run(["openssl", "version"], capture_output=True,
                              timeout=10).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False

def san_matches(text, ip):
    return bool(re.search(r"IP Address:%s(?=[,\s]|$)" % re.escape(ip), text))

def inspect_der(der, ip):
    p = subprocess.run(["openssl", "x509", "-inform", "DER", "-noout",
                        "-checkend", "0", "-text"],
                       input=der, capture_output=True, timeout=15)
    expiry_ok = p.returncode == 0            # -checkend 0：過期→rc 1
    return san_matches(p.stdout.decode("utf-8", "replace"), ip), expiry_ok

def check_cert(ip, port=443, timeout=8):
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
```

- [ ] **Step 4: 跑測試確認通過** → `python3 -m unittest test_mzstate -v` 全 PASS
- [ ] **Step 5: Commit**：`git commit -m "feat(mzstate): cert TLS DER→openssl SAN 精確比對/效期＋preflight" mzstate.py test_mzstate.py`（先 `git add`）

---

### Task 6: 報告組裝＋inventory 閘門＋decide CLI

**Files:**
- Modify: `docs/multi-zone-poc/src/mzstate.py`
- Test: `docs/multi-zone-poc/src/test_mzstate.py`

**Interfaces:**
- Produces:
  - `validate_inventory(inv, allow_stale, now_iso) -> None`（schema≠"2" raise `SchemaMismatch`；過期未豁免 raise `StaleInventory`——兩個新 Exception 類）
  - `build_report(decisions, manifest_release, manifest_digest, scan_id) -> dict`（§5.3 形狀）
  - `main(argv) -> int`：`decide --inventory F --json OUT [--allow-stale] [--manifest M]`、`decide --probe IP [--json OUT]`、`gen-manifest [--release R]`；預設 manifest 路徑＝`mzmanifest.json`（與 mzstate.py 同目錄）
  - 批次退出碼：全 READY→0、任一非 READY→1、SchemaMismatch→22、StaleInventory→23、usage→2；單台退出碼＝該台 `exit_code`；CLI 進入點先 `have_openssl()` preflight（缺→stderr 警告，cert 欄走 None→21 路徑）
- Consumes: Task 1-5 全部；`--probe` 走 `mzscan.probe_device`（`MZSCAN_SSH_PW` env）。

- [ ] **Step 1: 失敗測試**

```python
class TestInventoryGate(unittest.TestCase):
    def inv(self, **over):
        base = {"schema_version": "2", "scan_id": "s-1",
                "valid_until": "2099-01-01T00:00:00", "devices": []}
        base.update(over); return base

    def test_ok(self):
        mzstate.validate_inventory(self.inv(), False, "2026-07-24T12:00:00")
    def test_schema1_rejected(self):
        with self.assertRaises(mzstate.SchemaMismatch):
            mzstate.validate_inventory(self.inv(schema_version="1"), False,
                                       "2026-07-24T12:00:00")
    def test_stale_rejected_and_allowed(self):
        stale = self.inv(valid_until="2020-01-01T00:00:00")
        with self.assertRaises(mzstate.StaleInventory):
            mzstate.validate_inventory(stale, False, "2026-07-24T12:00:00")
        mzstate.validate_inventory(stale, True, "2026-07-24T12:00:00")   # 豁免不 raise

class TestReport(unittest.TestCase):
    def test_shape_and_unreachable_entry(self):
        d_ok = mzstate.decide_device(mk_row(), VALID_MANIFEST, CERT_OK)
        d_un = mzstate.decide_device(mk_row(ssh_ok=False), VALID_MANIFEST, CERT_OK)
        rep = mzstate.build_report([d_ok, d_un], "r1", "f"*32, "s-1")
        self.assertEqual(rep["schema_version"], "1")
        self.assertEqual(rep["manifest_release"], "r1")
        self.assertEqual(rep["scan_id"], "s-1")
        un = rep["devices"][1]
        self.assertEqual(un["verdict"], "UNREACHABLE")
        self.assertEqual(un["components"], {}); self.assertEqual(un["checks"], {})

class TestCliExitCodes(unittest.TestCase):
    def run_decide(self, inv_obj, extra=()):
        import tempfile
        d = tempfile.mkdtemp()
        invp = os.path.join(d, "inv.json"); json.dump(inv_obj, open(invp, "w"))
        mp = write_tmp_manifest(VALID_MANIFEST)
        return mzstate.main(["decide", "--inventory", invp, "--json",
                             os.path.join(d, "out.json"), "--manifest", mp, *extra])

    def test_schema_mismatch_22(self):
        self.assertEqual(self.run_decide({"schema_version": "1", "scan_id": "x",
                                          "valid_until": "2099-01-01T00:00:00",
                                          "devices": []}), 22)
    def test_stale_23(self):
        self.assertEqual(self.run_decide({"schema_version": "2", "scan_id": "x",
                                          "valid_until": "2020-01-01T00:00:00",
                                          "devices": []}), 23)
    def test_usage_2_on_missing_file(self):
        self.assertEqual(mzstate.main(["decide", "--inventory", "/no/such.json",
                                       "--json", "/tmp/x.json"]), 2)
```

（批次模式的 per-device `check_cert` 實網呼叫在單元測試以 `--inventory` 空 devices 列表繞開；有 devices 的整合路徑由 Task 8/9 真機驗證。）

- [ ] **Step 2: 跑測試確認失敗** → FAIL

- [ ] **Step 3: 實作**

```python
import datetime

class SchemaMismatch(Exception): pass
class StaleInventory(Exception): pass

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
            try: prev = json.load(open(out))
            except ValueError: prev = None
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

def _write_json_atomic(path, obj):
    tmp = path + ".tmp.%d" % os.getpid()
    with open(tmp, "w") as fh:
        json.dump(obj, fh, ensure_ascii=False, indent=1)
    os.replace(tmp, path)

if __name__ == "__main__":
    sys.exit(main())
```

（`cmd_mark` 在 Task 7 之前先放 `def cmd_mark(args, manifest): raise NotImplementedError`——CLI 測試不碰它。）

- [ ] **Step 4: 跑測試確認通過** → `python3 -m unittest test_mzstate -v` 全 PASS
- [ ] **Step 5: Commit**：`git add mzstate.py test_mzstate.py && git commit -m "feat(mzstate): decide CLI——inventory 22/23 閘門、批次原子 JSON 報告、單台人讀輸出"`

---

### Task 7: mark — all-or-nothing 寫標／--delete／lock

**Files:**
- Modify: `docs/multi-zone-poc/src/mzstate.py`
- Test: `docs/multi-zone-poc/src/test_mzstate.py`

**Interfaces:**
- Produces:
  - `merge_marker(existing: dict|None, actuals: {name: md5}, components: list, delete: list, release, now_iso, crt_md5) -> dict`（純函式：all-or-nothing 由呼叫方先驗；--delete 移除條目；cert 條目 only-update 不可刪——`delete` 含非五件名 raise `ValueError`）
  - `cmd_mark(args, manifest) -> int`：probe 目標五件 md5＋讀現標 → 驗 `--components`（預設全部）每件 `actual==manifest`（任一不符→stderr 列明、回 1、不寫）→ mkdir lock（owner 檔）→ 本地組新 marker JSON → sftp put `/opt/.mzstate.upload.$$` → `mv`＋`sync` → 解鎖。成功回 0
- Consumes: Task 2 `mzscan.ssh_run`；`mzctl.py put`（`subprocess` 呼叫、`MZHOST` env 指定目標）；Task 4 `parse_marker`。

- [ ] **Step 1: 失敗測試（純函式層）**

```python
class TestMergeMarker(unittest.TestCase):
    A = {n: n[0]*32 for n in mzstate.COMPONENTS}   # actual md5s

    def test_fresh_write_all(self):
        m = mzstate.merge_marker(None, self.A, list(mzstate.COMPONENTS), [],
                                 "r1", "t1", crt_md5="9"*32)
        self.assertEqual(set(m["components"]), set(mzstate.COMPONENTS))
        self.assertEqual(m["components"]["mzweb"]["md5"], "m"*32)
        self.assertEqual(m["cert"]["crt_md5"], "9"*32)
        self.assertEqual(m["schema_version"], "1")

    def test_partial_update_preserves_others(self):
        old = mzstate.merge_marker(None, self.A, list(mzstate.COMPONENTS), [],
                                   "r1", "t1", None)
        m = mzstate.merge_marker(old, {"mzweb": "z"*32}, ["mzweb"], [], "r2", "t2", None)
        self.assertEqual(m["components"]["mzweb"]["md5"], "z"*32)
        self.assertEqual(m["components"]["mzrelay3"]["md5"], "m"*32)   # 保留
        self.assertEqual(m["components"]["mzweb"]["deployed_at"], "t2")
        self.assertEqual(m["components"]["mzrelay3"]["deployed_at"], "t1")

    def test_delete_entry(self):
        old = mzstate.merge_marker(None, self.A, list(mzstate.COMPONENTS), [],
                                   "r1", "t1", None)
        m = mzstate.merge_marker(old, {}, [], ["mzweb"], "r1", "t2", None)
        self.assertNotIn("mzweb", m["components"])
        self.assertIn("mzrelay3", m["components"])

    def test_delete_cert_rejected(self):
        with self.assertRaises(ValueError):
            mzstate.merge_marker(None, {}, [], ["cert"], "r", "t", None)
```

（`cmd_mark` 的 all-or-nothing／lock 為 I/O 組合層：真機 Task 9 驗；此處另加一個「驗證不符不寫」的測試——把 probe/put 抽成可注入函式參數 `cmd_mark(args, manifest, probe_fn=..., put_fn=...)`，測試注入 fake：）

```python
class TestMarkAllOrNothing(unittest.TestCase):
    def test_one_mismatch_writes_nothing(self):
        calls = []
        def fake_probe(ip, pw):
            a = {n: {"state": "present",
                     "md5": VALID_MANIFEST["components"][n]["md5"]}
                 for n in mzstate.COMPONENTS}
            a["mzio"]["md5"] = "bad0"*8            # mzio 不符 manifest
            return a, None, None                   # (actuals, marker_raw, crt_md5)
        def fake_put(ip, marker_obj):
            calls.append(marker_obj)
        class A: probe="1.2.3.4"; components=None; delete=None
        rc = mzstate.run_mark(A(), VALID_MANIFEST, "pw", fake_probe, fake_put)
        self.assertEqual(rc, 1)
        self.assertEqual(calls, [])                # 一個條目都沒寫
```

- [ ] **Step 2: 跑測試確認失敗** → FAIL

- [ ] **Step 3: 實作**

```python
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
    'echo "===MZSTATE==="; head -c 8192 /opt/mzstate.json 2>&1; echo;'
    'echo "===CRT==="; md5sum /etc/sipweb/mz.crt 2>/dev/null;'
    'echo "===END==="')

def _mark_probe(ip, pw):
    import mzscan
    out, err = mzscan.ssh_run(ip, pw, MARK_PROBE_CMD)
    if out is None:
        return None, None, err
    s = mzscan._sections(out)
    import mzscan as _m
    actuals = {n: _m._md5_tristate(s.get("MD5SIDECAR", ""), p)
               for n, p in _m._SIDECAR_PATHS.items()}
    body = s.get("MZSTATE", "").strip()
    raw = None if ("No such file" in body or not body) else body
    mm = re.search(r"^([0-9a-f]{32})\s", s.get("CRT", ""), re.M)
    return actuals, raw, (mm.group(1) if mm else None)

def _mark_put(ip, pw, marker_obj):
    """lock → 上傳 tmp → mv+sync → unlock。失敗 raise RuntimeError。"""
    import mzscan, subprocess, tempfile
    src_dir = os.path.dirname(os.path.abspath(__file__))
    hostname = socket.gethostname()
    lock_cmd = ('mkdir /opt/.mzstate.lock 2>/dev/null'
                ' && echo "%s $$ $(date)" > /opt/.mzstate.lock/owner'
                ' && echo LOCK_OK || echo LOCK_FAIL; echo "===END==="' % hostname)
    out, err = mzscan.ssh_run(ip, pw, lock_cmd)
    if not out or "LOCK_OK" not in out:
        raise RuntimeError("marker lock busy/failed on %s (%s) — "
                           "inspect /opt/.mzstate.lock/owner; break-glass: "
                           "rm -rf /opt/.mzstate.lock" % (ip, err))
    try:
        fd, local = tempfile.mkstemp(suffix=".json"); os.close(fd)
        with open(local, "w") as fh:
            json.dump(marker_obj, fh, ensure_ascii=False, indent=1)
        remote_tmp = "/opt/.mzstate.upload"
        p = subprocess.run(["python3", os.path.join(src_dir, "mzctl.py"),
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
    comps = ([c.strip() for c in args.components.split(",")] if args.components
             else list(COMPONENTS))
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
```

（注意 `run_mark(A(), VALID_MANIFEST, "pw", fake_probe, fake_put)` 測試簽名：`probe_fn(ip, pw)` 回 `(actuals, marker_raw, crt_md5)`、失敗 `(None, None, err)`；`put_fn(ip, obj)`。`--delete`-only 呼叫（`components` 明給空）由 mzdeploy rollback 使用：`--components ""` 解析為空列表→只刪不驗。實作 `comps` 解析時處理空字串→`[]`。）

- [ ] **Step 4: 跑測試確認通過** → 全 PASS
- [ ] **Step 5: Commit**：`git add mzstate.py test_mzstate.py && git commit -m "feat(mzstate): mark——all-or-nothing 防洗白、--delete、mkdir lock(owner)、上傳 md5 複驗+原子 mv"`

---

### Task 8: mzdeploy.sh — status 修復＋寫標＋rollback 先刪標

**Files:**
- Modify: `docs/multi-zone-poc/src/mzdeploy.sh`

**Interfaces:**
- Consumes: `python3 mzstate.py mark --probe $HOST --components ...`／`--components "" --delete ...`（Task 7）；`MZSCAN_SSH_PW` env。
- Produces: B 依賴的 mzdeploy 行為——install 成功＝已寫標；rollback 成功＝標已清。

- [ ] **Step 1: 檔頭加密碼 env（`CTL=` 行之後）**

```sh
export MZSCAN_SSH_PW="${MZSCAN_SSH_PW:-BcastTerm2}"
```

- [ ] **Step 2: 修 status 的 REST 健檢（spec §八既有 bug；替換 mzdeploy.sh:63-66 的 curl 塊）**

```sh
	echo "-- REST /get/sip/multicast/zones（設備端 loopback，:8090 為 loopback-only bind）:"
	REST_OUT=$($CTL sh 'printf "GET /get/sip/multicast/zones HTTP/1.1\r\nHost:127.0.0.1\r\nConnection: close\r\n\r\n" | nc 127.0.0.1 8090 2>/dev/null | head -c 8192; echo')
	if echo "$REST_OUT" | grep -q '"zones"'; then
		echo "  REST OK（zones JSON 回應）"
	else
		echo "  REST 無回應/非 zones JSON — daemon 未啟或 loopback 埠不通"; exit 1
	fi
```

- [ ] **Step 3: 三個 install 成功路徑尾端寫標**

`deploy)` 分支：在 `"$0" status` 之後加：

```sh
	echo "== 寫標（mzstate mark，驗 md5==manifest 後 all-or-nothing）=="
	python3 mzstate.py mark --probe "$HOST" --components mzrelay3,S21mzrelay || exit 1
```

`mzweb-install)` 分支結尾（`nc 127.0.0.1 80` 驗證行之後）加：

```sh
	python3 mzstate.py mark --probe "$HOST" --components mzweb || exit 1
```

`mzio-install)` 分支結尾加：

```sh
	python3 mzstate.py mark --probe "$HOST" --components mzio,S21mzio || exit 1
```

- [ ] **Step 4: rollback 先刪標（spec §八順序）**

`rollback)` 分支：在 `cp /opt/mzrelay3.prev ...` **之前**加：

```sh
	echo "== 先刪標（失敗即中止，不動 binary）=="
	python3 mzstate.py mark --probe "$HOST" --components "" --delete mzrelay3 || {
		echo "✗ 刪標失敗，中止 rollback"; exit 1; }
```

`mzweb-rollback)` 分支：在還原 `.orig`＋reboot 的 `$CTL sh` **之前**加：

```sh
	echo "== 先刪標（失敗即中止，不 reboot）=="
	python3 mzstate.py mark --probe "$HOST" --components "" --delete mzweb || {
		echo "✗ 刪標失敗，中止 mzweb-rollback"; exit 1; }
```

- [ ] **Step 5: 語法檢查＋commit**

Run: `sh -n docs/multi-zone-poc/src/mzdeploy.sh` → 無輸出（語法 OK）

```bash
git add docs/multi-zone-poc/src/mzdeploy.sh
git commit -m "fix(mzdeploy): status REST 改設備端 loopback nc（修 P7 後必失敗 bug）＋install 寫標＋rollback 先刪標"
```

---

### Task 9: 真機驗收（.70 本地＋tailscale 站內抽測）

**Files:** 無新檔（驗收記錄寫入 `.superpowers/sdd/`或 task 報告）

**Interfaces:** Consumes 全部前置 task。

- [ ] **Step 1: .70 全流程**（`cd docs/multi-zone-poc/src`；`export MZSCAN_SSH_PW=BcastTerm2`）

```bash
# 1. 補標→應 READY(0)
python3 mzstate.py mark --probe 192.168.0.70
python3 mzstate.py decide --probe 192.168.0.70; echo "exit=$?"      # 期望 READY(0)
# 2. 刪標→應 NEEDS_MARK(15)
python3 mzctl.py sh 'rm /opt/mzstate.json'
python3 mzstate.py decide --probe 192.168.0.70; echo "exit=$?"      # 期望 15
python3 mzstate.py mark --probe 192.168.0.70                        # 復原
# 3. 篡改（有標）→應 DRIFT(12)
python3 mzctl.py sh 'cp /opt/mzio /tmp/mzio.bak; echo X >> /opt/mzio'
python3 mzstate.py decide --probe 192.168.0.70; echo "exit=$?"      # 期望 12
python3 mzctl.py sh 'cp /tmp/mzio.bak /opt/mzio'                    # 復原
# 4. 移走檔案→應 NEEDS_DEPLOY(10)
python3 mzctl.py sh 'mv /opt/mzio /tmp/mzio.hold'
python3 mzstate.py decide --probe 192.168.0.70; echo "exit=$?"      # 期望 10, actions 含 install_mzio
python3 mzctl.py sh 'mv /tmp/mzio.hold /opt/mzio'
# 5. 單槽扭曲→應 NOT_READY_CONFIG(13)（改回前先備份 ifcfg-sip！）
python3 mzctl.py sh 'cp /etc/ifcfg-sip /tmp/ifcfg.bak; sed -i "s/^MULTICAST_ADDRESS=.*/MULTICAST_ADDRESS=239.9.9.9/" /etc/ifcfg-sip'
python3 mzstate.py decide --probe 192.168.0.70; echo "exit=$?"      # 期望 13, fix_singleslot
python3 mzctl.py sh 'cp /tmp/ifcfg.bak /etc/ifcfg-sip'
python3 mzstate.py decide --probe 192.168.0.70; echo "exit=$?"      # 復原後 READY(0)
# 6. mzdeploy 六命令重驗（status 修復後應全通）
./mzdeploy.sh status && ./mzdeploy.sh mzio-status
```

每步核對退出碼與 `required_actions`；不符即回頭修（systematic-debugging），全過才進 Step 2。

- [ ] **Step 2: mzscan schema 2 整批＋decide --inventory（.70 單機清單）**

```bash
echo "192.168.0.70" > /tmp/fleet-70.txt
MZSCAN_SSH_PW=BcastTerm2 python3 mzscan.py --expect /tmp/fleet-70.txt --out /tmp
python3 mzstate.py decide --inventory /tmp/inventory-*.json --json /tmp/report.json; echo "exit=$?"
python3 -c "import json; r=json.load(open('/tmp/report.json')); print(r['devices'][0]['verdict'], r['scan_id'], r['manifest_release'])"
```

期望：inventory `schema_version=="2"`；decide 全 READY→exit 0；report 帶 scan_id/manifest 溯源。

- [ ] **Step 3: tailscale 站內抽測（跳板機 xxes-tc=100.93.221.22，站內網段 192.168.8.x——以 C 盤點結果為準挑 2-3 台）**

把 `docs/multi-zone-poc/src/`（mzscan.py mzstate.py mzctl.py mzmanifest.json test 檔不必）rsync 到跳板機後執行：
- 對一台 **v2.1.0 未升級機**：`decide --probe` 期望 `NEEDS_FW_UPGRADE(11)`；**記下其 termapp md5，回填 `mzmanifest.json` 的 `known_versions`（Q3）並 commit**。
- 對一台 **v2.1.1 未部署 side-car 機**（原廠 sipweb、無標）：期望 `NEEDS_DEPLOY(10)` **而非 12**（no-marker-no-drift 真機證）。
- 混批：站內 fleet 檔跑 `mzscan --expect` → `decide --inventory --json`，核對報告完整（含 UNREACHABLE 台的空 components 形狀）。

- [ ] **Step 4: 驗收記錄＋commit**

```bash
git add docs/multi-zone-poc/src/mzmanifest.json   # Q3 回填
git commit -m "feat(mzstate): 真機驗收——.70 六情境退出碼全符＋站內抽測（v2.1.0→11、工廠機→10）＋Q3 回填 v2.1.0 md5"
```

---

### Task 10: 對抗審查＋detect_changes＋收尾

- [ ] **Step 1**: 全量測試回歸：`python3 -m unittest test_mzscan test_mzstate -v` 全綠。
- [ ] **Step 2**: 派 `adversarial-reviewer` 對抗審查本分支 diff（重點：假綠測試、六列矩陣邊界、mark race、mzdeploy sh 引號/set -e 陷阱、退出碼契約 drift）。修完複驗。
- [ ] **Step 3**: `bash scripts/gitnexus-fresh.sh` 後跑 GitNexus `detect_changes({scope:"compare", base_ref:"main"})`，確認影響面只在 mzscan/mzstate/mzdeploy。
- [ ] **Step 4**: 依 superpowers:finishing-a-development-branch 收尾（分支→PR）。

## Self-Review 記錄

- Spec 覆蓋：§三 manifest（T1）、§四 marker/mark（T7）、§5.1 矩陣（T3）、§5.2 裁決＋required_actions＋22/23（T4/T6）、§5.3 CLI/報告（T6）、§六 READY＋cert（T4/T5）、§七 mzscan v2（T2）、§八 mzdeploy（T8）、§十 測試（T1-T9）、§十一 B 契約（T6 退出碼＋報告）。
- 型別一致：`component_state` 回傳字串集合、`decide_device(row, manifest, cert)`、`run_mark(args, manifest, pw, probe_fn, put_fn)` 各 task 引用一致。
- 佔位掃描：無 TBD；Task 2 parse 程式碼中的行內註記（「實作時以測試微調 regex」）屬 TDD 預期迭代，測試已完整給定行為。

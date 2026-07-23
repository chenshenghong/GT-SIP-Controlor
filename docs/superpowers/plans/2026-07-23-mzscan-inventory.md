# mzscan 盤點 Scanner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建置 `mzscan.py` — 52 台 gt-sip-gw 的 pre-flight 盤點 scanner，產出餵 F/B 的 inventory JSON。

**Architecture:** 單檔 python3 stdlib-only 腳本＋同目錄 unittest 測試檔。兩階段管線（DBP 廣播發現 → pty-SSH 深探），純函式判定層（韌體決策表 / web_type 決策樹 / 分類矩陣）與 I/O 層分離。Spec：`docs/superpowers/specs/2026-07-23-mzscan-inventory-design.md`（本計畫的唯一需求來源，衝突時以 spec 為準）。

**Tech Stack:** python3 stdlib（socket/pty/select/ssl/urllib/concurrent.futures/unittest）。無 pip 依賴（跳板機 xxes-tc 無外網）。

## Global Constraints

- 全程 stdlib-only；python3.8+ 相容（跳板機 Ubuntu）。
- SSH 密碼：env `MZSCAN_SSH_PW`（預設無→啟動時報錯退出），絕不進 argv/inventory/日誌。帳號 `root`、port `9521`、舊算法放寬選項照抄 mzctl.py。
- REST token：env `MZSCAN_REST_TOKEN`，預設 `mzpoc-token`。
- v2.1.1 termapp md5 常數：`b0eed3b30bd4fa4f1599a9475296fb6d`。
- mzweb 已知版本 md5 常數表：實作時以 `md5sum docs/multi-zone-poc/src/mzweb/build/mzweb-arm` 現值初始化；支援 `--mzweb-bin` 覆蓋。
- 空間門檻：`OPT_MIN_FREE_KB = 2*(81+402)+512 = 1478`（常數＋註解註明推導式）。
- 三態原則：每個事實欄位＝值或 `None`(unknown)；unknown 原因進 `errors[]`。**任何 unknown 關鍵欄 → 分類永不 `done`**。
- 無 `--expect` 名單 → 輸出不含 `action` 欄（discovery report 模式）。
- 逐台 15s 硬 timeout、預設 8 workers、失敗 kill 殘留子程序。
- 測試：stdlib `unittest`，`python3 -m unittest test_mzscan -v` 在 mac 零網路可跑。

## File Structure

- `docs/multi-zone-poc/src/mzscan.py` — 全部實作（區段順序：常數 → DBP 純函式 → SSH/pty I/O → 探測輸出解析純函式 → 判定純函式 → 對帳純函式 → inventory 組裝/輸出 → CLI main）。
- `docs/multi-zone-poc/src/test_mzscan.py` — 全部單元測試（只測純函式；I/O 函式以 canned 字串餵解析器）。

---

### Task 1: DBP 封包組裝/解析＋衝突偵測（純函式）

**Files:**
- Create: `docs/multi-zone-poc/src/mzscan.py`
- Create: `docs/multi-zone-poc/src/test_mzscan.py`

**Interfaces:**
- Produces: `build_dbp_request() -> bytes`；`parse_dbp_reply(raw: bytes) -> dict|None`（keys: `ip,mac,fw_ver_dbp,type,name`，無 mac 回 None）；`merge_discovery(replies: list[dict]) -> dict[str,dict]`（key=ip，同 ip 欄位不一致時該 record 加 `dbp_conflict: True` 並保留 `dbp_variants` 列表）。

- [ ] **Step 1: Write the failing tests**

```python
# test_mzscan.py
import unittest
import mzscan

RAW_OK = ("DBP/1.0 200 OK\r\nID: 1\r\nType: GT-SIP-GW\r\nVer: 2.1.1\r\n"
          "MAC: 00-11-22-33-44-55\r\nIP: 192.168.1.140\r\nName: room1\r\n").encode("gbk")

class TestDbp(unittest.TestCase):
    def test_request_format(self):
        req = mzscan.build_dbp_request()
        self.assertTrue(req.startswith(b"GET DBP/1.0\r\nCSeq: 1\r\nIFCFG-APP:"))
        self.assertTrue(req.endswith(b"IsBroadcast: 1\r\n\r\n"))

    def test_parse_ok(self):
        d = mzscan.parse_dbp_reply(RAW_OK)
        self.assertEqual(d["ip"], "192.168.1.140")
        self.assertEqual(d["mac"], "00-11-22-33-44-55")
        self.assertEqual(d["fw_ver_dbp"], "2.1.1")

    def test_parse_no_mac_returns_none(self):
        self.assertIsNone(mzscan.parse_dbp_reply(b"DBP/1.0 200 OK\r\nIP: 1.2.3.4\r\n"))

    def test_parse_non_dbp_returns_none(self):
        self.assertIsNone(mzscan.parse_dbp_reply(b"HTTP/1.1 200 OK\r\n"))

    def test_merge_no_conflict(self):
        a = {"ip": "1.1.1.1", "mac": "AA", "fw_ver_dbp": "2.1.1"}
        m = mzscan.merge_discovery([a, dict(a)])
        self.assertNotIn("dbp_conflict", m["1.1.1.1"])

    def test_merge_conflict_flagged(self):
        a = {"ip": "1.1.1.1", "mac": "AA", "fw_ver_dbp": "2.1.1"}
        b = {"ip": "1.1.1.1", "mac": "BB", "fw_ver_dbp": "2.1.0"}
        m = mzscan.merge_discovery([a, b])
        self.assertTrue(m["1.1.1.1"]["dbp_conflict"])
        self.assertEqual(len(m["1.1.1.1"]["dbp_variants"]), 2)

if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd docs/multi-zone-poc/src && python3 -m unittest test_mzscan -v`
Expected: ERROR（`mzscan` 無屬性 / module not found）

- [ ] **Step 3: Implement in mzscan.py**

```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd docs/multi-zone-poc/src && python3 -m unittest test_mzscan -v`
Expected: 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add docs/multi-zone-poc/src/mzscan.py docs/multi-zone-poc/src/test_mzscan.py
git commit -m "feat(mzscan): DBP 封包組裝/解析＋同IP衝突偵測（Task 1）"
```

---

### Task 2: 韌體決策表＋web_type 決策樹（純函式）

**Files:**
- Modify: `docs/multi-zone-poc/src/mzscan.py`（判定純函式區段）
- Modify: `docs/multi-zone-poc/src/test_mzscan.py`

**Interfaces:**
- Consumes: 常數 `TERMAPP_MD5_V211 = "b0eed3b30bd4fa4f1599a9475296fb6d"`。
- Produces: `decide_fw_ver(termapp_md5: str|None, dbp_ver: str|None) -> str`（回 `"2.1.1"|"2.1.0"|"unknown"`）；`decide_web_type(sipweb_md5, mzweb_known_md5s: set, https_probe, http80_probe, loopback80_403: bool|None) -> str`（回 `"mzweb"|"https"|"lgw"|"hbi"|"unknown"`）。`https_probe`/`http80_probe` 為 dict：`{"ok": bool, "status": int|None, "json": bool}`，probe 失敗時傳 `None`。

- [ ] **Step 1: Write the failing tests（spec §四兩表全分支）**

```python
# test_mzscan.py 追加
V211 = mzscan.TERMAPP_MD5_V211

class TestFwDecision(unittest.TestCase):
    def test_md5_match_wins(self):          # md5==已知 → 2.1.1（DBP 任意）
        self.assertEqual(mzscan.decide_fw_ver(V211, "2.1.0"), "2.1.1")
        self.assertEqual(mzscan.decide_fw_ver(V211, None), "2.1.1")
    def test_md5_other_dbp_210(self):       # md5≠已知 + DBP=2.1.0 → 2.1.0
        self.assertEqual(mzscan.decide_fw_ver("deadbeef", "2.1.0"), "2.1.0")
    def test_md5_other_dbp_211_conflict(self):  # 矛盾 → unknown
        self.assertEqual(mzscan.decide_fw_ver("deadbeef", "2.1.1"), "unknown")
    def test_no_md5_any_dbp(self):          # 讀不到 md5 → DBP 單源不足採信
        self.assertEqual(mzscan.decide_fw_ver(None, "2.1.0"), "unknown")
        self.assertEqual(mzscan.decide_fw_ver(None, None), "unknown")

class TestWebType(unittest.TestCase):
    MZ = {"abc123"}
    def test_mzweb_md5_first(self):
        self.assertEqual(mzscan.decide_web_type("abc123", self.MZ, None, None, None), "mzweb")
    def test_https(self):
        r = mzscan.decide_web_type("x", self.MZ, {"ok": True, "status": 401, "json": False}, None, None)
        self.assertEqual(r, "https")
    def test_lgw(self):
        r = mzscan.decide_web_type("x", self.MZ, None, {"ok": True, "status": 200, "json": True}, None)
        self.assertEqual(r, "lgw")
    def test_hbi_needs_loopback_403_too(self):
        p80 = {"ok": True, "status": 403, "json": False}
        self.assertEqual(mzscan.decide_web_type("x", self.MZ, None, p80, True), "hbi")
        self.assertEqual(mzscan.decide_web_type("x", self.MZ, None, p80, None), "unknown")
    def test_all_dark_unknown(self):
        self.assertEqual(mzscan.decide_web_type(None, self.MZ, None, None, None), "unknown")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd docs/multi-zone-poc/src && python3 -m unittest test_mzscan -v`
Expected: 新測試 ERROR（函式未定義）

- [ ] **Step 3: Implement**

```python
# mzscan.py 追加
TERMAPP_MD5_V211 = "b0eed3b30bd4fa4f1599a9475296fb6d"  # v2.1.1 NetPlayer, 1748236 bytes

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd docs/multi-zone-poc/src && python3 -m unittest test_mzscan -v`
Expected: 全數 PASS

- [ ] **Step 5: Commit**

```bash
git add docs/multi-zone-poc/src/mzscan.py docs/multi-zone-poc/src/test_mzscan.py
git commit -m "feat(mzscan): 韌體決策表＋web_type五層決策樹（Task 2）"
```

---

### Task 3: 分類矩陣＋跨台重複指紋（純函式）

**Files:**
- Modify: `docs/multi-zone-poc/src/mzscan.py`
- Modify: `docs/multi-zone-poc/src/test_mzscan.py`

**Interfaces:**
- Consumes: Task 2 的 `decide_*` 輸出值域。
- Produces: `OPT_MIN_FREE_KB = 1478`；`classify(facts: dict) -> str`。`facts` 欄位（None=unknown）：`reachable_dbp, ssh_ok, opt_writable, opt_free_kb, fw_ver, web_type, dbp_conflict, hostkey_dup, sidecar_relay_bin, sidecar_relay_running, sidecar_init, sidecar_rest_ok`。回傳 action 字串（spec §四優先序）。另 `find_hostkey_dups(rows: list[dict]) -> set[str]`（回重複 `ssh_hostkey_fp` 集合）。

- [ ] **Step 1: Write the failing tests（矩陣全分支＋不變式）**

```python
# test_mzscan.py 追加
def facts(**kw):
    base = dict(reachable_dbp=True, ssh_ok=True, opt_writable=True, opt_free_kb=5000,
                fw_ver="2.1.1", web_type="mzweb", dbp_conflict=False, hostkey_dup=False,
                sidecar_relay_bin=True, sidecar_relay_running=True,
                sidecar_init=True, sidecar_rest_ok=True)
    base.update(kw)
    return base

class TestClassify(unittest.TestCase):
    def test_done(self):
        self.assertEqual(mzscan.classify(facts()), "done")
    def test_unreachable(self):
        f = facts(reachable_dbp=False, ssh_ok=False)
        self.assertEqual(mzscan.classify(f), "blocked:unreachable")
    def test_no_ssh(self):
        self.assertEqual(mzscan.classify(facts(ssh_ok=False)), "blocked:no-ssh")
    def test_opt_not_writable(self):
        self.assertEqual(mzscan.classify(facts(opt_writable=False)), "blocked:opt")
    def test_opt_low_space(self):
        self.assertEqual(mzscan.classify(facts(opt_free_kb=1000)), "blocked:opt")
    def test_dbp_conflict_blocks(self):
        self.assertEqual(mzscan.classify(facts(dbp_conflict=True)), "blocked:probe-incomplete")
    def test_hostkey_dup_blocks(self):
        self.assertEqual(mzscan.classify(facts(hostkey_dup=True)), "blocked:probe-incomplete")
    def test_needs_fw_upgrade(self):
        self.assertEqual(mzscan.classify(facts(fw_ver="2.1.0")), "needs-fw-upgrade")
    def test_needs_sidecar_partial(self):
        self.assertEqual(mzscan.classify(facts(sidecar_rest_ok=False)), "needs-sidecar")
    def test_needs_sidecar_wrong_web(self):
        self.assertEqual(mzscan.classify(facts(web_type="lgw")), "needs-sidecar")
    def test_unknown_never_done(self):
        # 不變式：任何關鍵欄 unknown → 必為 blocked:probe-incomplete，永不 done
        for k in ("fw_ver", "web_type", "opt_writable", "sidecar_relay_bin",
                  "sidecar_relay_running", "sidecar_init", "sidecar_rest_ok"):
            v = "unknown" if k in ("fw_ver", "web_type") else None
            self.assertEqual(mzscan.classify(facts(**{k: v})), "blocked:probe-incomplete", k)

class TestHostkeyDup(unittest.TestCase):
    def test_dup_found(self):
        rows = [{"ip": "1", "ssh_hostkey_fp": "A"}, {"ip": "2", "ssh_hostkey_fp": "A"},
                {"ip": "3", "ssh_hostkey_fp": "B"}, {"ip": "4", "ssh_hostkey_fp": None}]
        self.assertEqual(mzscan.find_hostkey_dups(rows), {"A"})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd docs/multi-zone-poc/src && python3 -m unittest test_mzscan -v`
Expected: 新測試 ERROR

- [ ] **Step 3: Implement**

```python
# mzscan.py 追加
OPT_MIN_FREE_KB = 1478  # = 2*(mzrelay3 81KB + mzweb 402KB) + 512KB margin（spec §四）

_SIDECAR_KEYS = ("sidecar_relay_bin", "sidecar_relay_running", "sidecar_init", "sidecar_rest_ok")

def classify(f):
    """spec §四 分類矩陣，優先序由上而下。不變式：unknown 永不 done。"""
    if not f.get("reachable_dbp") and not f.get("ssh_ok"):
        return "blocked:unreachable"
    if f.get("ssh_ok") is False:
        return "blocked:no-ssh"
    if f.get("opt_writable") is False or (
            f.get("opt_free_kb") is not None and f["opt_free_kb"] < OPT_MIN_FREE_KB):
        return "blocked:opt"
    unknown = (f.get("fw_ver") == "unknown" or f.get("web_type") == "unknown"
               or f.get("opt_writable") is None
               or any(f.get(k) is None for k in _SIDECAR_KEYS))
    if unknown or f.get("dbp_conflict") or f.get("hostkey_dup"):
        return "blocked:probe-incomplete"
    if f["fw_ver"] == "2.1.0":
        return "needs-fw-upgrade"
    if not all(f[k] for k in _SIDECAR_KEYS) or f["web_type"] != "mzweb":
        return "needs-sidecar"
    return "done"

def find_hostkey_dups(rows):
    seen, dups = {}, set()
    for r in rows:
        fp = r.get("ssh_hostkey_fp")
        if fp is None:
            continue
        if fp in seen:
            dups.add(fp)
        seen[fp] = r
    return dups
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd docs/multi-zone-poc/src && python3 -m unittest test_mzscan -v`
Expected: 全數 PASS

- [ ] **Step 5: Commit**

```bash
git add docs/multi-zone-poc/src/mzscan.py docs/multi-zone-poc/src/test_mzscan.py
git commit -m "feat(mzscan): 分類矩陣（unknown永不done不變式）＋跨台重複指紋偵測（Task 3）"
```

---

### Task 4: 對帳（fleet.txt 解析＋missing/unexpected/mac_mismatch）

**Files:**
- Modify: `docs/multi-zone-poc/src/mzscan.py`
- Modify: `docs/multi-zone-poc/src/test_mzscan.py`

**Interfaces:**
- Produces: `parse_fleet(text: str) -> list[dict]`（每行 `IP[,MAC]`，`#` 註解與空行跳過；IP 格式錯誤 raise `ValueError` 附行號）；`reconcile(expected: list[dict], discovered: dict[str,dict]) -> dict`（回 `{"missing": [ip...], "unexpected": [ip...], "mac_mismatch": [{"ip","expected_mac","seen_mac"}...]}`；MAC 比對忽略大小寫與 `-`/`:` 分隔差異）。

- [ ] **Step 1: Write the failing tests**

```python
# test_mzscan.py 追加
class TestFleet(unittest.TestCase):
    def test_parse(self):
        rows = mzscan.parse_fleet("# c\n192.168.1.140\n192.168.1.141,00:11:22:33:44:55\n\n")
        self.assertEqual(rows[0], {"ip": "192.168.1.140", "mac": None})
        self.assertEqual(rows[1]["mac"], "00:11:22:33:44:55")
    def test_bad_ip_raises(self):
        with self.assertRaises(ValueError):
            mzscan.parse_fleet("not-an-ip\n")

class TestReconcile(unittest.TestCase):
    EXP = [{"ip": "1.1.1.1", "mac": "00-11-22-33-44-55"}, {"ip": "1.1.1.2", "mac": None}]
    def test_missing_and_unexpected(self):
        r = mzscan.reconcile(self.EXP, {"1.1.1.1": {"mac": "00-11-22-33-44-55"},
                                        "9.9.9.9": {"mac": "FF"}})
        self.assertEqual(r["missing"], ["1.1.1.2"])
        self.assertEqual(r["unexpected"], ["9.9.9.9"])
    def test_mac_mismatch_case_and_sep_insensitive(self):
        r = mzscan.reconcile(self.EXP, {"1.1.1.1": {"mac": "00:11:22:33:44:55"}})
        self.assertEqual(r["mac_mismatch"], [])
        r2 = mzscan.reconcile(self.EXP, {"1.1.1.1": {"mac": "AA:BB:CC:DD:EE:FF"}})
        self.assertEqual(r2["mac_mismatch"][0]["ip"], "1.1.1.1")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd docs/multi-zone-poc/src && python3 -m unittest test_mzscan -v`
Expected: 新測試 ERROR

- [ ] **Step 3: Implement**

```python
# mzscan.py 追加
import ipaddress

def _norm_mac(m):
    return re.sub(r"[-:]", "", m).lower() if m else None

def parse_fleet(text):
    rows = []
    for ln, line in enumerate(text.splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = [p.strip() for p in line.split(",")]
        try:
            ipaddress.ip_address(parts[0])
        except ValueError:
            raise ValueError("fleet.txt line %d: bad IP %r" % (ln, parts[0]))
        rows.append({"ip": parts[0], "mac": parts[1] if len(parts) > 1 and parts[1] else None})
    return rows

def reconcile(expected, discovered):
    exp_ips = {e["ip"] for e in expected}
    out = {"missing": sorted(exp_ips - set(discovered)),
           "unexpected": sorted(set(discovered) - exp_ips),
           "mac_mismatch": []}
    for e in expected:
        d = discovered.get(e["ip"])
        if d and e["mac"] and _norm_mac(e["mac"]) != _norm_mac(d.get("mac")):
            out["mac_mismatch"].append({"ip": e["ip"], "expected_mac": e["mac"],
                                        "seen_mac": d.get("mac")})
    return out
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd docs/multi-zone-poc/src && python3 -m unittest test_mzscan -v`
Expected: 全數 PASS

- [ ] **Step 5: Commit**

```bash
git add docs/multi-zone-poc/src/mzscan.py docs/multi-zone-poc/src/test_mzscan.py
git commit -m "feat(mzscan): fleet.txt 解析＋missing/unexpected/mac_mismatch 對帳（Task 4）"
```

---

### Task 5: SSH 深探輸出解析（純函式）＋複合探測命令

**Files:**
- Modify: `docs/multi-zone-poc/src/mzscan.py`
- Modify: `docs/multi-zone-poc/src/test_mzscan.py`

**Interfaces:**
- Produces: `PROBE_CMD: str`（單次 SSH 執行的複合命令，`===TAG===` 分段）；`parse_probe_output(out: str) -> dict`（回 facts 子集：`termapp_md5, sipweb_md5, sidecar_relay_bin, sidecar_relay_running, sidecar_init, opt_writable, opt_free_kb, loopback80_403, termapp_multicast_addr`；缺段/亂碼→對應欄 `None`）。

- [ ] **Step 1: Write the failing tests（canned 設備輸出）**

```python
# test_mzscan.py 追加
PROBE_OUT = """===MD5TERMAPP===
b0eed3b30bd4fa4f1599a9475296fb6d  /opt/termapp
===MD5SIPWEB===
abc123abc123abc123abc123abc12345  /etc/sipweb/sipweb
===FILES===
/opt/mzrelay3
/etc/init.d/S21mzrelay
===PS===
 1234 root     mzrelay3
===DF===
Filesystem           1K-blocks      Used Available Use% Mounted on
/dev/root                11264      6144      5120  55% /
===OPTWRITE===
WRITE_OK
===TERMCFG===
MULTICAST_ADDRESS=239.192.1.1:2000
===LOOPBACK80===
HTTP/1.1 403 Forbidden
===END===
"""

class TestParseProbe(unittest.TestCase):
    def test_full_parse(self):
        f = mzscan.parse_probe_output(PROBE_OUT)
        self.assertEqual(f["termapp_md5"], "b0eed3b30bd4fa4f1599a9475296fb6d")
        self.assertEqual(f["sipweb_md5"], "abc123abc123abc123abc123abc12345")
        self.assertTrue(f["sidecar_relay_bin"])
        self.assertTrue(f["sidecar_relay_running"])
        self.assertTrue(f["sidecar_init"])
        self.assertTrue(f["opt_writable"])
        self.assertEqual(f["opt_free_kb"], 5120)
        self.assertTrue(f["loopback80_403"])
        self.assertEqual(f["termapp_multicast_addr"], "239.192.1.1:2000")
    def test_missing_sections_are_none(self):
        f = mzscan.parse_probe_output("===MD5TERMAPP===\ngarbage no md5\n===END===\n")
        self.assertIsNone(f["termapp_md5"])
        self.assertIsNone(f["opt_writable"])
        self.assertIsNone(f["opt_free_kb"])
    def test_write_fail(self):
        f = mzscan.parse_probe_output("===OPTWRITE===\nWRITE_FAIL\n===END===\n")
        self.assertIs(f["opt_writable"], False)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd docs/multi-zone-poc/src && python3 -m unittest test_mzscan -v`
Expected: 新測試 ERROR

- [ ] **Step 3: Implement**

```python
# mzscan.py 追加
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd docs/multi-zone-poc/src && python3 -m unittest test_mzscan -v`
Expected: 全數 PASS

- [ ] **Step 5: Commit**

```bash
git add docs/multi-zone-poc/src/mzscan.py docs/multi-zone-poc/src/test_mzscan.py
git commit -m "feat(mzscan): 單往返複合探測命令＋分段解析（缺段→unknown）（Task 5）"
```

---

### Task 6: I/O 層 — DBP 收發、pty-SSH、host-key、HTTP/REST 探測

**Files:**
- Modify: `docs/multi-zone-poc/src/mzscan.py`

**Interfaces:**
- Consumes: Task 1 `build_dbp_request`/`parse_dbp_reply`、Task 5 `PROBE_CMD`。
- Produces: `dbp_sweep(broadcast: bool, targets: list[str], timeout: float) -> list[dict]`；`ssh_probe(ip: str, pw: str, timeout: float) -> tuple[str|None, str|None]`（回 `(probe輸出, 錯誤訊息)`）；`hostkey_fp(ip: str) -> str|None`（ssh-keyscan + sha256）；`http_probe(ip: str) -> dict`（回 `{"http80": {...}|None, "https": {...}|None, "rest8090_ok": bool|None}`）。
- 本 task 為 I/O 薄層，**不寫單元測試**（邏輯已在 Task 1/5 純函式覆蓋；整體行為由 Task 8 真機 smoke 驗證）。

- [ ] **Step 1: Implement DBP 收發**

```python
# mzscan.py 追加
import socket, time

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
        except socket.timeout:
            pass
    sock.close()
    return replies
```

- [ ] **Step 2: Implement pty-SSH（自 mzctl.py 泛化：host 參數化、密碼注入、殘留清理）**

```python
# mzscan.py 追加
import os, pty, select, signal

SSH_PORT = 9521
SSH_USER = "root"
_SSH_OPTS = ["-p", str(SSH_PORT), "-oHostKeyAlgorithms=+ssh-rsa",
             "-oPubkeyAcceptedAlgorithms=+ssh-rsa",
             "-oKexAlgorithms=+diffie-hellman-group-exchange-sha256,"
             "diffie-hellman-group14-sha1,diffie-hellman-group1-sha1",
             "-oStrictHostKeyChecking=no", "-oUserKnownHostsFile=/dev/null",
             "-oConnectTimeout=8", "-oNumberOfPasswordPrompts=1", "-oLogLevel=ERROR"]

def ssh_probe(ip, pw, timeout=15.0):
    """單次 SSH 跑 PROBE_CMD。回 (輸出, None) 或 (None, 錯誤字串)。保證回收子程序。"""
    argv = ["ssh", *_SSH_OPTS, "%s@%s" % (SSH_USER, ip), PROBE_CMD]
    pid, fd = pty.fork()
    if pid == 0:
        os.execvp(argv[0], argv)
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
            if b"===END===" in buf:
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
    if "===END===" not in out:
        return None, "ssh timeout/incomplete (%d bytes)" % len(buf)
    return out, None
```

- [ ] **Step 3: Implement host-key 指紋＋HTTP/REST 探測**

```python
# mzscan.py 追加
import hashlib, subprocess, ssl, urllib.request, urllib.error

REST_TOKEN = os.environ.get("MZSCAN_REST_TOKEN", "mzpoc-token")

def hostkey_fp(ip, timeout=8):
    """ssh-keyscan -t rsa → SHA256 指紋（base64 key 部分）。失敗回 None。"""
    try:
        out = subprocess.run(["ssh-keyscan", "-p", str(SSH_PORT), "-T", str(timeout),
                              "-t", "rsa", ip],
                             capture_output=True, text=True, timeout=timeout + 4).stdout
    except (subprocess.TimeoutExpired, OSError):
        return None
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 3 and not line.startswith("#"):
            digest = hashlib.sha256(base64.b64decode(parts[2])).digest()
            return "SHA256:" + base64.b64encode(digest).decode().rstrip("=")
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

def http_probe(ip):
    """跳板機側 web/REST 行為探測（不持設備 web token、不登入）。"""
    http80 = _http_get("http://%s/auth/login" % ip)
    https = _http_get("https://%s/get/device/status" % ip, insecure=True)
    rest = _http_get("http://%s:8090/get/sip/multicast/zones" % ip,
                     headers={"Authorization": "Bearer " + REST_TOKEN})
    rest_ok = bool(rest and rest["status"] == 200 and rest["json"]) if rest is not None else None
    return {"http80": http80, "https": https, "rest8090_ok": rest_ok}
```

- [ ] **Step 4: Syntax check + 既有測試不退**

Run: `cd docs/multi-zone-poc/src && python3 -c "import mzscan" && python3 -m unittest test_mzscan -v`
Expected: import 成功、全數 PASS

- [ ] **Step 5: Commit**

```bash
git add docs/multi-zone-poc/src/mzscan.py
git commit -m "feat(mzscan): I/O層 — DBP收發/pty-SSH(殘留清理)/hostkey指紋/HTTP+REST探測（Task 6）"
```

---

### Task 7: inventory 組裝、原子輸出、摘要表、CLI main

**Files:**
- Modify: `docs/multi-zone-poc/src/mzscan.py`
- Modify: `docs/multi-zone-poc/src/test_mzscan.py`

**Interfaces:**
- Consumes: 全部前置 task 函式。
- Produces: `build_inventory(rows, recon, expect_meta, started, finished) -> dict`（頂層：`schema_version="1"`, `scan_id`, `started_at`, `finished_at`, `valid_until`(＝finished+24h ISO8601), `producer="mzscan/1.0"`, `expect`, `reconciliation`, `summary`, `devices`；無 expect 時 `devices[*]` **不含 `action`** 且無 `reconciliation`）；`write_atomic(path: str, obj: dict)`（tmp+rename）；`summary_table(inv) -> str`；`probe_device(ip, dbp_rec, pw) -> dict`（單台完整深探組 row）；`main(argv)`（args：`fleet.txt` 位置參數可選、`--expect`、`--workers 8`、`--timeout 15`、`--mzweb-bin`、`--out DIR`；密碼自 `MZSCAN_SSH_PW`，未設即 exit 2；`ThreadPoolExecutor` 並發；結束後 hostkey 重複後處理→改判 blocked）。
- 掃描器自身故障（廣播 socket 建立失敗等）exit 非 0；掃描完成（無論分類）exit 0。

- [ ] **Step 1: Write the failing tests（組裝與輸出純函式）**

```python
# test_mzscan.py 追加
import json, os, tempfile

def row(ip, action="done", fp=None):
    return {"ip": ip, "action": action, "ssh_hostkey_fp": fp, "fw_ver": "2.1.1",
            "errors": []}

class TestInventory(unittest.TestCase):
    def test_top_level_fields(self):
        inv = mzscan.build_inventory([row("1.1.1.1")], {"missing": [], "unexpected": [],
                                     "mac_mismatch": []}, {"file": "f.txt", "count": 1},
                                     "2026-07-23T10:00:00", "2026-07-23T10:05:00")
        for k in ("schema_version", "scan_id", "valid_until", "producer", "summary"):
            self.assertIn(k, inv)
        self.assertTrue(inv["valid_until"].startswith("2026-07-24T10:05:00"))
    def test_no_expect_no_action(self):
        inv = mzscan.build_inventory([row("1.1.1.1")], None, None,
                                     "2026-07-23T10:00:00", "2026-07-23T10:05:00")
        self.assertNotIn("action", inv["devices"][0])
        self.assertNotIn("reconciliation", inv)
    def test_no_password_leak(self):
        os.environ["MZSCAN_SSH_PW"] = "sekret"
        inv = mzscan.build_inventory([row("1.1.1.1")], None, None,
                                     "2026-07-23T10:00:00", "2026-07-23T10:05:00")
        self.assertNotIn("sekret", json.dumps(inv))
    def test_write_atomic(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "inv.json")
            mzscan.write_atomic(p, {"a": 1})
            self.assertEqual(json.load(open(p)), {"a": 1})
            self.assertEqual(os.listdir(d), ["inv.json"])  # 無殘留 tmp

class TestSummary(unittest.TestCase):
    def test_counts(self):
        inv = mzscan.build_inventory(
            [row("1.1.1.1"), row("1.1.1.2", "needs-fw-upgrade")],
            {"missing": ["1.1.1.3"], "unexpected": [], "mac_mismatch": []},
            {"file": "f.txt", "count": 3},
            "2026-07-23T10:00:00", "2026-07-23T10:05:00")
        t = mzscan.summary_table(inv)
        self.assertIn("done", t)
        self.assertIn("needs-fw-upgrade", t)
        self.assertIn("missing", t)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd docs/multi-zone-poc/src && python3 -m unittest test_mzscan -v`
Expected: 新測試 ERROR

- [ ] **Step 3: Implement 組裝/輸出/摘要**

```python
# mzscan.py 追加
import datetime, uuid, collections

SCHEMA_VERSION = "1"
PRODUCER = "mzscan/1.0"

def build_inventory(rows, recon, expect_meta, started, finished):
    fin = datetime.datetime.fromisoformat(finished)
    inv = {"schema_version": SCHEMA_VERSION, "scan_id": str(uuid.uuid4()),
           "producer": PRODUCER, "started_at": started, "finished_at": finished,
           "valid_until": (fin + datetime.timedelta(hours=24)).isoformat()}
    if expect_meta is None:
        # discovery report 模式：不產 action（spec §五）
        rows = [{k: v for k, v in r.items() if k != "action"} for r in rows]
    else:
        inv["expect"] = expect_meta
        inv["reconciliation"] = recon
    counts = collections.Counter(r.get("action", "discovered") for r in rows)
    inv["summary"] = dict(counts)
    inv["devices"] = rows
    return inv

def write_atomic(path, obj):
    tmp = path + ".tmp"
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
```

- [ ] **Step 4: Implement 單台深探組 row＋main**

```python
# mzscan.py 追加
import argparse
from concurrent.futures import ThreadPoolExecutor

MZWEB_KNOWN_MD5S = set()   # main() 啟動時以 --mzweb-bin 或內嵌常數初始化（Task 8 定稿常數）

def probe_device(ip, dbp_rec, pw, timeout=15.0):
    row = {"ip": ip, "mac": (dbp_rec or {}).get("mac"),
           "fw_ver_dbp": (dbp_rec or {}).get("fw_ver_dbp"),
           "reachable_dbp": dbp_rec is not None,
           "dbp_conflict": bool((dbp_rec or {}).get("dbp_conflict")), "errors": []}
    if row["dbp_conflict"]:
        row["dbp_variants"] = dbp_rec["dbp_variants"]
    row["ssh_hostkey_fp"] = hostkey_fp(ip)
    out, err = ssh_probe(ip, pw, timeout)
    row["ssh_ok"] = out is not None
    if err:
        row["errors"].append(err)
    facts = parse_probe_output(out) if out else dict.fromkeys(
        ("termapp_md5", "sipweb_md5", "sidecar_relay_bin", "sidecar_relay_running",
         "sidecar_init", "opt_writable", "opt_free_kb", "loopback80_403",
         "termapp_multicast_addr"))
    row.update(facts)
    hp = http_probe(ip)
    row["sidecar_rest_ok"] = hp["rest8090_ok"]
    row["fw_ver"] = decide_fw_ver(facts["termapp_md5"], row["fw_ver_dbp"])
    row["web_type"] = decide_web_type(facts["sipweb_md5"], MZWEB_KNOWN_MD5S,
                                      hp["https"], hp["http80"], facts["loopback80_403"])
    for k in ("termapp_md5", "sipweb_md5", "opt_writable", "loopback80_403"):
        if facts.get(k) is None:
            row["errors"].append("probe %s unknown" % k)
    return row

def main(argv=None):
    ap = argparse.ArgumentParser(description="gt-sip-gw fleet pre-flight scanner")
    ap.add_argument("--expect", help="fleet.txt: IP[,MAC] per line")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--timeout", type=float, default=15.0)
    ap.add_argument("--mzweb-bin", help="local mzweb-arm build to trust as mzweb md5")
    ap.add_argument("--out", default=".", help="output dir")
    args = ap.parse_args(argv)
    pw = os.environ.get("MZSCAN_SSH_PW")
    if not pw:
        print("MZSCAN_SSH_PW not set", file=sys.stderr)
        return 2
    if args.mzweb_bin:
        MZWEB_KNOWN_MD5S.add(hashlib.md5(open(args.mzweb_bin, "rb").read()).hexdigest())
    started = datetime.datetime.now().isoformat(timespec="seconds")

    expected = None
    if args.expect:
        expected = parse_fleet(open(args.expect).read())
    discovered = merge_discovery(dbp_sweep(broadcast=True, targets=[]))
    if expected:                       # missing 台 unicast 補掃（spec §七）
        missing = [e["ip"] for e in expected if e["ip"] not in discovered]
        if missing:
            discovered.update(merge_discovery(dbp_sweep(broadcast=False, targets=missing)))
    targets = sorted(set(discovered) | ({e["ip"] for e in expected} if expected else set()))
    print("discovered %d, probing %d ..." % (len(discovered), len(targets)))

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        rows = list(ex.map(lambda ip: probe_device(ip, discovered.get(ip), pw, args.timeout),
                           targets))
    dups = find_hostkey_dups(rows)
    for r in rows:
        r["hostkey_dup"] = r.get("ssh_hostkey_fp") in dups
        if expected is not None:
            r["action"] = classify(r)
    if dups:
        print("!! duplicate host-key fingerprints (possible MITM): %s" % dups, file=sys.stderr)

    finished = datetime.datetime.now().isoformat(timespec="seconds")
    recon = reconcile(expected, discovered) if expected else None
    meta = {"file": args.expect, "count": len(expected)} if expected else None
    inv = build_inventory(rows, recon, meta, started, finished)
    out_path = os.path.join(args.out, "inventory-%s.json"
                            % datetime.datetime.now().strftime("%Y%m%d-%H%M%S"))
    write_atomic(out_path, inv)
    print(summary_table(inv))
    print("inventory: %s" % out_path)
    return 0

if __name__ == "__main__":
    import sys
    sys.exit(main())
```

（`import sys` 移至檔頭 import 區；此處僅示意位置。）

- [ ] **Step 5: Run tests + CLI 冒煙**

Run: `cd docs/multi-zone-poc/src && python3 -m unittest test_mzscan -v && python3 mzscan.py --help`
Expected: 全數 PASS；help 正常列印

- [ ] **Step 6: Commit**

```bash
git add docs/multi-zone-poc/src/mzscan.py docs/multi-zone-poc/src/test_mzscan.py
git commit -m "feat(mzscan): inventory組裝(valid_until/原子寫入/discovery模式無action)＋CLI main（Task 7）"
```

---

### Task 8: 真機實查與 smoke（.70 done 型＋未部署型）

> 需可達實驗設備 `.70`（`MZHOST=192.168.0.70`）。此 task 同時定稿兩個實查項：termapp config 路徑（spec §九）與 mzweb 內嵌 md5 常數。

**Files:**
- Modify: `docs/multi-zone-poc/src/mzscan.py`（TERMCFG 命令定稿＋`MZWEB_KNOWN_MD5S` 內嵌常數）
- Modify: `docs/superpowers/specs/2026-07-23-mzscan-inventory-design.md`（§九 開放事項銷項）

**Interfaces:**
- Consumes: 全部實作。
- Produces: 定稿的 `PROBE_CMD` TERMCFG 段＋`MZWEB_KNOWN_MD5S = {"<實測值>"}`。

- [ ] **Step 1: .70 實查 termapp 單槽 config 路徑**

```bash
cd docs/multi-zone-poc/src
python3 mzctl.py sh 'grep -rl MULTICAST_ADDRESS /opt 2>/dev/null; ls -la /opt'
```
Expected: 找到含 `MULTICAST_ADDRESS` 的確切檔案路徑（例 `/opt/termapp.ini`；以實際輸出為準）。

- [ ] **Step 2: 依實查結果定稿 TERMCFG 段與內嵌 mzweb md5**

把 `PROBE_CMD` 的 `grep -rh "MULTICAST_ADDRESS" /opt …` 改為直讀實查檔案（`grep "MULTICAST_ADDRESS" <實查路徑>`；若 grep 掃 /opt 已正確命中且耗時可接受，保留原式並在註解記錄實查結論）。同時：

```bash
md5sum mzweb/build/mzweb-arm
```
把輸出值寫入 `MZWEB_KNOWN_MD5S = {"<md5值>"}`（含註解：build 日期與來源）。

- [ ] **Step 3: 真機 smoke — .70 應判 done**

```bash
export MZSCAN_SSH_PW=<設備root密碼>   # 見 memory gt-sip-gw-firmware-upgrade-ssh，勿寫入任何檔案
printf '192.168.0.70\n' > /tmp/fleet-smoke.txt
python3 mzscan.py --expect /tmp/fleet-smoke.txt --out /tmp
```
Expected: stdout 摘要 `done 1`；inventory JSON 中 `.70` row：`fw_ver=2.1.1`、`web_type=mzweb`、sidecar 四項 true、`action=done`、`ssh_hostkey_fp` 非空、`errors=[]`。

- [ ] **Step 4: 真機 smoke — 未部署 side-car 機應判 needs-sidecar**

對一台已知 v2.1.1、未裝 side-car 的設備（如 `.147`，以當下實際可用機為準）重複 Step 3。
Expected: `action=needs-sidecar`、sidecar 四項 false、`web_type` 為 `lgw`/`https`/`hbi` 之一（非 mzweb）。

- [ ] **Step 5: 跑全部單元測試（確認定稿改動不退）**

Run: `cd docs/multi-zone-poc/src && python3 -m unittest test_mzscan -v`
Expected: 全數 PASS

- [ ] **Step 6: 銷 spec §九 開放事項＋Commit**

spec §九「termapp 單槽 config 路徑未實查」改為已實查結論（記路徑與命令）。

```bash
git add docs/multi-zone-poc/src/mzscan.py docs/superpowers/specs/2026-07-23-mzscan-inventory-design.md
git commit -m "feat(mzscan): 真機定稿 TERMCFG/mzweb md5 常數；.70+未部署機 smoke 雙型通過（Task 8）"
```

---

## Self-Review

- **Spec coverage**：§三管線（T1 DBP/T5-6 深探/T7 unicast 補掃）、§四三表（T2/T3）、§五身分對帳（T4）、§六輸出契約（T7：valid_until/原子寫入/discovery 無 action/密碼不落盤測試）、§七錯誤處理（T6 kill 殘留、T7 逐台 errors[]）、§八測試（T1-T5/T7 unittest＋T8 真機兩型）、§九實查銷項（T8）。消費契約中「B 部署前重驗」屬 B 的實作，本計畫不涵蓋（spec 已劃界）。
- **Placeholder scan**：唯一延後決定項＝TERMCFG 確切路徑與 mzweb md5 值，皆為 spec §九明定的真機實查項，T8 有明確定稿步驟與驗收，非 TBD。
- **Type consistency**：`facts` 欄位名在 T3 `classify`、T5 `parse_probe_output`、T7 `probe_device` 三處一致（sidecar_* 四鍵、fw_ver/web_type 值域）；`decide_web_type(probe dict)` 與 T6 `_http_get` 回傳形狀一致。

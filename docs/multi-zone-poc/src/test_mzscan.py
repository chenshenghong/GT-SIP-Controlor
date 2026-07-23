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

    def test_merge_partial_fields_no_conflict_order1(self):
        """Partial field responses (missing fields != conflict); order 1: incomplete then complete"""
        a = {"ip": "1.1.1.1", "mac": "AA"}  # missing fw_ver_dbp
        b = {"ip": "1.1.1.1", "mac": "AA", "fw_ver_dbp": "2.1.1"}  # has all
        m = mzscan.merge_discovery([a, b])
        self.assertNotIn("dbp_conflict", m["1.1.1.1"],
                         "Partial fields should NOT trigger conflict")
        # After merge, record should have all fields
        self.assertEqual(m["1.1.1.1"]["mac"], "AA")
        self.assertEqual(m["1.1.1.1"]["fw_ver_dbp"], "2.1.1")

    def test_merge_partial_fields_no_conflict_order2(self):
        """Partial field responses (missing fields != conflict); order 2: complete then incomplete"""
        a = {"ip": "1.1.1.1", "mac": "AA", "fw_ver_dbp": "2.1.1"}  # has all
        b = {"ip": "1.1.1.1", "mac": "AA"}  # missing fw_ver_dbp
        m = mzscan.merge_discovery([a, b])
        self.assertNotIn("dbp_conflict", m["1.1.1.1"],
                         "Partial fields should NOT trigger conflict (order 2)")
        # Record should retain fw_ver_dbp from first response
        self.assertEqual(m["1.1.1.1"]["mac"], "AA")
        self.assertEqual(m["1.1.1.1"]["fw_ver_dbp"], "2.1.1")

    def test_merge_true_conflict_order1(self):
        """True conflict: same field different value; order 1"""
        a = {"ip": "1.1.1.1", "mac": "AA", "fw_ver_dbp": "2.1.0"}
        b = {"ip": "1.1.1.1", "mac": "AA", "fw_ver_dbp": "2.1.1"}
        m = mzscan.merge_discovery([a, b])
        self.assertTrue(m["1.1.1.1"]["dbp_conflict"],
                        "Different field values should trigger conflict")
        self.assertIn("dbp_variants", m["1.1.1.1"])
        variants = m["1.1.1.1"]["dbp_variants"]
        self.assertEqual(len(variants), 2)
        # Check that both versions are captured
        fws = {v.get("fw_ver_dbp") for v in variants}
        self.assertEqual(fws, {"2.1.0", "2.1.1"})

    def test_merge_true_conflict_order2(self):
        """True conflict: same field different value; order 2 (reversed)"""
        a = {"ip": "1.1.1.1", "mac": "AA", "fw_ver_dbp": "2.1.1"}
        b = {"ip": "1.1.1.1", "mac": "AA", "fw_ver_dbp": "2.1.0"}
        m = mzscan.merge_discovery([a, b])
        self.assertTrue(m["1.1.1.1"]["dbp_conflict"],
                        "Different field values should trigger conflict (order 2)")
        self.assertIn("dbp_variants", m["1.1.1.1"])
        variants = m["1.1.1.1"]["dbp_variants"]
        self.assertEqual(len(variants), 2)
        # Check that both versions are captured
        fws = {v.get("fw_ver_dbp") for v in variants}
        self.assertEqual(fws, {"2.1.0", "2.1.1"})

class TestFwDecision(unittest.TestCase):
    V211 = mzscan.TERMAPP_MD5_V211

    def test_md5_match_wins(self):          # md5==已知 → 2.1.1（DBP 任意）
        self.assertEqual(mzscan.decide_fw_ver(self.V211, "2.1.0"), "2.1.1")
        self.assertEqual(mzscan.decide_fw_ver(self.V211, None), "2.1.1")

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
    def test_opt_free_kb_none_blocks(self):
        # Critical 修正：opt_free_kb=None（未探測）→ blocked:probe-incomplete
        self.assertEqual(mzscan.classify(facts(opt_free_kb=None)), "blocked:probe-incomplete")
    def test_ssh_ok_none_blocks(self):
        # Important 修正：ssh_ok=None（未探測）→ blocked:probe-incomplete
        self.assertEqual(mzscan.classify(facts(ssh_ok=None)), "blocked:probe-incomplete")
    def test_reachable_dbp_none_ssh_false_is_no_ssh(self):
        # Important 修正：reachable_dbp=None + ssh_ok=False → blocked:no-ssh（rule2 優先於 rule1）
        self.assertEqual(mzscan.classify(facts(reachable_dbp=None, ssh_ok=False)), "blocked:no-ssh")
    def test_conflict_combo_blocks(self):
        # Minor 1：多條件衝突（dbp_conflict=True + fw_ver="2.1.0"）→ blocked:probe-incomplete（rule4 優先）
        self.assertEqual(mzscan.classify(facts(dbp_conflict=True, fw_ver="2.1.0")), "blocked:probe-incomplete")
    def test_unknown_never_done(self):
        # 不變式：任何關鍵欄 unknown → 必為 blocked:probe-incomplete，永不 done
        for k in ("fw_ver", "web_type", "opt_writable", "opt_free_kb", "ssh_ok",
                  "sidecar_relay_bin", "sidecar_relay_running", "sidecar_init", "sidecar_rest_ok"):
            v = "unknown" if k in ("fw_ver", "web_type") else None
            self.assertEqual(mzscan.classify(facts(**{k: v})), "blocked:probe-incomplete", k)

class TestHostkeyDup(unittest.TestCase):
    def test_dup_found(self):
        rows = [{"ip": "1", "ssh_hostkey_fp": "A"}, {"ip": "2", "ssh_hostkey_fp": "A"},
                {"ip": "3", "ssh_hostkey_fp": "B"}, {"ip": "4", "ssh_hostkey_fp": None}]
        self.assertEqual(mzscan.find_hostkey_dups(rows), {"A"})


class TestFleet(unittest.TestCase):
    def test_parse(self):
        rows = mzscan.parse_fleet("# c\n192.168.1.140\n192.168.1.141,00:11:22:33:44:55\n\n")
        self.assertEqual(rows[0], {"ip": "192.168.1.140", "mac": None})
        self.assertEqual(rows[1]["mac"], "00:11:22:33:44:55")
    def test_bad_ip_raises(self):
        with self.assertRaises(ValueError):
            mzscan.parse_fleet("not-an-ip\n")
    def test_duplicate_ip_raises(self):
        """重複 IP 行 → ValueError fail-closed（52 台名單重複必是人為錯誤）"""
        with self.assertRaises(ValueError) as ctx:
            mzscan.parse_fleet("192.168.1.140\n192.168.1.140,AA:BB:CC:DD:EE:FF\n")
        self.assertIn("duplicate", str(ctx.exception).lower())

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
    def test_discovered_mac_none_no_mismatch(self):
        """discovered 未觀測到 MAC（mac=None）→ 不報 mismatch，即使 expected 有 mac"""
        r = mzscan.reconcile(self.EXP, {"1.1.1.1": {"mac": None}})
        self.assertEqual(r["mac_mismatch"], [])
    def test_expected_mac_none_ignores_discovered(self):
        """expected 無 MAC（mac=None）→ 不報 mismatch，即使 discovered 有任意 mac"""
        exp = [{"ip": "1.1.1.1", "mac": None}]
        r = mzscan.reconcile(exp, {"1.1.1.1": {"mac": "AA:BB:CC:DD:EE:FF"}})
        self.assertEqual(r["mac_mismatch"], [])


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
===REST8090===
HTTP/1.1 200 OK
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
        self.assertTrue(f["sidecar_rest_ok"])
    def test_rest8090_non_200_is_false(self):
        """REST8090 段回非 200（如側車未起）→ sidecar_rest_ok=False"""
        f = mzscan.parse_probe_output("===REST8090===\nHTTP/1.1 500 Internal Server Error\n===END===\n")
        self.assertIs(f["sidecar_rest_ok"], False)
    def test_rest8090_empty_body_is_none(self):
        """REST8090 段空白（nc 連線被拒/無輸出）→ sidecar_rest_ok=None（unknown）"""
        f = mzscan.parse_probe_output("===REST8090===\n\n===END===\n")
        self.assertIsNone(f["sidecar_rest_ok"])
    def test_missing_sections_are_none(self):
        f = mzscan.parse_probe_output("===MD5TERMAPP===\ngarbage no md5\n===END===\n")
        self.assertIsNone(f["termapp_md5"])
        self.assertIsNone(f["opt_writable"])
        self.assertIsNone(f["opt_free_kb"])
    def test_write_fail(self):
        f = mzscan.parse_probe_output("===OPTWRITE===\nWRITE_FAIL\n===END===\n")
        self.assertIs(f["opt_writable"], False)
    def test_body_contains_weird_tags(self):
        """Body 內偶現 ===XXX=== 樣式（如 TERMCFG grep 掃到的設定檔內容）時，
        正確分割應錨定整行，不被迷惑。未錨定會造成錯位切段、FILES 內容被截斷。"""
        # 此測試驗證 body 含 ===WEIRD=== 時，FILES 仍能保留完整內容（/etc/init.d/S21mzrelay）
        probe_out = """===FILES===
/opt/mzrelay3
some===WEIRD===line should not split here
/etc/init.d/S21mzrelay
===PS===
 1234 root     mzrelay3
===END===
"""
        f = mzscan.parse_probe_output(probe_out)
        # FILES body 應包含完整的兩行路徑，不因中間的 ===WEIRD=== 而截斷
        # 檢查兩個檔案都被正確偵測
        self.assertTrue(f["sidecar_relay_bin"], "FILES 應包含 /opt/mzrelay3")
        self.assertTrue(f["sidecar_init"], "FILES 應包含 /etc/init.d/S21mzrelay（不被 ===WEIRD=== 截斷）")
    def test_exists_is_none(self):
        """OPTWRITE 段含 EXISTS（殘留測試檔）→ opt_writable=None（未實測寫入=未知）"""
        f = mzscan.parse_probe_output("===OPTWRITE===\nEXISTS\n===END===\n")
        self.assertIsNone(f["opt_writable"])


class TestParseKeyscanLine(unittest.TestCase):
    def test_comment_line(self):
        """ssh-keyscan output comment line → None"""
        line = "# SSH-2.0-OpenSSH_7.4"
        self.assertIsNone(mzscan._parse_keyscan_line(line))

    def test_malformed_base64(self):
        """Malformed base64 in key field → None (ValueError caught)"""
        line = "192.168.1.1 ssh-rsa !!INVALID_BASE64!!"
        self.assertIsNone(mzscan._parse_keyscan_line(line))

    def test_incomplete_base64(self):
        """Incomplete/truncated base64 in key field → None"""
        line = "192.168.1.1 ssh-rsa AAAAB3NzaC1yc2E"  # truncated, invalid padding
        self.assertIsNone(mzscan._parse_keyscan_line(line))

    def test_too_few_fields(self):
        """Too few fields in line → None"""
        line = "192.168.1.1 ssh-rsa"
        self.assertIsNone(mzscan._parse_keyscan_line(line))

    def test_empty_line(self):
        """Empty line → None"""
        self.assertIsNone(mzscan._parse_keyscan_line(""))


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


import contextlib, io
from unittest import mock

class TestCliExpectOnly(unittest.TestCase):
    def test_no_positional_fleet_arg(self):
        """spec §五唯一介面：位置參數 fleet 已移除，只留 --expect；未知位置參數 → argparse error (SystemExit 2)."""
        os.environ["MZSCAN_SSH_PW"] = "pw"
        with self.assertRaises(SystemExit) as cm:
            with contextlib.redirect_stderr(io.StringIO()):
                mzscan.main(["some-positional.txt"])
        self.assertEqual(cm.exception.code, 2)


class TestEmptyFleetFailClosed(unittest.TestCase):
    def test_empty_expect_file_exit2(self):
        """--expect 檔解析出 0 筆有效項目 → fail-closed exit 2（同重複IP哲學）。"""
        os.environ["MZSCAN_SSH_PW"] = "pw"
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "empty.txt")
            with open(p, "w") as fh:
                fh.write("# nothing here\n\n")
            with contextlib.redirect_stderr(io.StringIO()) as err:
                rc = mzscan.main(["--expect", p])
            self.assertEqual(rc, 2)
            self.assertIn("no valid entries", err.getvalue())


class TestProbeDeviceCrashGuard(unittest.TestCase):
    def test_unexpected_exception_returns_crashed_row(self):
        """probe_device 內部任何未預期例外 → row 保底回傳(errors 含 crashed)，不炸整批 ex.map。"""
        with mock.patch.object(mzscan, "hostkey_fp", side_effect=RuntimeError("boom")):
            row = mzscan.probe_device("1.1.1.1", None, "pw")
        self.assertEqual(row["ip"], "1.1.1.1")
        self.assertTrue(any("probe_device crashed" in e for e in row["errors"]))


class TestNoMzwebMd5Warning(unittest.TestCase):
    def test_warns_when_md5_table_empty(self):
        """MZWEB_KNOWN_MD5S 為空且未給 --mzweb-bin → stderr 印 WARNING（Task 8 定稿前已知留白）。"""
        os.environ["MZSCAN_SSH_PW"] = "pw"
        mzscan.MZWEB_KNOWN_MD5S.clear()
        with tempfile.TemporaryDirectory() as d:
            with mock.patch.object(mzscan, "dbp_sweep", return_value=[]):
                with contextlib.redirect_stderr(io.StringIO()) as err:
                    rc = mzscan.main(["--out", d])
            self.assertEqual(rc, 0)
            self.assertIn("WARNING", err.getvalue())
            self.assertIn("mzweb", err.getvalue().lower())


if __name__ == "__main__":
    unittest.main()

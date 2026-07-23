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


if __name__ == "__main__":
    unittest.main()

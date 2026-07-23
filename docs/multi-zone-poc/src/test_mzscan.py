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

if __name__ == "__main__":
    unittest.main()

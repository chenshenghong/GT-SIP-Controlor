# test_mzstate.py
import json, os, tempfile, unittest
import mzscan
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

    def test_cert_absent(self):
        out = SCAN2_PROBE_SAMPLE.replace(
            "-rw-r--r--    1 root  root  1234 Jan  1 00:00 /etc/sipweb/mz.crt",
            "ls: /etc/sipweb/mz.crt: No such file or directory")
        self.assertIs(mzscan.parse_probe_v2(out)["cert_crt_exists"], False)

    def test_mzio_facts(self):
        self.assertIs(self.f["mzio_bin"], True)     # ls 有列 /opt/mzio
        self.assertIs(self.f["mzio_init"], False)   # 未列 S21mzio
        self.assertIs(self.f["mzio_running"], False)

    def test_mzio_running_from_ps(self):
        out = SCAN2_PROBE_SAMPLE.replace(
            "===MZIO===\n/opt/mzio",
            "===MZIO===\n/opt/mzio\n  512 root      0:00 mzio")
        self.assertIs(mzscan.parse_probe_v2(out)["mzio_running"], True)

    def test_v2_none_facts_fresh_copies(self):
        a, b = mzscan.v2_none_facts(), mzscan.v2_none_facts()
        a["sidecar_md5s"]["mzio"]["state"] = "mutated"
        self.assertEqual(b["sidecar_md5s"]["mzio"]["state"], "error")

    def test_schema_version_is_2(self):
        self.assertEqual(mzscan.SCHEMA_VERSION, "2")


if __name__ == "__main__":
    unittest.main()

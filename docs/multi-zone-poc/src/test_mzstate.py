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

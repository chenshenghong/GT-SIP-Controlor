# test_mzstate.py
import json, os, subprocess, tempfile, unittest
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

    def test_mzio_running_busybox_fullpath_ps(self):
        # 真機 .70 實測（2026-07-24）：busybox ps 命令欄是全路徑 /opt/mzio——
        # 舊版用「行含 / 視為 ls 輸出」的 guard 會把 ps 行濾掉造成 running 誤判 False。
        out = SCAN2_PROBE_SAMPLE.replace(
            "===MZIO===\n/opt/mzio",
            "===MZIO===\n/opt/mzio\n29138 root       0:00 /opt/mzio")
        self.assertIs(mzscan.parse_probe_v2(out)["mzio_running"], True)

    def test_v2_none_facts_fresh_copies(self):
        a, b = mzscan.v2_none_facts(), mzscan.v2_none_facts()
        a["sidecar_md5s"]["mzio"]["state"] = "mutated"
        self.assertEqual(b["sidecar_md5s"]["mzio"]["state"], "error")

    def test_schema_version_is_2(self):
        self.assertEqual(mzscan.SCHEMA_VERSION, "2")


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

    def test_factory_machine_service_nulls_still_deploy(self):
        # 站內 .140 實測（2026-07-24）：工廠未部署機 rest_ok=None（無 sidecar→連線拒）、
        # singleslot 兩欄 None（工廠 ifcfg-sip 無 MULTICAST_* 鍵）——這些是 config 階段
        # （13/15/READY）才必需的 B 層事實，不得在元件缺口階段擋成 21。
        row = mk_row(mzstate_marker={"state": "absent", "raw": None},
                     sidecar_rest_ok=None, singleslot_mc_addr=None,
                     singleslot_mc_port=None, singleslot_enabled=None,
                     cert_crt_exists=False, cert_key_exists=False,
                     cert_key_perm_ok=None)
        for n in row["sidecar_md5s"]:
            row["sidecar_md5s"][n] = {"state": "absent", "md5": None}
        r = self.d(row, cert={"tls_ok": False, "san_ok": None, "expiry_ok": None})
        self.assertEqual(r["exit_code"], 10)

    def test_service_null_blocks_at_config_stage(self):
        # B 層事實在元件全 ok「且無 down 定性訊號」時仍是必需：
        # relay 活著但 rest_ok=None（探測異常）→ 21（不得矇著判 13/15/READY）
        r = self.d(mk_row(sidecar_rest_ok=None, sidecar_relay_running=True))
        self.assertEqual(r["exit_code"], 21)

    def test_relay_daemon_down_is_restart_not_21(self):
        # 最終對抗審查 I-1：mzrelay3 掛掉時 nc 連線被拒→rest_ok 天然 None，
        # 但 relay_running=False 已是 down 的定性鐵證——必須走 13/restart_services，
        # 否則部署後最常見 transient 全卡 retry→人工佇列。
        r = self.d(mk_row(sidecar_relay_running=False, sidecar_rest_ok=None))
        self.assertEqual(r["exit_code"], 13)
        self.assertIn("restart_services", r["required_actions"])

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
        d = tempfile.mkdtemp()
        invp = os.path.join(d, "inv.json")
        with open(invp, "w") as fh:
            json.dump(inv_obj, fh)
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

    def test_lock_stale_reclaim_rules(self):
        # 對抗審查 M-2：同主機+逾 120s+pid 死 → 可回收；其餘一律不可（人工 break-glass）
        dead = lambda pid: False
        alive = lambda pid: True
        self.assertTrue(mzstate.lock_is_stale("jb 123 1000", 1200, "jb", dead))
        self.assertFalse(mzstate.lock_is_stale("jb 123 1000", 1200, "jb", alive))    # pid 活著
        self.assertFalse(mzstate.lock_is_stale("jb 123 1100", 1200, "jb", dead))     # 未逾 120s
        self.assertFalse(mzstate.lock_is_stale("other 123 1000", 1200, "jb", dead))  # 異主機
        self.assertFalse(mzstate.lock_is_stale("garbage", 1200, "jb", dead))         # 解析失敗
        self.assertFalse(mzstate.lock_is_stale("", 1200, "jb", dead))

    def test_delete_only_skips_verification(self):
        calls = []
        def fake_probe(ip, pw):
            a = {n: {"state": "present", "md5": "bad0"*8}   # 全部不符也無妨
                 for n in mzstate.COMPONENTS}
            return a, None, None
        class A: probe="1.2.3.4"; components=""; delete="mzweb"
        rc = mzstate.run_mark(A(), VALID_MANIFEST, "pw", fake_probe,
                              lambda ip, obj: calls.append(obj))
        self.assertEqual(rc, 0)
        self.assertNotIn("mzweb", calls[0]["components"])   # 只刪、有寫檔


if __name__ == "__main__":
    unittest.main()

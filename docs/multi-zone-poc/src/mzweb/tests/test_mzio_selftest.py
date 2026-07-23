#!/usr/bin/env python3
"""Task 7 mzio -t 組態自檢（不碰 GPIO/網路，容器可跑）。五條斷言（brief Step 1 + 對抗審查 Minor）：
  1. 無 config 檔（MZIO_JSON 指向不存在路徑）→ mzio -t exit 0，stdout 含 "io2"（id2 內建
     預設啟用）且含 "gpio45"（GPIO5_5 → Linux 45 對映正確）
  2. config 檔含 id2 mode:"disabled" → mzio -t stdout 顯示 0 個啟用腳、exit 0
  3. config 檔壞 JSON → mzio -t exit 0 並 stderr 警告 fallback 預設（與 mzweb GET 行為一致）
  4. config 檔 id2 debounce_ms:999（非法）→ mzio -t exit 1（fail loudly，防手改壞檔靜默上線）
  5. config 檔兩列同 id2（重複 id）→ mzio -t exit 1（Minor 對抗審查：daemon 端原本不查重複
     id，手改設定檔可對同一 gpio 開兩個 fd、雙 dispatch；此斷言修前為 fail，修後轉綠）
"""
import json
import os
import subprocess

BIN = "build/mzio-x86"

_DISABLED_ROW = {
    "id": 0, "gpio": "", "mode": "disabled", "contact": "NO", "trigger": "edge",
    "debounce_ms": 30, "action": {"type": "hangup", "param": ""},
}


def _row(id_, **overrides):
    row = dict(_DISABLED_ROW)
    row["id"] = id_
    row.update(overrides)
    return row


def run_t(json_path):
    env = dict(os.environ)
    env["MZIO_JSON"] = json_path
    env["MZIO_GPIO_ROOT"] = "/tmp/mzio_selftest_gpio_root_unused"
    env["MZIO_IFCFG"] = "/tmp/mzio_selftest_ifcfg_unused"
    env["MZIO_STATE"] = "/tmp/mzio_selftest_state_unused"
    env["MZIO_PIDFILE"] = "/tmp/mzio_selftest_pid_unused"
    return subprocess.run([BIN, "-t"], env=env, capture_output=True, text=True, timeout=5)


def write_cfg(path, rows):
    with open(path, "w") as f:
        json.dump({"io_config": rows}, f)


def test_no_config_uses_builtin_defaults():
    p = run_t("/tmp/mzio_selftest_nonexistent.json")
    assert p.returncode == 0, (p.stdout, p.stderr)
    assert "io2" in p.stdout, p.stdout
    assert "gpio45" in p.stdout, p.stdout


def test_id2_disabled_shows_zero_enabled():
    path = "/tmp/mzio_selftest_disabled.json"
    write_cfg(path, [
        _row(1),
        _row(2, gpio="GPIO5_5", mode="disabled", trigger="level",
             action={"type": "multicast_ptt", "param": "300"}),
        _row(3, gpio="GPIO1_6"),
        _row(4), _row(5), _row(6),
    ])
    try:
        p = run_t(path)
        assert p.returncode == 0, (p.stdout, p.stderr)
        assert "0 enabled channel" in p.stdout, p.stdout
    finally:
        os.unlink(path)


def test_bad_json_falls_back_with_warning():
    path = "/tmp/mzio_selftest_badjson.json"
    with open(path, "w") as f:
        f.write("{not valid json")
    try:
        p = run_t(path)
        assert p.returncode == 0, (p.stdout, p.stderr)
        assert "fallback" in p.stderr.lower() or "falling back" in p.stderr.lower(), p.stderr
    finally:
        os.unlink(path)


def test_invalid_value_fails_closed():
    path = "/tmp/mzio_selftest_badval.json"
    write_cfg(path, [
        _row(1),
        _row(2, gpio="GPIO5_5", mode="input", trigger="level", debounce_ms=999,
             action={"type": "multicast_ptt", "param": "300"}),
        _row(3, gpio="GPIO1_6"),
        _row(4), _row(5), _row(6),
    ])
    try:
        p = run_t(path)
        assert p.returncode == 1, (p.stdout, p.stderr)
    finally:
        os.unlink(path)


def test_dup_id_fails_closed():
    path = "/tmp/mzio_selftest_dupid.json"
    write_cfg(path, [
        _row(1),
        _row(2, gpio="GPIO5_5", mode="input", trigger="level",
             action={"type": "multicast_ptt", "param": "300"}),
        _row(2, gpio="GPIO5_5", mode="disabled"),
        _row(4), _row(5), _row(6),
    ])
    try:
        p = run_t(path)
        assert p.returncode == 1, (p.stdout, p.stderr)
    finally:
        os.unlink(path)


if __name__ == "__main__":
    test_no_config_uses_builtin_defaults()
    test_id2_disabled_shows_zero_enabled()
    test_bad_json_falls_back_with_warning()
    test_invalid_value_fails_closed()
    test_dup_id_fails_closed()
    print("test_mzio_selftest: ALL PASS")

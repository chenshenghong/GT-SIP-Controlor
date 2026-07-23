#!/usr/bin/env python3
"""P7 T7 測試替身：假 mzrelay3 REST（127.0.0.1:8090）。
zones GET 回固定 16 區 JSON；zones POST echo 回 success＋echo_zones。
供 test_zones.py 驗證 mzweb 的 loopback 轉呼路徑。"""
from http.server import BaseHTTPRequestHandler, HTTPServer
import json

ZONES = {"zones": [{"zone_id": i + 1, "multicast_address": "", "multicast_port": 0,
                    "priority": 0, "enabled": False, "audio_codec": "G.722"} for i in range(16)]}


class H(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path == "/get/sip/multicast/zones":
            self._send(200, ZONES)
        else:
            self._send(404, {})

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(n)) if n else {}
        if self.path == "/set/sip/multicast/zones":
            self._send(200, {"status": "success", "echo_zones": len(body.get("zones", []))})
        else:
            self._send(404, {})

    def log_message(self, *a):
        pass


HTTPServer(("127.0.0.1", 8090), H).serve_forever()

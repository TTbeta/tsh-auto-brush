"""ELT 日志接收器 —— 只绑 127.0.0.1，把采集脚本发来的日志追加到 logs/elt-YYYYMMDD.log。

启动：python logsrv.py [port]
接口：
  POST /log   body = {"lines":[...]} 或 {"lines":[...],"snap":{...}}
  GET  /health
"""
import datetime
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE = os.path.dirname(os.path.abspath(__file__))
LOG_DIR = os.path.join(BASE, "logs")
os.makedirs(LOG_DIR, exist_ok=True)

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765


def log_path():
    return os.path.join(LOG_DIR, "elt-%s.log" % datetime.date.today().strftime("%Y%m%d"))


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code, payload=b"ok"):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path.startswith("/health"):
            self._send(200, b'{"ok":true}')
        else:
            self._send(404, b'{"err":"not found"}')

    def do_POST(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(n) if n else b"{}"
            data = json.loads(raw.decode("utf-8", "replace"))
        except Exception as e:
            self._send(400, json.dumps({"err": str(e)}).encode())
            return

        ts = datetime.datetime.now().strftime("%H:%M:%S")
        lines = data.get("lines") or []
        snap = data.get("snap")
        try:
            with open(log_path(), "a", encoding="utf-8") as f:
                for L in lines:
                    f.write("[%s] %s\n" % (ts, str(L)[:8000]))
                if snap:
                    f.write("[%s] === SNAPSHOT ===\n" % ts)
                    f.write(json.dumps(snap, ensure_ascii=False)[:40000] + "\n")
        except Exception as e:
            self._send(500, json.dumps({"err": str(e)}).encode())
            return
        self._send(200, b'{"ok":true}')

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print("log receiver on http://127.0.0.1:%d  ->  %s" % (PORT, log_path()))
    srv.serve_forever()

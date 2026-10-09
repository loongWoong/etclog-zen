"""无头验证用的临时收数服务：POST /log 追加到 _sink.txt（临时脚本）。"""
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SINK = Path(r"F:\caochun\etclog\replay\_sink.txt")


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length).decode("utf-8", "replace")
        if self.path.startswith("/log") and body.strip():
            with SINK.open("a", encoding="utf-8") as handle:
                handle.write(body.strip() + "\n")
            print(f"[sink] {len(body)} 字节", flush=True)
        self.send_response(204)
        self._cors()
        self.end_headers()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8799
    print(f"[sink] http://127.0.0.1:{port}/log -> {SINK}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()

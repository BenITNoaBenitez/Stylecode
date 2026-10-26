"""Serve the site locally with the response headers declared in vercel.json.

Run: python3 tests/header-server.py (http://127.0.0.1:8780).
This test server only supports the site's global /(.*) header rule.
"""
import json
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RULES = json.loads((ROOT / "vercel.json").read_text())["headers"]
assert all(rule["source"] == "/(.*)" for rule in RULES)


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        for rule in RULES:
            for header in rule["headers"]:
                self.send_header(header["key"], header["value"])
        super().end_headers()

    def log_message(self, *_args):
        pass


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", 8780), partial(Handler, directory=str(ROOT)))
    print("Preview with Vercel headers: http://127.0.0.1:8780", flush=True)
    server.serve_forever()

"""Boson AI (Higgs) API playground - Python backend proxy.

A zero-dependency alternative to server.js: it uses only the Python standard
library, so it runs with any Python 3.8+ install and no `pip install` step.

The browser never sees your BOSON_API_KEY. Every call the UI makes hits this
server, which attaches the Authorization header and forwards the request to
https://api.boson.ai. For Realtime, the server mints a short-lived client
secret and the browser connects directly over WebSocket.

Run:
    # PowerShell
    $env:BOSON_API_KEY = "bai-xxxx"
    python server.py
Then open http://localhost:3000
"""

import json
import os
import sys
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PUBLIC_DIR = Path(__file__).parent / "public"
PORT = int(os.environ.get("PORT", "3000"))
API_BASE = os.environ.get("BOSON_API_BASE", "https://api.boson.ai/v1")


def load_dotenv():
    """Minimal .env loader (KEY=VALUE per line) so you don't need python-dotenv."""
    env_path = Path(__file__).parent / ".env"
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            os.environ.setdefault(key.strip(), val.strip())


load_dotenv()
API_KEY = os.environ.get("BOSON_API_KEY")

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}


def auth_headers(extra=None):
    headers = {"Authorization": f"Bearer {API_KEY}"}
    if extra:
        headers.update(extra)
    return headers


def boson_request(method, path, *, json_body=None, raw=False):
    """Call the Boson API. Returns (status, content_type, body_bytes)."""
    url = f"{API_BASE}{path}"
    data = None
    headers = auth_headers()
    if json_body is not None:
        data = json.dumps(json_body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, resp.headers.get("Content-Type", ""), resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("Content-Type", "application/json"), e.read()
    except urllib.error.URLError as e:
        body = json.dumps({"error": {"message": str(e), "type": "proxy_error"}}).encode()
        return 502, "application/json", body


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # quieter logs
        sys.stderr.write("  %s - %s\n" % (self.address_string(), fmt % args))

    # -- helpers ----------------------------------------------------------
    def _send(self, status, content_type, body):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, status, obj):
        self._send(status, "application/json", json.dumps(obj))

    def _read_json(self):
        length = int(self.headers.get("Content-Length", 0))
        if not length:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8") or "{}")

    def _require_key(self):
        if not API_KEY:
            self._send_json(500, {"error": {
                "message": "BOSON_API_KEY is not set. Copy .env.example to .env and add your key, then restart.",
                "type": "config_error",
            }})
            return False
        return True

    def _relay(self, status, content_type, body):
        self._send(status, content_type or "application/json", body)

    # -- routing ----------------------------------------------------------
    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/health":
            return self._send_json(200, {"ok": True, "keyConfigured": bool(API_KEY), "apiBase": API_BASE})
        if path == "/api/voices":
            if not self._require_key():
                return
            return self._relay(*boson_request("GET", "/audio/voices"))
        if path.startswith("/api/voices/"):
            if not self._require_key():
                return
            vid = path[len("/api/voices/"):]
            return self._relay(*boson_request("GET", f"/audio/voices/{vid}"))
        if path.startswith("/api/videos/") and path.endswith("/content"):
            if not self._require_key():
                return
            vid = path[len("/api/videos/"):-len("/content")]
            return self._relay(*boson_request("GET", f"/videos/{vid}/content"))
        if path.startswith("/api/videos/"):
            if not self._require_key():
                return
            vid = path[len("/api/videos/"):]
            return self._relay(*boson_request("GET", f"/videos/{vid}"))
        return self._serve_static(path)

    def do_POST(self):
        path = self.path.split("?")[0]
        if not path.startswith("/api/"):
            return self._send_json(404, {"error": {"message": "Not found"}})
        if not self._require_key():
            return
        try:
            body = self._read_json()
        except json.JSONDecodeError:
            return self._send_json(400, {"error": {"message": "Invalid JSON body"}})

        if path == "/api/tts/speech":
            return self._relay(*boson_request("POST", "/audio/speech", json_body=body))
        if path == "/api/voices":
            return self._relay(*boson_request("POST", "/audio/voices", json_body=body))
        if path == "/api/videos":
            return self._relay(*boson_request("POST", "/videos", json_body=body))
        if path == "/api/realtime/client-secret":
            return self._relay(*boson_request("POST", "/realtime/client_secrets", json_body=body))
        return self._send_json(404, {"error": {"message": "Unknown route"}})

    def do_DELETE(self):
        path = self.path.split("?")[0]
        if path.startswith("/api/voices/"):
            if not self._require_key():
                return
            vid = path[len("/api/voices/"):]
            return self._relay(*boson_request("DELETE", f"/audio/voices/{vid}"))
        return self._send_json(404, {"error": {"message": "Not found"}})

    # -- static files -----------------------------------------------------
    def _serve_static(self, path):
        if path == "/":
            path = "/index.html"
        target = (PUBLIC_DIR / path.lstrip("/")).resolve()
        if not str(target).startswith(str(PUBLIC_DIR.resolve())) or not target.is_file():
            return self._send_json(404, {"error": {"message": "Not found"}})
        ctype = CONTENT_TYPES.get(target.suffix, "application/octet-stream")
        self._send(200, ctype, target.read_bytes())


def main():
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"\n  Boson Higgs playground running at http://localhost:{PORT}")
    print(f"  API base: {API_BASE}")
    print(f"  API key:  {'configured OK' if API_KEY else 'MISSING  (set BOSON_API_KEY or create .env)'}\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Shutting down.")
        server.shutdown()


if __name__ == "__main__":
    main()

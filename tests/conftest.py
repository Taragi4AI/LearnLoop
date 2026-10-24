"""Shared fixtures for LearnLoop proxy characterization + parity tests.

These tests mock the Boson upstream at the NETWORK boundary by standing up a
tiny local HTTP server and pointing the app's BOSON_API_BASE at it. No real
Boson credentials are used and no paid/external calls are made.

The same suite runs against two backends:
  - the existing Python proxy  (server.py)          -> baseline
  - the FastAPI migration      (app:app via uvicorn) -> parity target

Backend selection is via the LEARNLOOP_BACKEND env var ("legacy" | "fastapi"),
defaulting to "legacy" so the baseline is what runs by default.
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
FAKE_API_KEY = "bai-test-key-not-real"


def _free_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


# ---------------------------------------------------------------------------
# Fake Boson upstream — records the last request and returns canned responses
# that mirror the SHAPES the real API uses (JSON envelopes, binary audio/video,
# error bodies). It is deliberately dumb: it asserts nothing, just lets the
# proxy's forwarding/relaying behavior be observed.
# ---------------------------------------------------------------------------
class _Recorder:
    def __init__(self):
        self.last = None  # dict: method, path, headers, body


def _make_fake_upstream(recorder: _Recorder):
    class FakeHandler(BaseHTTPRequestHandler):
        def log_message(self, *a):  # keep test output quiet
            pass

        def _record(self):
            length = int(self.headers.get("Content-Length", 0) or 0)
            body = self.rfile.read(length) if length else b""
            recorder.last = {
                "method": self.command,
                "path": self.path,
                "headers": {k: v for k, v in self.headers.items()},
                "body": body,
            }
            return body

        def _reply(self, status, ctype, payload: bytes):
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        # The proxy forwards to {BASE}{path}. We configure BASE as
        # http://host/v1, so the real Boson mount point is emulated by treating
        # a leading "/v1" as the API root and matching the suffix below.
        @staticmethod
        def _api_path(raw: str) -> str:
            p = raw.split("?")[0]
            if p.startswith("/v1"):
                p = p[len("/v1"):]
            return p

        def do_GET(self):
            self._record()
            path = self._api_path(self.path)
            if path == "/audio/voices":
                self._reply(200, "application/json",
                            json.dumps({"data": [{"voice": "voice_abc", "description": "demo"}]}).encode())
            elif path.startswith("/audio/voices/"):
                vid = path.rsplit("/", 1)[-1]
                self._reply(200, "application/json", json.dumps({"voice": vid}).encode())
            elif path.endswith("/content"):
                # Binary MP4 bytes.
                self._reply(200, "video/mp4", b"\x00\x00\x00\x18ftypmp42FAKEMP4BYTES")
            elif path.startswith("/videos/"):
                self._reply(200, "application/json",
                            json.dumps({"id": "vid_123", "status": "completed", "progress": 100}).encode())
            else:
                self._reply(404, "application/json",
                            json.dumps({"error": {"message": "no such path", "type": "not_found"}}).encode())

        def do_POST(self):
            body = self._record()
            path = self._api_path(self.path)
            if path == "/audio/speech":
                try:
                    parsed = json.loads(body or b"{}")
                except json.JSONDecodeError:
                    parsed = {}
                if parsed.get("timestamps"):
                    # JSON envelope: base64 audio + word timings.
                    self._reply(200, "application/json", json.dumps({
                        "audio": "QUJD",  # base64 "ABC"
                        "response_format": parsed.get("response_format", "mp3"),
                        "timestamps": [{"word": "hi", "start": 0.0, "end": 0.2}],
                    }).encode())
                else:
                    # Binary audio stream.
                    self._reply(200, "audio/mpeg", b"ID3FAKEAUDIOBYTES")
            elif path == "/audio/voices":
                self._reply(200, "application/json", json.dumps({"voice": "voice_new"}).encode())
            elif path == "/videos":
                self._reply(200, "application/json",
                            json.dumps({"id": "vid_123", "status": "queued"}).encode())
            elif path == "/realtime/client_secrets":
                self._reply(200, "application/json",
                            json.dumps({"value": "bai-eph-fake", "expires_at": 9999999999}).encode())
            else:
                self._reply(404, "application/json",
                            json.dumps({"error": {"message": "no such path", "type": "not_found"}}).encode())

        def do_DELETE(self):
            self._record()
            path = self._api_path(self.path)
            if path.startswith("/audio/voices/"):
                vid = path.rsplit("/", 1)[-1]
                self._reply(200, "application/json", json.dumps({"deleted": True, "voice": vid}).encode())
            else:
                self._reply(404, "application/json",
                            json.dumps({"error": {"message": "no such path"}}).encode())

    return FakeHandler


def _wait_for_http(url: str, timeout: float = 15.0):
    deadline = time.time() + timeout
    last_err = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1) as r:
                r.read()
                return
        except Exception as e:  # noqa: BLE001
            last_err = e
            time.sleep(0.2)
    raise RuntimeError(f"server at {url} did not come up: {last_err}")


@pytest.fixture(scope="session")
def fake_upstream():
    recorder = _Recorder()
    port = _free_port()
    httpd = ThreadingHTTPServer(("127.0.0.1", port), _make_fake_upstream(recorder))
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    yield {"base": f"http://127.0.0.1:{port}", "recorder": recorder}
    httpd.shutdown()


@pytest.fixture(scope="session")
def app_server(fake_upstream):
    """Start the selected backend as a subprocess, env-pointed at the fake upstream."""
    backend = os.environ.get("LEARNLOOP_BACKEND", "legacy")
    app_port = _free_port()
    env = dict(os.environ)
    env["BOSON_API_KEY"] = FAKE_API_KEY
    env["BOSON_API_BASE"] = fake_upstream["base"] + "/v1"
    env["PORT"] = str(app_port)

    if backend == "legacy":
        cmd = [sys.executable, "server.py"]
    elif backend == "fastapi":
        # Run via uvicorn; app lives in server_fastapi.py as `app`.
        cmd = [sys.executable, "-m", "uvicorn", "server_fastapi:app",
               "--host", "127.0.0.1", "--port", str(app_port), "--log-level", "warning"]
    else:
        raise RuntimeError(f"unknown LEARNLOOP_BACKEND={backend!r}")

    proc = subprocess.Popen(cmd, cwd=str(ROOT), env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    base = f"http://127.0.0.1:{app_port}"
    try:
        _wait_for_http(base + "/api/health")
    except Exception:
        proc.terminate()
        out = b""
        try:
            out = proc.stdout.read() if proc.stdout else b""
        except Exception:  # noqa: BLE001
            pass
        raise RuntimeError(f"{backend} backend failed to start:\n{out.decode(errors='replace')}")

    yield {"base": base, "backend": backend, "proc": proc}

    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()

"""LearnLoop backend - FastAPI migration of the Boson (Higgs) proxy.

Milestone 0 scope: reproduce EXACTLY the behavior of the existing `server.py`
proxy, verified by the characterization suite in `tests/`. No new product
features (no uploads, transcription, wake word, Realtime refactor, bookmarks,
or AI tools) are added here yet.

Contract preserved from server.py:
  - Routes: /api/health, /api/tts/speech, /api/voices (CRUD),
    /api/videos (+/content), /api/realtime/client-secret
  - The long-lived BOSON_API_KEY stays server-side; it is attached as a Bearer
    header on every upstream call and never sent to the browser.
  - TTS returns a JSON envelope when upstream replies JSON (timestamps=true),
    otherwise the binary audio is streamed through unchanged.
  - Video content is streamed through as binary.
  - Upstream errors are relayed with their original status and body.
  - Static files in public/ are served, with "/" -> index.html.

Run:
    # PowerShell
    $env:BOSON_API_KEY = "bai-xxxx"
    python -m uvicorn server_fastapi:app --port 3000
Then open http://localhost:3000
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles

BASE_DIR = Path(__file__).parent
PUBLIC_DIR = BASE_DIR / "public"
PORT = int(os.environ.get("PORT", "3000"))
API_BASE = os.environ.get("BOSON_API_BASE", "https://api.boson.ai/v1")


def _load_dotenv() -> None:
    """Minimal .env loader (KEY=VALUE per line), mirroring server.py."""
    env_path = BASE_DIR / ".env"
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            os.environ.setdefault(key.strip(), val.strip())


_load_dotenv()
API_KEY = os.environ.get("BOSON_API_KEY")


def _auth_headers(extra: dict | None = None) -> dict:
    headers = {"Authorization": f"Bearer {API_KEY}"}
    if extra:
        headers.update(extra)
    return headers


def _boson_request(method: str, path: str, *, json_body=None):
    """Call the Boson API. Returns (status, content_type, body_bytes).

    Mirrors server.py.boson_request, including its error handling.
    """
    url = f"{API_BASE}{path}"
    data = None
    headers = _auth_headers()
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


def _config_error() -> JSONResponse:
    return JSONResponse(
        status_code=500,
        content={"error": {
            "message": "BOSON_API_KEY is not set. Copy .env.example to .env and add your key, then restart.",
            "type": "config_error",
        }},
    )


def _relay(status: int, content_type: str, body: bytes) -> Response:
    """Relay an upstream response, preserving status, content type, and bytes.

    If the body is JSON, return it as JSON; otherwise pass the raw bytes
    through with the upstream content type (audio, video, etc.).
    """
    ctype = content_type or "application/json"
    if "application/json" in ctype:
        # Re-emit as JSON so clients always get application/json for JSON bodies.
        try:
            return JSONResponse(status_code=status, content=json.loads(body or b"{}"))
        except json.JSONDecodeError:
            return Response(content=body, status_code=status, media_type=ctype)
    return Response(content=body, status_code=status, media_type=ctype)


app = FastAPI(title="LearnLoop backend (Boson proxy)")


# ---------------------------------------------------------------------------
# Health / config check
# ---------------------------------------------------------------------------
@app.get("/api/health")
async def health():
    return {"ok": True, "keyConfigured": bool(API_KEY), "apiBase": API_BASE}


# ---------------------------------------------------------------------------
# Higgs TTS 3 - POST /v1/audio/speech
# ---------------------------------------------------------------------------
@app.post("/api/tts/speech")
async def tts_speech(request: Request):
    if not API_KEY:
        return _config_error()
    body = await _json_body(request)
    if body is _INVALID:
        return _bad_json()
    return _relay(*_boson_request("POST", "/audio/speech", json_body=body))


# ---------------------------------------------------------------------------
# Custom voices - CRUD under /v1/audio/voices
# ---------------------------------------------------------------------------
@app.post("/api/voices")
async def voices_create(request: Request):
    if not API_KEY:
        return _config_error()
    body = await _json_body(request)
    if body is _INVALID:
        return _bad_json()
    return _relay(*_boson_request("POST", "/audio/voices", json_body=body))


@app.get("/api/voices")
async def voices_list():
    if not API_KEY:
        return _config_error()
    return _relay(*_boson_request("GET", "/audio/voices"))


@app.get("/api/voices/{voice_id}")
async def voices_get(voice_id: str):
    if not API_KEY:
        return _config_error()
    return _relay(*_boson_request("GET", f"/audio/voices/{voice_id}"))


@app.delete("/api/voices/{voice_id}")
async def voices_delete(voice_id: str):
    if not API_KEY:
        return _config_error()
    return _relay(*_boson_request("DELETE", f"/audio/voices/{voice_id}"))


# ---------------------------------------------------------------------------
# Higgs Avatar - async video jobs under /v1/videos
# ---------------------------------------------------------------------------
@app.post("/api/videos")
async def videos_create(request: Request):
    if not API_KEY:
        return _config_error()
    body = await _json_body(request)
    if body is _INVALID:
        return _bad_json()
    return _relay(*_boson_request("POST", "/videos", json_body=body))


@app.get("/api/videos/{video_id}/content")
async def videos_content(video_id: str):
    if not API_KEY:
        return _config_error()
    return _relay(*_boson_request("GET", f"/videos/{video_id}/content"))


@app.get("/api/videos/{video_id}")
async def videos_get(video_id: str):
    if not API_KEY:
        return _config_error()
    return _relay(*_boson_request("GET", f"/videos/{video_id}"))


# ---------------------------------------------------------------------------
# Higgs Realtime - mint a short-lived client secret for the browser
# ---------------------------------------------------------------------------
@app.post("/api/realtime/client-secret")
async def realtime_client_secret(request: Request):
    if not API_KEY:
        return _config_error()
    body = await _json_body(request, default={})
    if body is _INVALID:
        return _bad_json()
    return _relay(*_boson_request("POST", "/realtime/client_secrets", json_body=body))


# ---------------------------------------------------------------------------
# Catch-all for unknown /api/* routes -> 404 JSON (matches server.py)
# ---------------------------------------------------------------------------
@app.api_route("/api/{rest:path}", methods=["GET", "POST", "DELETE", "PUT", "PATCH"])
async def unknown_api(rest: str):
    return JSONResponse(status_code=404, content={"error": {"message": "Not found"}})


# ---------------------------------------------------------------------------
# JSON body parsing helpers (mirror server.py's _read_json behavior)
# ---------------------------------------------------------------------------
_INVALID = object()


async def _json_body(request: Request, default=None):
    raw = await request.body()
    if not raw:
        return {} if default is None else default
    try:
        return json.loads(raw.decode("utf-8") or "{}")
    except (json.JSONDecodeError, UnicodeDecodeError):
        return _INVALID


def _bad_json() -> JSONResponse:
    return JSONResponse(status_code=400, content={"error": {"message": "Invalid JSON body"}})


# ---------------------------------------------------------------------------
# Static frontend (mounted last so /api/* takes precedence).
# html=True serves index.html at "/".
# ---------------------------------------------------------------------------
app.mount("/", StaticFiles(directory=str(PUBLIC_DIR), html=True), name="static")


if __name__ == "__main__":
    import uvicorn

    key_status = "configured OK" if API_KEY else "MISSING  (set BOSON_API_KEY or create .env)"
    print(f"\n  LearnLoop backend (FastAPI) at http://localhost:{PORT}")
    print(f"  API base: {API_BASE}")
    print(f"  API key:  {key_status}\n")
    uvicorn.run(app, host="0.0.0.0", port=PORT)

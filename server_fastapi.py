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
import asyncio
import urllib.error
import urllib.request
from pathlib import Path

from fastapi import FastAPI, Request, UploadFile, File, Form, BackgroundTasks, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, Response, FileResponse
from fastapi.staticfiles import StaticFiles

BASE_DIR = Path(__file__).parent
PUBLIC_DIR = BASE_DIR / "public"
PORT = int(os.environ.get("PORT", "3000"))
API_BASE = os.environ.get("BOSON_API_BASE", "https://api.boson.ai/v1")
AVATAR_REFERENCE_PATH = BASE_DIR / "image.png"
MAX_AVATAR_REFERENCE_BYTES = 10 * 1024 * 1024


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


def _boson_request(method: str, path: str, *, json_body=None, include_headers=False):
    """Call Boson; optionally include response headers with the status, type, and body.

    Mirrors server.py.boson_request, including its error handling.
    """
    def result(status, content_type, body, response_headers=None):
        values = (status, content_type, body)
        return (*values, response_headers or {}) if include_headers else values

    url = f"{API_BASE}{path}"
    data = None
    headers = _auth_headers()
    if json_body is not None:
        data = json.dumps(json_body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            return result(resp.status, resp.headers.get("Content-Type", ""), resp.read(), resp.headers)
    except urllib.error.HTTPError as e:
        return result(e.code, e.headers.get("Content-Type", "application/json"), e.read(), e.headers)
    except urllib.error.URLError as e:
        body = json.dumps({"error": {"message": str(e), "type": "proxy_error"}}).encode()
        return result(502, "application/json", body)


def _config_error() -> JSONResponse:
    return JSONResponse(
        status_code=500,
        content={"error": {
            "message": "BOSON_API_KEY is not set. Copy .env.example to .env and add your key, then restart.",
            "type": "config_error",
        }},
    )


def _relay(status: int, content_type: str, body: bytes, extra_headers: dict | None = None) -> Response:
    """Relay an upstream response, preserving status, content type, and bytes.

    If the body is JSON, return it as JSON; otherwise pass the raw bytes
    through with the upstream content type (audio, video, etc.).
    """
    ctype = content_type or "application/json"
    headers = {k: v for k, v in (extra_headers or {}).items() if v is not None}
    if "application/json" in ctype:
        # Re-emit as JSON so clients always get application/json for JSON bodies.
        try:
            return JSONResponse(status_code=status, content=json.loads(body or b"{}"), headers=headers)
        except json.JSONDecodeError:
            return Response(content=body, status_code=status, media_type=ctype, headers=headers)
    return Response(content=body, status_code=status, media_type=ctype, headers=headers)


app = FastAPI(title="LearnLoop backend (Boson proxy)")
LIVE_AVATAR_SESSIONS: dict[str, dict] = {}


@app.middleware("http")
async def no_cache_frontend_modules(request: Request, call_next):
    """Avoid mixing revisions of browser ES modules during local development.

    LearnLoop is served as individual modules rather than a bundled asset. A
    heuristic browser cache can otherwise pair a changed importing module with
    an older imported module, causing an import/export error only in a normal
    Chrome profile. API and media responses keep their existing cache policy.
    """
    response = await call_next(request)
    if request.url.path.endswith((".html", ".js", ".css", ".map")):
        response.headers["Cache-Control"] = "no-store"
    return response


# ---------------------------------------------------------------------------
# Health / config check
# ---------------------------------------------------------------------------
@app.get("/api/health")
async def health():
    return {"ok": True, "keyConfigured": bool(API_KEY), "apiBase": API_BASE}


@app.get("/api/walkthrough/avatar-reference")
async def walkthrough_avatar_reference():
    """Return the fixed, user-supplied Calm Walkthrough image read-only."""
    try:
        if not AVATAR_REFERENCE_PATH.is_file() or AVATAR_REFERENCE_PATH.stat().st_size > MAX_AVATAR_REFERENCE_BYTES:
            return JSONResponse(status_code=500, content={"error": {"message": "Avatar reference image is unavailable or exceeds 10 MB."}})
    except OSError:
        return JSONResponse(status_code=404, content={"error": {"message": "Avatar reference image is unavailable."}})
    return FileResponse(AVATAR_REFERENCE_PATH, media_type="image/png", headers={"Cache-Control": "no-store"})


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
# Higgs Avatar Realtime - lip-synced LiveKit sessions
# ---------------------------------------------------------------------------
async def _livekit_credentials_error(url: str, key: str, secret: str) -> str | None:
    """Check that the configured key can access the configured Cloud project."""
    if secret and set(secret) <= {"•", "*", "●", "·"}:
        return "LIVEKIT_API_SECRET contains a masked placeholder. Copy the actual secret from LiveKit Cloud into .env."
    try:
        from livekit import api
    except ImportError:
        return "LiveKit support is not installed. Install requirements-dev.txt."
    client = None
    try:
        client = api.LiveKitAPI(url, key, secret)
        await asyncio.wait_for(client.room.list_rooms(api.ListRoomsRequest()), timeout=8)
        return None
    except Exception as exc:
        if getattr(exc, "status", None) == 401:
            return "LiveKit rejected this project's API key or secret (401). Copy the URL, key, and secret from the same LiveKit Cloud project."
        return "Could not verify the LiveKit Cloud connection. Check the project URL and internet connection."
    finally:
        if client is not None:
            await client.aclose()


@app.get("/api/live-avatar/config")
async def live_avatar_config():
    required = ("LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET")
    livekit_configured = all(os.environ.get(name) for name in required)
    livekit_error = None
    if livekit_configured:
        livekit_error = await _livekit_credentials_error(
            *(os.environ[name].strip() for name in required)
        )
    return {
        "configured": bool(API_KEY and livekit_configured and not livekit_error),
        "boson_configured": bool(API_KEY),
        "livekit_configured": livekit_configured,
        "livekit_error": livekit_error,
        "video_price_usd_per_minute": 0.07,
    }


@app.get("/api/avatars")
async def avatars_list():
    if not API_KEY:
        return _config_error()
    return _relay(*_boson_request("GET", "/avatars"))


async def _create_boson_avatar_session(payload: dict, avatar_id: str):
    """Retry only explicit, session-free failures from Boson.

    Preset IDs are documented as available to every key. Boson can briefly
    report one as missing despite listing it, so give that 404 one short retry.
    Never retry an ambiguous timeout or proxy error that may have created a
    session whose ID we did not receive.
    """
    presets = {"builtin_claire_v1", "builtin_emma_v1", "builtin_james_v1"}
    for attempt in range(3):
        result = await asyncio.to_thread(
            _boson_request, "POST", "/avatar/sessions",
            json_body=payload, include_headers=True,
        )
        status, _, raw, headers = result
        if attempt == 2:
            return result
        try:
            error = json.loads(raw.decode("utf-8")).get("error", {})
        except (UnicodeDecodeError, json.JSONDecodeError, AttributeError):
            error = {}
        code = error.get("code") if isinstance(error, dict) else None
        if status == 404 and code == "avatar_not_found" and avatar_id in presets and attempt == 0:
            await asyncio.sleep(0.5)
            continue
        if status == 503 and code == "service_unavailable":
            try:
                retry_delay = float(headers.get("Retry-After", 1))
            except (TypeError, ValueError):
                retry_delay = 1.0
            await asyncio.sleep(min(max(retry_delay, 2 ** attempt), 10))
            continue
        return result
    return result


@app.post("/api/live-avatar/sessions")
async def live_avatar_session_create(request: Request):
    if not API_KEY:
        return _config_error()
    livekit_url = os.environ.get("LIVEKIT_URL", "").strip()
    livekit_key = os.environ.get("LIVEKIT_API_KEY", "").strip()
    livekit_secret = os.environ.get("LIVEKIT_API_SECRET", "").strip()
    if not all((livekit_url, livekit_key, livekit_secret)):
        return JSONResponse(status_code=503, content={"error": {
            "message": "Add LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET to .env from a LiveKit Cloud project, then restart LearnLoop.",
            "type": "livekit_not_configured",
        }})
    livekit_error = await _livekit_credentials_error(livekit_url, livekit_key, livekit_secret)
    if livekit_error:
        return JSONResponse(status_code=401 if "(401)" in livekit_error else 503, content={"error": {
            "message": livekit_error, "type": "livekit_auth_error" if "(401)" in livekit_error else "livekit_connection_error",
        }})
    body = await _json_body(request, default={})
    if body is _INVALID:
        return _bad_json()
    avatar_id = str(body.get("avatar_id") or "builtin_emma_v1").strip()
    if not avatar_id or len(avatar_id) > 256:
        return JSONResponse(status_code=400, content={"error": {"message": "Choose a valid Boson avatar ID."}})

    try:
        from datetime import timedelta
        from uuid import uuid4
        from livekit import api, rtc
        from livekit.agents.voice.avatar import DataStreamAudioOutput
    except ImportError as exc:
        return JSONResponse(status_code=503, content={"error": {
            "message": "Live avatar support is not installed. Install the LiveKit dependencies listed in requirements-dev.txt and restart.",
            "type": "livekit_dependency_missing",
        }})

    room_name = f"learnloop-{uuid4().hex[:18]}"
    agent_identity = f"agent-{uuid4().hex[:8]}"
    avatar_identity = "boson-avatar"
    viewer_identity = f"viewer-{uuid4().hex[:8]}"
    max_duration = 900

    def token_for(identity: str, *, publish: bool, subscribe: bool) -> str:
        token = (api.AccessToken(livekit_key, livekit_secret)
            .with_identity(identity)
            .with_grants(api.VideoGrants(
                room_join=True, room=room_name, can_publish=publish,
                can_subscribe=subscribe, can_publish_data=publish,
            ))
            .with_ttl(timedelta(seconds=max_duration + 300)))
        return token.to_jwt()

    avatar_token = token_for(avatar_identity, publish=True, subscribe=False)
    agent_token = token_for(agent_identity, publish=True, subscribe=False)
    viewer_token = token_for(viewer_identity, publish=False, subscribe=True)
    avatar_payload = {
        "model": "higgs-avatar",
        "avatar_id": avatar_id,
        "transport": {
            "type": "livekit", "url": livekit_url, "room_name": room_name,
            "participant_token": avatar_token, "participant_identity": avatar_identity,
            "publisher_identity": agent_identity, "audio_source": "data_stream",
        },
        "max_duration_seconds": max_duration,
    }

    status, content_type, raw, upstream_headers = await _create_boson_avatar_session(
        avatar_payload, avatar_id,
    )
    if status not in (200, 201):
        return _relay(status, content_type, raw, {
            "Retry-After": upstream_headers.get("Retry-After"),
            "X-Boson-Request-ID": upstream_headers.get("X-Request-ID"),
        })
    try:
        boson_session = json.loads(raw.decode("utf-8"))
        session_id = boson_session["id"]
        room = rtc.Room()
        await room.connect(livekit_url, agent_token)
        audio_output = DataStreamAudioOutput(
            room, destination_identity=avatar_identity, sample_rate=24000,
            wait_remote_track=rtc.TrackKind.KIND_AUDIO,
        )
    except Exception as exc:
        if "session_id" in locals():
            await asyncio.to_thread(_boson_request, "DELETE", f"/avatar/sessions/{session_id}")
        try:
            if "room" in locals(): await room.disconnect()
        except Exception:
            pass
        return JSONResponse(status_code=502, content={"error": {
            "message": f"Boson started the avatar, but LearnLoop could not join its LiveKit room: {str(exc)[:240]}",
            "type": "livekit_connect_error",
        }})

    relay_token = __import__("secrets").token_urlsafe(24)
    LIVE_AVATAR_SESSIONS[session_id] = {
        "room": room, "audio_output": audio_output, "relay_token": relay_token,
        "avatar_identity": avatar_identity, "room_name": room_name,
    }
    return {
        "session_id": session_id, "avatar_id": avatar_id, "avatar_identity": avatar_identity,
        "livekit_url": livekit_url, "viewer_token": viewer_token, "relay_token": relay_token,
        "max_duration_seconds": max_duration,
    }


@app.websocket("/api/live-avatar/sessions/{session_id}/audio")
async def live_avatar_audio_relay(websocket: WebSocket, session_id: str):
    session = LIVE_AVATAR_SESSIONS.get(session_id)
    if not session:
        await websocket.close(code=4404)
        return
    await websocket.accept()
    playback_handler = None
    try:
        auth = await asyncio.wait_for(websocket.receive_json(), timeout=8)
        if auth.get("type") != "auth" or auth.get("token") != session["relay_token"]:
            await websocket.close(code=4401)
            return
        await websocket.send_json({"type": "ready"})
        from livekit import rtc
        import base64

        async def send_playback_finished(interrupted: bool):
            try:
                await websocket.send_json({"type": "playback_finished", "interrupted": interrupted})
            except Exception:
                pass

        def playback_handler(event):
            asyncio.create_task(send_playback_finished(event.interrupted))

        session["audio_output"].on("playback_finished", playback_handler)
        while True:
            message = await websocket.receive_json()
            kind = message.get("type")
            if kind == "audio":
                try:
                    pcm = base64.b64decode(message.get("delta", ""), validate=True)
                except Exception:
                    await websocket.send_json({"type": "error", "message": "Invalid audio frame."})
                    continue
                if not pcm or len(pcm) % 2:
                    continue
                frame = rtc.AudioFrame(pcm, 24000, 1, len(pcm) // 2)
                await session["audio_output"].capture_frame(frame)
            elif kind == "flush":
                session["audio_output"].flush()
            elif kind == "clear":
                session["audio_output"].clear_buffer()
    except WebSocketDisconnect:
        return
    except asyncio.TimeoutError:
        await websocket.close(code=4408)
    finally:
        if playback_handler is not None:
            session["audio_output"].off("playback_finished", playback_handler)


@app.delete("/api/live-avatar/sessions/{session_id}")
async def live_avatar_session_release(session_id: str):
    session = LIVE_AVATAR_SESSIONS.pop(session_id, None)
    if session:
        try: session["audio_output"].clear_buffer()
        except Exception: pass
        try: await session["room"].disconnect()
        except Exception: pass
    if not API_KEY:
        return _config_error()
    return _relay(*await asyncio.to_thread(_boson_request, "DELETE", f"/avatar/sessions/{session_id}"))

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
# ---------------------------------------------------------------------------
# LearnLoop lectures: transcript retrieval + search (G2.3).
# Read-only over persisted data; does NOT touch /api/videos (Avatar) semantics.
# ---------------------------------------------------------------------------
ALLOWED_UPLOAD_EXT = {".mp4", ".webm"}
MAX_UPLOAD_BYTES = int(os.environ.get("LEARNLOOP_MAX_UPLOAD_BYTES", str(500 * 1024 * 1024)))


def _run_progressive(video_id: str, path: str):
    """Background entry: progressive processing of an uploaded lecture."""
    from app.storage import Storage
    storage = Storage()
    try:
        # Keep this import inside the guarded block. A missing local
        # transcription dependency used to leave the row in "queued" forever
        # before the pipeline had a chance to record a failure.
        from app.pipeline import process_video_progressive
        process_video_progressive(video_id, path, storage=storage)
    except Exception as exc:
        # The pipeline normally records its own error. This covers failures
        # that happen before it can start, such as a missing local dependency.
        storage.set_progress(video_id, stage="failed", status="failed", error=str(exc))


@app.post("/api/lectures")
async def lecture_upload(background: BackgroundTasks,
                         file: UploadFile = File(...),
                         content_hash: str = Form(default=""),
                         client_key: str = Form(default="")):
    """Upload a local lecture video and start progressive processing.

    Multipart: `file` (the video). Optional `content_hash` (client-computed) and
    `client_key` (filename+size+mtime) for dedup. Stores under data/uploads/<id>,
    creates ONE lecture row, kicks off background extraction+chunked transcription,
    and returns {id, status, dedup}. Lecture audio stays local.
    """
    from app.config import DATA_DIR
    from app.storage import Storage
    import hashlib

    name = file.filename or "lecture"
    ext = ("." + name.rsplit(".", 1)[-1].lower()) if "." in name else ""
    if ext not in ALLOWED_UPLOAD_EXT:
        return JSONResponse(status_code=400, content={"error": {
            "message": f"Unsupported type {ext or '(none)'}; use MP4 or WebM."}})

    storage = Storage()

    # Read the upload (bounded) and compute a server-side content hash for
    # content-level dedup (the client hint is only an optimization).
    uploads = Path(DATA_DIR) / "uploads"
    uploads.mkdir(parents=True, exist_ok=True)
    hasher = hashlib.sha256()
    size = 0
    tmp = uploads / f"_incoming_{os.getpid()}_{id(file)}{ext}"
    try:
        with open(tmp, "wb") as fh:
            while True:
                buf = await file.read(1024 * 1024)
                if not buf:
                    break
                size += len(buf)
                if size > MAX_UPLOAD_BYTES:
                    fh.close()
                    tmp.unlink(missing_ok=True)
                    return JSONResponse(status_code=413, content={"error": {
                        "message": f"File exceeds {MAX_UPLOAD_BYTES} bytes."}})
                hasher.update(buf)
                fh.write(buf)
        digest = hasher.hexdigest()

        # Content-level dedup: if a ready lecture with this hash exists, reuse it.
        existing = storage.get_video_by_hash(digest)
        if existing is not None and existing.status == "ready":
            tmp.unlink(missing_ok=True)
            return {"id": existing.id, "status": existing.status, "dedup": True}
        # If one is in-flight with this hash, reuse it too (prevents duplicate jobs).
        if existing is not None and existing.status in ("processing", "queued"):
            tmp.unlink(missing_ok=True)
            return {"id": existing.id, "status": existing.status, "dedup": True}

        video = storage.create_video(title=name, status="queued", stage="queued",
                                     content_hash=digest)
        final = uploads / f"{video.id}{ext}"
        tmp.rename(final)
    finally:
        if tmp.exists():
            tmp.unlink(missing_ok=True)

    background.add_task(_run_progressive, video.id, str(final))
    return {"id": video.id, "status": "queued", "dedup": False}


@app.get("/api/lectures/{video_id}/status")
async def lecture_status(video_id: str):
    from app.storage import Storage
    s = Storage()
    v = s.get_video(video_id)
    if v is None:
        return JSONResponse(status_code=404, content={"error": {"message": "No such lecture"}})
    return {"id": v.id, "stage": v.stage, "status": v.status,
            "progress": v.progress, "segment_count": len(s.get_segments(video_id)),
            "duration_seconds": v.duration_seconds, "error": v.error}


@app.get("/api/lectures")
async def lectures_list(limit: int = 20):
    """Bounded list of recent lectures for the re-attach UI (D-refresh)."""
    from app.storage import Storage
    s = Storage()
    out = []
    for v in s.list_videos(limit=limit):
        out.append({"id": v.id, "title": v.title, "status": v.status, "stage": v.stage,
                    "progress": v.progress, "duration_seconds": v.duration_seconds,
                    "error": v.error})
    return {"count": len(out), "lectures": out}


def _find_upload_file(video_id: str):
    """Locate the stored upload for a lecture id (mp4/webm), if retained."""
    from app.config import DATA_DIR
    uploads = Path(DATA_DIR) / "uploads"
    for ext in (".mp4", ".webm"):
        p = uploads / f"{video_id}{ext}"
        if p.exists():
            return p
    return None


@app.get("/api/lectures/{video_id}/media")
async def lecture_media(video_id: str):
    """Stream the stored video so the player can reopen it after a refresh.

    Honest recovery: only works if the uploaded media was retained server-side.
    Returns 404 if the file is absent (e.g. a path-based /process lecture).
    """
    from app.storage import Storage
    if Storage().get_video(video_id) is None:
        return JSONResponse(status_code=404, content={"error": {"message": "No such lecture"}})
    path = _find_upload_file(video_id)
    if path is None:
        return JSONResponse(status_code=404, content={"error": {
            "message": "Stored media not available for this lecture."}})
    media_type = "video/webm" if path.suffix == ".webm" else "video/mp4"
    # FileResponse supports HTTP Range requests (206 Partial Content), which the
    # <video> element REQUIRES to seek. A plain full-body Response makes the
    # video non-seekable, so currentTime changes are silently dropped.
    return FileResponse(str(path), media_type=media_type, filename=path.name)


@app.post("/api/lectures/process")
async def lecture_process(request: Request):
    """Process a local lecture video that already exists on the server machine.

    Body: {"path": "<absolute or repo-relative path to a local video>",
           "title": "optional"}. Runs extract->transcribe->persist synchronously
    (Phase 2 is single-process) and returns the created lecture id + status.
    Lecture audio stays local; no external STT.
    """
    body = await _json_body(request)
    if body is _INVALID or not isinstance(body, dict):
        return _bad_json()
    path = (body.get("path") or "").strip()
    if not path:
        return JSONResponse(status_code=400, content={"error": {"message": "path is required"}})
    from pathlib import Path as _P
    vp = _P(path)
    if not vp.is_absolute():
        vp = (BASE_DIR.parent / path)  # allow repo-root-relative
    if not vp.exists():
        return JSONResponse(status_code=404, content={"error": {"message": f"video not found: {path}"}})
    try:
        from app.pipeline import process_video, PipelineError
        vid = process_video(vp, title=body.get("title"))
    except Exception as e:  # PipelineError and anything unexpected -> honest failure
        return JSONResponse(status_code=500, content={"error": {"message": str(e), "type": "processing_error"}})
    from app.storage import Storage
    v = Storage().get_video(vid)
    return {"id": vid, "status": v.status if v else "unknown",
            "duration_seconds": v.duration_seconds if v else None}


@app.get("/api/lectures/{video_id}")
async def lecture_get(video_id: str):
    from app.storage import Storage
    v = Storage().get_video(video_id)
    if v is None:
        return JSONResponse(status_code=404, content={"error": {"message": "No such lecture"}})
    return {"id": v.id, "title": v.title, "duration_seconds": v.duration_seconds,
            "status": v.status, "error": v.error}


@app.get("/api/lectures/{video_id}/transcript")
async def lecture_transcript(video_id: str):
    from app.storage import Storage
    s = Storage()
    if s.get_video(video_id) is None:
        return JSONResponse(status_code=404, content={"error": {"message": "No such lecture"}})
    segs = s.get_segments(video_id)
    return {"video_id": video_id, "count": len(segs),
            "segments": [{"id": x.id, "seq": x.seq, "start": x.start_time, "end": x.end_time, "text": x.text}
                         for x in segs]}


@app.post("/api/lectures/{video_id}/bookmarks")
async def bookmark_create(video_id: str, request: Request):
    """G5 'Remember': save a concept bookmark (timestamp + title + optional
    excerpt/note), associated with the lecture. Confirmed only after the DB write."""
    from app.storage import Storage, StorageError
    body = await _json_body(request)
    if body is _INVALID or not isinstance(body, dict):
        return _bad_json()
    try:
        ts = float(body.get("timestamp_seconds"))
    except (TypeError, ValueError):
        return JSONResponse(status_code=400, content={"error": {"message": "timestamp_seconds (number) required"}})
    title = (body.get("title") or "").strip()
    if not title:
        return JSONResponse(status_code=400, content={"error": {"message": "title required"}})
    try:
        store = Storage()
        bm = store.create_bookmark(
            video_id, ts, title,
            transcript_excerpt=body.get("transcript_excerpt"),
            note=body.get("note"),
        )
    except StorageError as e:
        return JSONResponse(status_code=400, content={"error": {"message": str(e)}})
    # Canonical store is SQLite; also export a per-lecture JSON snapshot (safe
    # atomic write) so saved concepts are inspectable/portable per lecture.
    export_ok = _export_bookmarks_json(video_id, store)
    return {"id": bm.id, "video_id": bm.video_id, "timestamp_seconds": bm.timestamp_seconds,
            "title": bm.title, "transcript_excerpt": bm.transcript_excerpt,
            "note": bm.note, "created_at": bm.created_at, "exported": export_ok}


def _export_bookmarks_json(video_id: str, store) -> bool:
    """Write data/lectures/<id>/bookmarks.json atomically from the SQLite source
    of truth. Returns True only if the file was actually written+verified."""
    import json as _json, os as _os, tempfile as _tempfile
    from app.config import DATA_DIR
    try:
        items = store.list_bookmarks(video_id)
        outdir = Path(DATA_DIR) / "lectures" / video_id
        outdir.mkdir(parents=True, exist_ok=True)
        payload = {"lecture_id": video_id, "count": len(items),
                   "bookmarks": [{"id": b.id, "lecture_id": b.video_id,
                                  "timestamp_seconds": b.timestamp_seconds, "title": b.title,
                                  "transcript_excerpt": b.transcript_excerpt, "note": b.note,
                                  "created_at": b.created_at} for b in items]}
        target = outdir / "bookmarks.json"
        fd, tmp = _tempfile.mkstemp(dir=str(outdir), suffix=".tmp")
        with _os.fdopen(fd, "w", encoding="utf-8") as fh:
            _json.dump(payload, fh, indent=2)
        _os.replace(tmp, target)                      # atomic swap; never corrupts prior file
        return target.exists()
    except Exception:
        return False   # export is best-effort; SQLite remains the source of truth


@app.get("/api/lectures/{video_id}/bookmarks")
async def bookmark_list(video_id: str):
    from app.storage import Storage
    s = Storage()
    if s.get_video(video_id) is None:
        return JSONResponse(status_code=404, content={"error": {"message": "No such lecture"}})
    items = s.list_bookmarks(video_id)
    return {"video_id": video_id, "count": len(items),
            "bookmarks": [{"id": b.id, "timestamp_seconds": b.timestamp_seconds, "title": b.title,
                           "transcript_excerpt": b.transcript_excerpt, "note": b.note,
                           "created_at": b.created_at} for b in items]}


@app.patch("/api/lectures/{video_id}/bookmarks/{bookmark_id}")
async def bookmark_update(video_id: str, bookmark_id: str, request: Request):
    """Update a bookmark's title and/or note (same id/lecture/timestamp)."""
    from app.storage import Storage, StorageError
    body = await _json_body(request)
    if body is _INVALID or not isinstance(body, dict):
        return _bad_json()
    store = Storage()
    try:
        bm = store.update_bookmark(video_id, bookmark_id,
                                   title=body.get("title"), note=body.get("note"))
    except StorageError as e:
        msg = str(e)
        code = 404 if "No such bookmark" in msg else 400
        return JSONResponse(status_code=code, content={"error": {"message": msg}})
    export_ok = _export_bookmarks_json(video_id, store)
    return {"id": bm.id, "video_id": bm.video_id, "timestamp_seconds": bm.timestamp_seconds,
            "title": bm.title, "transcript_excerpt": bm.transcript_excerpt, "note": bm.note,
            "created_at": bm.created_at, "exported": export_ok}


@app.delete("/api/lectures/{video_id}/bookmarks/{bookmark_id}")
async def bookmark_delete(video_id: str, bookmark_id: str):
    from app.storage import Storage
    store = Storage()
    if store.get_video(video_id) is None:
        return JSONResponse(status_code=404, content={"error": {"message": "No such lecture"}})
    deleted = store.delete_bookmark(video_id, bookmark_id)
    if not deleted:
        return JSONResponse(status_code=404, content={"error": {"message": "No such bookmark"}})
    export_ok = _export_bookmarks_json(video_id, store)   # keep export consistent with SQLite
    return {"deleted": True, "id": bookmark_id, "exported": export_ok}


@app.get("/api/lectures/{video_id}/context")
async def lecture_context(video_id: str, t: float = 0.0, q: str = ""):
    """G4: assemble bounded, lecture-scoped grounding context for Looper.

    `t` = current playback position (seconds); `q` = optional student question
    (for historical keyword retrieval). Returns a ready-to-inject text message
    plus the structured segments (with real timestamps) it was built from.
    """
    from app.context_builder import build_context, render_context_message
    from app.storage import Storage
    ctx = build_context(video_id, position=t, question=(q or None), storage=Storage())
    if ctx.note == "no_such_lecture":
        return JSONResponse(status_code=404, content={"error": {"message": "No such lecture"}})
    return {
        "video_id": ctx.video_id,
        "title": ctx.title,
        "position": ctx.position,
        "has_transcript": ctx.has_transcript,
        "message": render_context_message(ctx, question=(q or None)),
        "segments": [{"seq": c.seq, "start": c.start, "end": c.end, "kind": c.kind, "text": c.text}
                     for c in ctx.segments],
    }


@app.get("/api/lectures/{video_id}/search")
async def lecture_search(video_id: str, q: str = ""):
    from app.storage import Storage
    s = Storage()
    v = s.get_video(video_id)
    if v is None:
        return JSONResponse(status_code=404, content={"error": {"message": "No such lecture"}})
    results = s.search_segments(video_id, q)
    # Clamp seek targets to the known duration so the client never seeks out of range.
    dur = v.duration_seconds
    out = []
    for x in results:
        seek = x.start_time
        if dur is not None and dur > 0:
            seek = max(0.0, min(seek, dur))
        out.append({"seq": x.seq, "start": x.start_time, "end": x.end_time,
                    "text": x.text, "seek": seek})
    return {"video_id": video_id, "query": q, "count": len(out), "results": out}


@app.post("/api/study-pack/export")
async def study_pack_export(request: Request):
    """Create an on-demand ZIP from the user's generated study pack and sources.

    Nothing is exported until the user explicitly requests the download. The
    archive contains the rendered guide, structured JSON, source transcript,
    and saved-moment notes supplied by the browser.
    """
    import io
    import re
    import zipfile

    raw = await request.body()
    if len(raw) > 8 * 1024 * 1024:
        return JSONResponse(status_code=413, content={"error": {"message": "Study pack export exceeds 8 MB."}})
    try:
        body = json.loads(raw.decode("utf-8") or "{}")
    except (json.JSONDecodeError, UnicodeDecodeError):
        return _bad_json()
    if not isinstance(body, dict) or not isinstance(body.get("pack"), dict):
        return JSONResponse(status_code=400, content={"error": {"message": "A generated study pack is required."}})

    title = str(body.get("title") or "LearnLoop study pack").strip()[:160]
    safe_name = re.sub(r"[^A-Za-z0-9._-]+", "-", title).strip("-._")[:72] or "learnloop-study-pack"
    transcript = body.get("transcript") if isinstance(body.get("transcript"), list) else []
    bookmarks = body.get("saved_moments") if isinstance(body.get("saved_moments"), list) else []
    guide = body.get("guide") if isinstance(body.get("guide"), str) else ""

    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        bundle.writestr("Study Guide.md", guide or f"# {title}\n\nNo rendered guide was supplied.")
        bundle.writestr("study-pack.json", json.dumps(body["pack"], ensure_ascii=False, indent=2))
        bundle.writestr("source-transcript.json", json.dumps(transcript, ensure_ascii=False, indent=2))
        bundle.writestr("saved-moments.json", json.dumps(bookmarks, ensure_ascii=False, indent=2))
    return Response(
        content=archive.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{safe_name}-study-pack.zip"'},
    )

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
app.mount("/vendor/mermaid", StaticFiles(directory=str(BASE_DIR / "node_modules" / "mermaid" / "dist")), name="mermaid")
app.mount("/", StaticFiles(directory=str(PUBLIC_DIR), html=True), name="static")


if __name__ == "__main__":
    import uvicorn

    key_status = "configured OK" if API_KEY else "MISSING  (set BOSON_API_KEY or create .env)"
    print(f"\n  LearnLoop backend (FastAPI) at http://localhost:{PORT}")
    print(f"  API base: {API_BASE}")
    print(f"  API key:  {key_status}\n")
    uvicorn.run(app, host="0.0.0.0", port=PORT)

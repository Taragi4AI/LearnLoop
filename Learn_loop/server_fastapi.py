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

from fastapi import FastAPI, Request, UploadFile, File, Form, BackgroundTasks
from fastapi.responses import JSONResponse, Response, FileResponse
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
# ---------------------------------------------------------------------------
# LearnLoop lectures: transcript retrieval + search (G2.3).
# Read-only over persisted data; does NOT touch /api/videos (Avatar) semantics.
# ---------------------------------------------------------------------------
ALLOWED_UPLOAD_EXT = {".mp4", ".webm"}
MAX_UPLOAD_BYTES = int(os.environ.get("LEARNLOOP_MAX_UPLOAD_BYTES", str(500 * 1024 * 1024)))


def _run_progressive(video_id: str, path: str):
    """Background entry: progressive processing of an uploaded lecture."""
    from app.pipeline import process_video_progressive
    from app.storage import Storage
    try:
        process_video_progressive(video_id, path, storage=Storage())
    except Exception:
        pass  # status/error already recorded on the row by the pipeline


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
            "segments": [{"seq": x.seq, "start": x.start_time, "end": x.end_time, "text": x.text}
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

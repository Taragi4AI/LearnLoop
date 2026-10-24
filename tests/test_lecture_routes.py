"""G2.3 route tests: transcript retrieval + search + seek over persisted data.

Seeds a temp SQLite DB, launches the FastAPI app pointed at that DB via
LEARNLOOP_DB_PATH, and exercises the read/search endpoints over real HTTP.
No model download; no Boson calls (the app still mocks upstream via env, but
these endpoints are DB-only).
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path

import pytest

from tests import http_client as hc

ROOT = Path(__file__).resolve().parent.parent


@dataclass
class Seg:
    start: float
    end: float
    text: str


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def _wait(url, timeout=20):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1) as r:
                r.read()
                return
        except Exception:
            time.sleep(0.2)
    raise RuntimeError(f"server not up: {url}")


@pytest.fixture(scope="module")
def seeded_app(tmp_path_factory):
    db = tmp_path_factory.mktemp("db") / "lectures.db"
    env_db = str(db)

    # Seed via the storage layer with an EXPLICIT db path (no module reload —
    # reloading would swap StorageError identity and break other tests' isolation).
    # The launched server process reads LEARNLOOP_DB_PATH fresh at its own import.
    from app.storage import Storage

    s = Storage(db_path=db)
    v = s.create_video("Gradient Descent", duration_seconds=30.0, status="ready")
    s.replace_segments(v.id, [
        Seg(0.0, 6.62, "The cool thing is that gradient descent can optimize all these things"),
        Seg(7.72, 11.48, "So if we learn how to optimize this line using gradient descent"),
        Seg(12.0, 20.0, "then we will have learned the strategy that optimizes this squiggle"),
    ])

    port = _free_port()
    env = dict(os.environ)
    env["BOSON_API_KEY"] = "bai-test"
    env["BOSON_API_BASE"] = "http://127.0.0.1:1/v1"  # unused by these routes
    env["PORT"] = str(port)
    env["LEARNLOOP_DB_PATH"] = env_db
    env["LEARNLOOP_DATA_DIR"] = str(db.parent)  # keep uploads/ in temp, not project data/

    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "server_fastapi:app",
         "--host", "127.0.0.1", "--port", str(port), "--log-level", "warning"],
        cwd=str(ROOT), env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    base = f"http://127.0.0.1:{port}"
    try:
        _wait(base + "/api/health")
    except Exception:
        proc.terminate()
        out = proc.stdout.read().decode(errors="replace") if proc.stdout else ""
        raise RuntimeError(f"app failed to start:\n{out}")

    yield {"base": base, "video_id": v.id, "db_path": env_db, "data_dir": str(db.parent)}

    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()


def test_lecture_get(seeded_app):
    vid = seeded_app["video_id"]
    status, _, body = hc.get(seeded_app["base"] + f"/api/lectures/{vid}")
    assert status == 200
    data = hc.as_json(body)
    assert data["status"] == "ready"
    assert data["duration_seconds"] == 30.0


def test_lecture_get_404(seeded_app):
    status, _, body = hc.get(seeded_app["base"] + "/api/lectures/nope123")
    assert status == 404


def test_transcript_retrieval(seeded_app):
    vid = seeded_app["video_id"]
    status, _, body = hc.get(seeded_app["base"] + f"/api/lectures/{vid}/transcript")
    assert status == 200
    data = hc.as_json(body)
    assert data["count"] == 3
    assert data["segments"][0]["start"] == 0.0
    assert "gradient descent" in data["segments"][0]["text"].lower()


def test_search_returns_timestamped_results_with_seek(seeded_app):
    vid = seeded_app["video_id"]
    status, _, body = hc.get(seeded_app["base"] + f"/api/lectures/{vid}/search?q=optimize")
    assert status == 200
    data = hc.as_json(body)
    assert data["count"] >= 1
    first = data["results"][0]
    # seek is within [0, duration] and matches the segment start.
    assert 0.0 <= first["seek"] <= 30.0
    assert first["seek"] == first["start"]


def test_search_no_match(seeded_app):
    vid = seeded_app["video_id"]
    status, _, body = hc.get(seeded_app["base"] + f"/api/lectures/{vid}/search?q=zzznotfound")
    assert status == 200
    assert hc.as_json(body)["count"] == 0


def test_search_results_ascending_timestamp_order(seeded_app):
    """Occurrence navigation relies on results being in ascending video time."""
    vid = seeded_app["video_id"]
    # 'gradient' appears in the first two seeded segments (start 0.0 and 7.72).
    status, _, body = hc.get(seeded_app["base"] + f"/api/lectures/{vid}/search?q=gradient")
    assert status == 200
    results = hc.as_json(body)["results"]
    assert len(results) >= 2
    starts = [r["start"] for r in results]
    assert starts == sorted(starts), f"results not ascending: {starts}"
    # seek target equals the segment start (what Next navigates to).
    for r in results:
        assert r["seek"] == r["start"]


def test_process_requires_path(seeded_app):
    status, _, body = hc.post(seeded_app["base"] + "/api/lectures/process", json_body={})
    assert status == 400
    assert "error" in hc.as_json(body)


def test_process_missing_file_is_404(seeded_app):
    status, _, body = hc.post(seeded_app["base"] + "/api/lectures/process",
                              json_body={"path": "no/such/file.mp4"})
    assert status == 404
    assert "error" in hc.as_json(body)


# --- Upload route (G-UX) ---
def _multipart(fields: dict, file_field: str, filename: str, file_bytes: bytes):
    """Build a minimal multipart/form-data body with stdlib only."""
    boundary = "----learnloopTESTboundary12345"
    crlf = "\r\n"
    parts = []
    for k, v in fields.items():
        parts.append(f"--{boundary}{crlf}"
                     f'Content-Disposition: form-data; name="{k}"{crlf}{crlf}{v}{crlf}')
    head = (f"--{boundary}{crlf}"
            f'Content-Disposition: form-data; name="{file_field}"; filename="{filename}"{crlf}'
            f"Content-Type: application/octet-stream{crlf}{crlf}")
    body = "".join(parts).encode() + head.encode() + file_bytes + f"{crlf}--{boundary}--{crlf}".encode()
    return body, f"multipart/form-data; boundary={boundary}"


def test_upload_rejects_bad_extension(seeded_app):
    body, ctype = _multipart({}, "file", "notes.txt", b"hello")
    status, _, resp = hc.post(seeded_app["base"] + "/api/lectures",
                              raw_body=body, headers={"Content-Type": ctype})
    assert status == 400
    assert "error" in hc.as_json(resp)


def test_upload_accepts_and_queues_then_dedups(seeded_app):
    # A tiny fake mp4 is enough to test the ROUTE contract (queued + hash dedup);
    # background transcription will fail on fake bytes, but the row/hash exist.
    fake = b"\x00\x00\x00\x18ftypmp42FAKEuploadbytes-unique-xyz"
    body, ctype = _multipart({}, "file", "clip.mp4", fake)
    status, _, resp = hc.post(seeded_app["base"] + "/api/lectures",
                              raw_body=body, headers={"Content-Type": ctype})
    assert status == 200
    data = hc.as_json(resp)
    assert data["status"] == "queued"
    assert data["dedup"] is False

    # Second upload of identical bytes -> same content hash -> dedup reuse,
    # no duplicate job (status is queued/processing/ready depending on timing).
    body2, ctype2 = _multipart({}, "file", "clip-again.mp4", fake)
    status2, _, resp2 = hc.post(seeded_app["base"] + "/api/lectures",
                                raw_body=body2, headers={"Content-Type": ctype2})
    assert status2 == 200
    data2 = hc.as_json(resp2)
    assert data2["dedup"] is True


def test_context_endpoint_returns_grounded_message(seeded_app):
    """G4: /context returns a lecture-scoped, grounded message + real segments."""
    vid = seeded_app["video_id"]
    status, _, body = hc.get(seeded_app["base"] + f"/api/lectures/{vid}/context?t=5&q=gradient")
    assert status == 200
    data = hc.as_json(body)
    assert data["video_id"] == vid
    assert data["has_transcript"] is True
    assert "never invent" in data["message"].lower()      # anti-fabrication guardrail
    assert isinstance(data["segments"], list) and len(data["segments"]) >= 1
    for s in data["segments"]:
        assert set(["seq", "start", "end", "kind", "text"]).issubset(s.keys())


def test_context_endpoint_404_unknown_lecture(seeded_app):
    status, _, _ = hc.get(seeded_app["base"] + "/api/lectures/nope999/context?t=0")
    assert status == 404


# --- G5 bookmarks: save + reopen + persistence ---
def test_bookmark_create_and_list(seeded_app):
    vid = seeded_app["video_id"]
    status, _, body = hc.post(seeded_app["base"] + f"/api/lectures/{vid}/bookmarks",
                              json_body={"timestamp_seconds": 7.5, "title": "gradient moment",
                                         "transcript_excerpt": "gradient descent"})
    assert status == 200
    created = hc.as_json(body)
    assert created["timestamp_seconds"] == 7.5 and created["title"] == "gradient moment"

    status2, _, body2 = hc.get(seeded_app["base"] + f"/api/lectures/{vid}/bookmarks")
    assert status2 == 200
    data = hc.as_json(body2)
    assert data["count"] >= 1
    hit = next((b for b in data["bookmarks"] if b["id"] == created["id"]), None)
    assert hit is not None and hit["timestamp_seconds"] == 7.5


def test_bookmark_requires_title_and_timestamp(seeded_app):
    vid = seeded_app["video_id"]
    s1, _, _ = hc.post(seeded_app["base"] + f"/api/lectures/{vid}/bookmarks",
                       json_body={"timestamp_seconds": 5.0})            # no title
    assert s1 == 400
    s2, _, _ = hc.post(seeded_app["base"] + f"/api/lectures/{vid}/bookmarks",
                       json_body={"title": "x"})                        # no timestamp
    assert s2 == 400


def test_bookmark_list_404_unknown(seeded_app):
    s, _, _ = hc.get(seeded_app["base"] + "/api/lectures/nope999/bookmarks")
    assert s == 404


def test_bookmark_save_exports_json_file(seeded_app):
    """G5: saving a bookmark also writes data/lectures/<id>/bookmarks.json
    (atomic), and the exported file matches the stored records."""
    import json as _json
    from pathlib import Path as _P
    vid = seeded_app["video_id"]
    status, _, body = hc.post(seeded_app["base"] + f"/api/lectures/{vid}/bookmarks",
                              json_body={"timestamp_seconds": 12.0, "title": "exported concept",
                                         "note": "check export"})
    assert status == 200
    data = hc.as_json(body)
    assert data.get("exported") is True
    export = _P(seeded_app["data_dir"]) / "lectures" / vid / "bookmarks.json"
    assert export.exists(), "per-lecture bookmarks.json should be written"
    doc = _json.loads(export.read_text(encoding="utf-8"))
    assert doc["lecture_id"] == vid and doc["count"] >= 1
    hit = next((b for b in doc["bookmarks"] if b["title"] == "exported concept"), None)
    assert hit is not None and hit["timestamp_seconds"] == 12.0 and hit["note"] == "check export"


def test_status_endpoint_shape(seeded_app):
    vid = seeded_app["video_id"]
    status, _, body = hc.get(seeded_app["base"] + f"/api/lectures/{vid}/status")
    assert status == 200
    data = hc.as_json(body)
    assert set(["id", "stage", "status", "progress", "segment_count"]).issubset(data.keys())


# --- D-refresh: list + media + reattach ---
def test_lectures_list_includes_seeded(seeded_app):
    status, _, body = hc.get(seeded_app["base"] + "/api/lectures?limit=15")
    assert status == 200
    data = hc.as_json(body)
    assert data["count"] >= 1
    ids = [l["id"] for l in data["lectures"]]
    assert seeded_app["video_id"] in ids
    # each entry exposes the fields the UI needs
    first = data["lectures"][0]
    assert set(["id", "title", "status", "stage", "progress"]).issubset(first.keys())


def test_media_absent_is_honest_404(seeded_app):
    """Seeded lecture has no stored upload file -> honest 404, not a fake stream."""
    vid = seeded_app["video_id"]
    status, _, body = hc.get(seeded_app["base"] + f"/api/lectures/{vid}/media")
    assert status == 404
    assert "error" in hc.as_json(body)


def test_media_404_for_unknown_lecture(seeded_app):
    status, _, _ = hc.get(seeded_app["base"] + "/api/lectures/nope999/media")
    assert status == 404


def test_media_supports_range_requests_for_seeking(seeded_app, tmp_path_factory):
    """Regression for reattach seek failure: /media MUST honor HTTP Range so the
    <video> element can seek. A full-body 200 makes the reattached video
    non-seekable and silently drops currentTime changes.

    We create a lecture row and place a real file in its uploads/ slot, then
    assert a Range request returns 206 + Accept-Ranges + Content-Range.
    """
    import urllib.request
    from pathlib import Path as _P
    from app.storage import Storage

    # Use the same DB + data dir the running app uses (from the fixture).
    db_path = seeded_app["db_path"]
    data_dir = _P(seeded_app["data_dir"])
    s = Storage(db_path=db_path)
    v = s.create_video("ranged.mp4", duration_seconds=10.0, status="ready", stage="ready")

    uploads = data_dir / "uploads"
    uploads.mkdir(parents=True, exist_ok=True)
    payload = b"RANGESEEKTESTBYTES" * 1000  # 18,000 bytes of known content
    (uploads / f"{v.id}.mp4").write_bytes(payload)

    base = seeded_app["base"]

    # 1) Plain GET advertises range support.
    status, headers, body = hc.get(base + f"/api/lectures/{v.id}/media")
    assert status == 200
    assert headers.get("Accept-Ranges", "").lower() == "bytes", \
        f"missing Accept-Ranges: {dict(headers)}"
    assert len(body) == len(payload)

    # 2) A Range request returns 206 Partial Content with the right slice.
    req = urllib.request.Request(base + f"/api/lectures/{v.id}/media",
                                 headers={"Range": "bytes=0-1023"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        assert resp.status == 206, f"expected 206, got {resp.status}"
        cr = resp.headers.get("Content-Range", "")
        assert cr.startswith("bytes 0-1023/"), f"bad Content-Range: {cr!r}"
        chunk = resp.read()
        assert len(chunk) == 1024
        assert chunk == payload[:1024]


def test_reattach_does_not_create_new_lecture(seeded_app):
    """Reading status/transcript/list for an existing lecture must not add rows."""
    before = hc.as_json(hc.get(seeded_app["base"] + "/api/lectures?limit=100")[2])["count"]
    vid = seeded_app["video_id"]
    hc.get(seeded_app["base"] + f"/api/lectures/{vid}/status")
    hc.get(seeded_app["base"] + f"/api/lectures/{vid}/transcript")
    after = hc.as_json(hc.get(seeded_app["base"] + "/api/lectures?limit=100")[2])["count"]
    assert after == before


# --- G5.3 bookmark CRUD routes: PATCH (rename/renote) + DELETE ---
def _create_bookmark(seeded_app, title, ts=9.0, note=None):
    vid = seeded_app["video_id"]
    payload = {"timestamp_seconds": ts, "title": title}
    if note is not None:
        payload["note"] = note
    status, _, body = hc.post(seeded_app["base"] + f"/api/lectures/{vid}/bookmarks",
                              json_body=payload)
    assert status == 200, body
    return hc.as_json(body)


def test_bookmark_update_renames_and_preserves_timestamp(seeded_app):
    vid = seeded_app["video_id"]
    created = _create_bookmark(seeded_app, "before rename", ts=11.0, note="n1")
    status, _, body = hc.patch(
        seeded_app["base"] + f"/api/lectures/{vid}/bookmarks/{created['id']}",
        json_body={"title": "after rename"})
    assert status == 200
    data = hc.as_json(body)
    assert data["id"] == created["id"]
    assert data["title"] == "after rename"
    assert data["timestamp_seconds"] == 11.0          # timestamp preserved
    assert data["note"] == "n1"                        # note untouched by title-only patch
    assert data["exported"] is True                    # JSON re-export kept consistent


def test_bookmark_update_note_only(seeded_app):
    vid = seeded_app["video_id"]
    created = _create_bookmark(seeded_app, "keep title", note="old")
    status, _, body = hc.patch(
        seeded_app["base"] + f"/api/lectures/{vid}/bookmarks/{created['id']}",
        json_body={"note": "updated note"})
    assert status == 200
    data = hc.as_json(body)
    assert data["title"] == "keep title" and data["note"] == "updated note"


def test_bookmark_update_blank_title_rejected(seeded_app):
    vid = seeded_app["video_id"]
    created = _create_bookmark(seeded_app, "has title")
    status, _, _ = hc.patch(
        seeded_app["base"] + f"/api/lectures/{vid}/bookmarks/{created['id']}",
        json_body={"title": "   "})
    assert status == 400


def test_bookmark_update_404_unknown(seeded_app):
    vid = seeded_app["video_id"]
    status, _, _ = hc.patch(
        seeded_app["base"] + f"/api/lectures/{vid}/bookmarks/nope999",
        json_body={"title": "x"})
    assert status == 404


def test_bookmark_delete_removes_and_reexports(seeded_app):
    import json as _json
    from pathlib import Path as _P
    vid = seeded_app["video_id"]
    created = _create_bookmark(seeded_app, "to be deleted", ts=13.0)

    status, _, body = hc.delete(
        seeded_app["base"] + f"/api/lectures/{vid}/bookmarks/{created['id']}")
    assert status == 200
    data = hc.as_json(body)
    assert data["deleted"] is True and data["id"] == created["id"]
    assert data["exported"] is True

    # Gone from the list endpoint.
    _, _, lb = hc.get(seeded_app["base"] + f"/api/lectures/{vid}/bookmarks")
    ids = [b["id"] for b in hc.as_json(lb)["bookmarks"]]
    assert created["id"] not in ids

    # Gone from the exported JSON snapshot too (SQLite stays canonical).
    export = _P(seeded_app["data_dir"]) / "lectures" / vid / "bookmarks.json"
    doc = _json.loads(export.read_text(encoding="utf-8"))
    assert created["id"] not in [b["id"] for b in doc["bookmarks"]]


def test_bookmark_delete_404_unknown(seeded_app):
    vid = seeded_app["video_id"]
    status, _, _ = hc.delete(seeded_app["base"] + f"/api/lectures/{vid}/bookmarks/nope999")
    assert status == 404

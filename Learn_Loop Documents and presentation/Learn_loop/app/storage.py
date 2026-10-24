"""SQLite persistence for LearnLoop lectures and transcript segments (G2.2/G2.3).

Scope: only what Phase 2 needs — a `videos` row (id, title, duration, status)
and ordered `transcript_segments` carrying start/end times ON THE ORIGINAL
VIDEO TIMELINE, plus full-text-ish search over segment text.

Timestamp integrity (enforced on insert):
  finite, start >= 0, end >= start, and (when duration known) end <= duration
  within a small tolerance. Never silently reset to zero.
"""

from __future__ import annotations

import math
import sqlite3
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

from app.config import DB_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS videos (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    duration_seconds REAL,
    status TEXT NOT NULL DEFAULT 'created',
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Added columns (stage/progress/content_hash) are applied by _migrate() for
-- existing databases so prior records are preserved.
CREATE TABLE IF NOT EXISTS transcript_segments (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    start_time REAL NOT NULL,
    end_time REAL NOT NULL,
    text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_segments_video ON transcript_segments(video_id, seq);
CREATE TABLE IF NOT EXISTS bookmarks (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    timestamp_seconds REAL NOT NULL,
    title TEXT NOT NULL,
    transcript_excerpt TEXT,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bookmarks_video ON bookmarks(video_id, timestamp_seconds);
CREATE TABLE IF NOT EXISTS screenshots (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    timestamp_seconds REAL NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    transcript_excerpt TEXT,
    image_data TEXT NOT NULL,   -- base64-encoded JPEG
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_screenshots_video ON screenshots(video_id, timestamp_seconds);
"""

DURATION_TOLERANCE = 0.5  # seconds


class StorageError(RuntimeError):
    pass


@dataclass
class Video:
    id: str
    title: str
    duration_seconds: float | None
    status: str
    error: str | None = None
    stage: str = "created"      # queued|uploading|extracting|transcribing|ready|failed
    progress: float = 0.0       # 0..1, honest transcription fraction (chunk_end/duration)
    content_hash: str | None = None


@dataclass
class Bookmark:
    id: str
    video_id: str
    timestamp_seconds: float
    title: str
    transcript_excerpt: str | None
    note: str | None
    created_at: str


@dataclass
class TranscriptSegment:
    id: str
    video_id: str
    seq: int
    start_time: float
    end_time: float
    text: str


@dataclass
class Screenshot:
    id: str
    video_id: str
    timestamp_seconds: float
    title: str
    transcript_excerpt: str | None
    created_at: str
    # image_data is NOT included in the dataclass to keep list responses lean;
    # the full base64 JPEG is fetched separately via get_screenshot_image().


class Storage:
    def __init__(self, db_path: str | Path | None = None):
        self.db_path = Path(db_path) if db_path else DB_PATH
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    @contextmanager
    def _conn(self):
        conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

    def _init_db(self):
        with self._conn() as c:
            c.executescript(SCHEMA)
            self._migrate(c)

    def _migrate(self, c):
        """Add new columns to an existing videos table without data loss."""
        existing = {row["name"] for row in c.execute("PRAGMA table_info(videos)")}
        adds = {
            "stage": "ALTER TABLE videos ADD COLUMN stage TEXT NOT NULL DEFAULT 'created'",
            "progress": "ALTER TABLE videos ADD COLUMN progress REAL NOT NULL DEFAULT 0.0",
            "content_hash": "ALTER TABLE videos ADD COLUMN content_hash TEXT",
        }
        newly_added = []
        for col, ddl in adds.items():
            if col not in existing:
                c.execute(ddl)
                newly_added.append(col)
        # Backfill stage from status for pre-existing rows (so legacy 'ready'
        # videos report stage 'ready', not the column default 'created').
        if "stage" in newly_added:
            c.execute("UPDATE videos SET stage = status")
        c.execute("CREATE INDEX IF NOT EXISTS idx_videos_hash ON videos(content_hash)")
        # screenshots table added after initial schema — create it if absent.
        c.execute("""CREATE TABLE IF NOT EXISTS screenshots (
            id TEXT PRIMARY KEY,
            video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
            timestamp_seconds REAL NOT NULL,
            title TEXT NOT NULL DEFAULT '',
            transcript_excerpt TEXT,
            image_data TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )""")
        c.execute("CREATE INDEX IF NOT EXISTS idx_screenshots_video ON screenshots(video_id, timestamp_seconds)")

    # --- videos ---
    @staticmethod
    def _row_to_video(r) -> Video:
        keys = r.keys()
        return Video(
            id=r["id"], title=r["title"], duration_seconds=r["duration_seconds"],
            status=r["status"], error=r["error"],
            stage=r["stage"] if "stage" in keys and r["stage"] is not None else r["status"],
            progress=r["progress"] if "progress" in keys and r["progress"] is not None else 0.0,
            content_hash=r["content_hash"] if "content_hash" in keys else None,
        )

    def create_video(self, title: str, duration_seconds: float | None = None,
                     status: str = "created", stage: str | None = None,
                     content_hash: str | None = None) -> Video:
        vid = uuid.uuid4().hex[:12]
        stage = stage or status
        with self._conn() as c:
            c.execute(
                "INSERT INTO videos (id, title, duration_seconds, status, stage, progress, content_hash) "
                "VALUES (?,?,?,?,?,?,?)",
                (vid, title, duration_seconds, status, stage, 0.0, content_hash),
            )
        return Video(id=vid, title=title, duration_seconds=duration_seconds, status=status,
                     stage=stage, progress=0.0, content_hash=content_hash)

    def set_video_status(self, video_id: str, status: str, error: str | None = None):
        with self._conn() as c:
            cur = c.execute(
                "UPDATE videos SET status=?, error=? WHERE id=?", (status, error, video_id)
            )
            if cur.rowcount == 0:
                raise StorageError(f"No such video: {video_id}")

    def set_duration(self, video_id: str, duration_seconds: float):
        with self._conn() as c:
            cur = c.execute("UPDATE videos SET duration_seconds=? WHERE id=?",
                            (float(duration_seconds), video_id))
            if cur.rowcount == 0:
                raise StorageError(f"No such video: {video_id}")

    def set_progress(self, video_id: str, *, stage: str | None = None,
                     progress: float | None = None, status: str | None = None,
                     error: str | None = None):
        """Update stage/progress/status fields that are provided (others unchanged)."""
        sets, vals = [], []
        if stage is not None:
            sets.append("stage=?"); vals.append(stage)
        if progress is not None:
            sets.append("progress=?"); vals.append(max(0.0, min(1.0, float(progress))))
        if status is not None:
            sets.append("status=?"); vals.append(status)
        if error is not None:
            sets.append("error=?"); vals.append(error)
        if not sets:
            return
        vals.append(video_id)
        with self._conn() as c:
            cur = c.execute(f"UPDATE videos SET {', '.join(sets)} WHERE id=?", vals)
            if cur.rowcount == 0:
                raise StorageError(f"No such video: {video_id}")

    def get_video(self, video_id: str) -> Video | None:
        with self._conn() as c:
            r = c.execute("SELECT * FROM videos WHERE id=?", (video_id,)).fetchone()
        return self._row_to_video(r) if r else None

    def list_videos(self, limit: int = 20) -> list[Video]:
        """Return recent lectures, newest first (bounded)."""
        limit = max(1, min(int(limit), 100))
        with self._conn() as c:
            rs = c.execute(
                "SELECT * FROM videos ORDER BY created_at DESC LIMIT ?", (limit,)
            ).fetchall()
        return [self._row_to_video(r) for r in rs]

    def get_video_by_hash(self, content_hash: str) -> Video | None:
        if not content_hash:
            return None
        with self._conn() as c:
            r = c.execute(
                "SELECT * FROM videos WHERE content_hash=? ORDER BY created_at DESC LIMIT 1",
                (content_hash,),
            ).fetchone()
        return self._row_to_video(r) if r else None

    # --- segments ---
    def _validate_segment(self, start: float, end: float, duration: float | None):
        if not (math.isfinite(start) and math.isfinite(end)):
            raise StorageError(f"Non-finite timestamp: start={start} end={end}")
        if start < 0:
            raise StorageError(f"Negative start: {start}")
        if end < start:
            raise StorageError(f"end < start: start={start} end={end}")
        if duration is not None and duration > 0 and end > duration + DURATION_TOLERANCE:
            raise StorageError(f"end {end} exceeds duration {duration}")

    def replace_segments(self, video_id: str, segments, duration: float | None = None) -> int:
        """Replace all segments for a video with the given ordered list.

        `segments` is an iterable of objects with .start, .end, .text (e.g.
        transcription.Segment). Validates each against the timeline. Returns
        the number of segments written.
        """
        v = self.get_video(video_id)
        if v is None:
            raise StorageError(f"No such video: {video_id}")
        dur = duration if duration is not None else v.duration_seconds

        rows = []
        prev_end = -1.0
        for i, seg in enumerate(segments):
            start, end, text = float(seg.start), float(seg.end), (seg.text or "").strip()
            self._validate_segment(start, end, dur)
            # ordering sanity: segments should be non-decreasing in start
            if start + 1e-6 < prev_end - DURATION_TOLERANCE:
                raise StorageError(f"segments out of order at {i}: start={start} prev_end={prev_end}")
            prev_end = end
            rows.append((uuid.uuid4().hex[:12], video_id, i, start, end, text))

        with self._conn() as c:
            c.execute("DELETE FROM transcript_segments WHERE video_id=?", (video_id,))
            c.executemany(
                "INSERT INTO transcript_segments (id, video_id, seq, start_time, end_time, text) "
                "VALUES (?,?,?,?,?,?)", rows,
            )
        return len(rows)

    def append_segments(self, video_id: str, segments, duration: float | None = None) -> int:
        """Append ordered segments after existing ones (progressive transcription).

        Continues the `seq` counter from the current max. Validates each against
        the timeline. Returns the number appended.
        """
        v = self.get_video(video_id)
        if v is None:
            raise StorageError(f"No such video: {video_id}")
        dur = duration if duration is not None else v.duration_seconds

        with self._conn() as c:
            row = c.execute(
                "SELECT COALESCE(MAX(seq), -1) AS m, COALESCE(MAX(end_time), -1) AS e "
                "FROM transcript_segments WHERE video_id=?", (video_id,)
            ).fetchone()
            next_seq = int(row["m"]) + 1
            prev_end = float(row["e"])

            rows = []
            for seg in segments:
                start, end, text = float(seg.start), float(seg.end), (seg.text or "").strip()
                self._validate_segment(start, end, dur)
                if start + 1e-6 < prev_end - DURATION_TOLERANCE:
                    raise StorageError(
                        f"appended segment out of order: start={start} prev_end={prev_end}")
                prev_end = end
                rows.append((uuid.uuid4().hex[:12], video_id, next_seq, start, end, text))
                next_seq += 1

            c.executemany(
                "INSERT INTO transcript_segments (id, video_id, seq, start_time, end_time, text) "
                "VALUES (?,?,?,?,?,?)", rows,
            )
        return len(rows)

    def get_segments(self, video_id: str) -> list[TranscriptSegment]:
        with self._conn() as c:
            rs = c.execute(
                "SELECT * FROM transcript_segments WHERE video_id=? ORDER BY seq", (video_id,)
            ).fetchall()
        return [TranscriptSegment(id=r["id"], video_id=r["video_id"], seq=r["seq"],
                                  start_time=r["start_time"], end_time=r["end_time"],
                                  text=r["text"]) for r in rs]

    # --- bookmarks (G5 "Remember") ---
    def create_bookmark(self, video_id: str, timestamp_seconds: float, title: str,
                        transcript_excerpt: str | None = None, note: str | None = None) -> Bookmark:
        v = self.get_video(video_id)
        if v is None:
            raise StorageError(f"No such video: {video_id}")
        if not math.isfinite(timestamp_seconds) or timestamp_seconds < 0:
            raise StorageError(f"Invalid timestamp: {timestamp_seconds}")
        if v.duration_seconds and timestamp_seconds > v.duration_seconds + DURATION_TOLERANCE:
            raise StorageError(f"timestamp {timestamp_seconds} exceeds duration {v.duration_seconds}")
        if not (title or "").strip():
            raise StorageError("Bookmark title is required")
        bid = uuid.uuid4().hex[:12]
        with self._conn() as c:
            c.execute(
                "INSERT INTO bookmarks (id, video_id, timestamp_seconds, title, transcript_excerpt, note) "
                "VALUES (?,?,?,?,?,?)",
                (bid, video_id, float(timestamp_seconds), title.strip(), transcript_excerpt, note),
            )
            r = c.execute("SELECT * FROM bookmarks WHERE id=?", (bid,)).fetchone()
        return self._row_to_bookmark(r)

    @staticmethod
    def _row_to_bookmark(r) -> Bookmark:
        return Bookmark(id=r["id"], video_id=r["video_id"],
                        timestamp_seconds=r["timestamp_seconds"], title=r["title"],
                        transcript_excerpt=r["transcript_excerpt"], note=r["note"],
                        created_at=r["created_at"])

    def list_bookmarks(self, video_id: str) -> list[Bookmark]:
        with self._conn() as c:
            rs = c.execute(
                "SELECT * FROM bookmarks WHERE video_id=? ORDER BY timestamp_seconds", (video_id,)
            ).fetchall()
        return [self._row_to_bookmark(r) for r in rs]

    def get_bookmark(self, video_id: str, bookmark_id: str) -> Bookmark | None:
        with self._conn() as c:
            r = c.execute("SELECT * FROM bookmarks WHERE id=? AND video_id=?",
                          (bookmark_id, video_id)).fetchone()
        return self._row_to_bookmark(r) if r else None

    def update_bookmark(self, video_id: str, bookmark_id: str, *, title=None, note=None) -> Bookmark:
        """Update title and/or note of an existing bookmark (same id, lecture,
        timestamp preserved). Raises if not found or title blanked."""
        existing = self.get_bookmark(video_id, bookmark_id)
        if existing is None:
            raise StorageError(f"No such bookmark {bookmark_id} in lecture {video_id}")
        new_title = existing.title if title is None else str(title).strip()
        if not new_title:
            raise StorageError("Bookmark title cannot be empty")
        new_note = existing.note if note is None else note
        with self._conn() as c:
            c.execute("UPDATE bookmarks SET title=?, note=? WHERE id=? AND video_id=?",
                      (new_title, new_note, bookmark_id, video_id))
            r = c.execute("SELECT * FROM bookmarks WHERE id=?", (bookmark_id,)).fetchone()
        return self._row_to_bookmark(r)

    def delete_bookmark(self, video_id: str, bookmark_id: str) -> bool:
        with self._conn() as c:
            cur = c.execute("DELETE FROM bookmarks WHERE id=? AND video_id=?",
                            (bookmark_id, video_id))
            return cur.rowcount > 0

    # --- screenshots -------------------------------------------------------
    @staticmethod
    def _row_to_screenshot(r) -> Screenshot:
        return Screenshot(
            id=r["id"], video_id=r["video_id"],
            timestamp_seconds=r["timestamp_seconds"], title=r["title"] or "",
            transcript_excerpt=r["transcript_excerpt"], created_at=r["created_at"],
        )

    def create_screenshot(self, video_id: str, timestamp_seconds: float,
                          image_data: str, title: str = "",
                          transcript_excerpt: str | None = None) -> Screenshot:
        """Persist a JPEG frame capture (base64-encoded) with metadata."""
        v = self.get_video(video_id)
        if v is None:
            raise StorageError(f"No such video: {video_id}")
        if not image_data:
            raise StorageError("image_data is required")
        if not math.isfinite(timestamp_seconds) or timestamp_seconds < 0:
            raise StorageError(f"Invalid timestamp: {timestamp_seconds}")
        sid = uuid.uuid4().hex[:12]
        with self._conn() as c:
            c.execute(
                "INSERT INTO screenshots "
                "(id, video_id, timestamp_seconds, title, transcript_excerpt, image_data) "
                "VALUES (?,?,?,?,?,?)",
                (sid, video_id, float(timestamp_seconds),
                 (title or "").strip(), transcript_excerpt, image_data),
            )
        return Screenshot(id=sid, video_id=video_id,
                          timestamp_seconds=timestamp_seconds, title=(title or "").strip(),
                          transcript_excerpt=transcript_excerpt,
                          created_at="")   # created_at filled by DB default

    def list_screenshots(self, video_id: str) -> list[Screenshot]:
        with self._conn() as c:
            rs = c.execute(
                "SELECT id, video_id, timestamp_seconds, title, transcript_excerpt, created_at "
                "FROM screenshots WHERE video_id=? ORDER BY timestamp_seconds",
                (video_id,),
            ).fetchall()
        return [self._row_to_screenshot(r) for r in rs]

    def get_screenshot_image(self, video_id: str, screenshot_id: str) -> str | None:
        """Return just the base64 image_data for a screenshot."""
        with self._conn() as c:
            r = c.execute(
                "SELECT image_data FROM screenshots WHERE id=? AND video_id=?",
                (screenshot_id, video_id),
            ).fetchone()
        return r["image_data"] if r else None

    def delete_screenshot(self, video_id: str, screenshot_id: str) -> bool:
        with self._conn() as c:
            cur = c.execute(
                "DELETE FROM screenshots WHERE id=? AND video_id=?",
                (screenshot_id, video_id),
            )
        return cur.rowcount > 0

    def search_segments(self, video_id: str, query: str) -> list[TranscriptSegment]:
        """Case-insensitive substring search over segment text, ordered by time."""
        q = (query or "").strip()
        if not q:
            return []
        like = f"%{q}%"
        with self._conn() as c:
            rs = c.execute(
                "SELECT * FROM transcript_segments WHERE video_id=? AND text LIKE ? "
                "COLLATE NOCASE ORDER BY seq", (video_id, like),
            ).fetchall()
        return [TranscriptSegment(id=r["id"], video_id=r["video_id"], seq=r["seq"],
                                  start_time=r["start_time"], end_time=r["end_time"],
                                  text=r["text"]) for r in rs]

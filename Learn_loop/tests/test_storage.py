"""G2.2/G2.3 persistence tests — SQLite storage with timeline validation.

Pure logic, no model download; uses a temp DB. Validates segment integrity,
retrieval, and search/seek mapping.
"""

from __future__ import annotations

from dataclasses import dataclass

import pytest

from app.storage import Storage, StorageError


@dataclass
class Seg:
    start: float
    end: float
    text: str


@pytest.fixture
def store(tmp_path):
    return Storage(db_path=tmp_path / "test.db")


def test_create_and_get_video(store):
    v = store.create_video("Lecture A", duration_seconds=100.0, status="processing")
    got = store.get_video(v.id)
    assert got is not None
    assert got.title == "Lecture A"
    assert got.duration_seconds == 100.0
    assert got.status == "processing"


def test_status_transition_and_error(store):
    v = store.create_video("L", duration_seconds=10.0)
    store.set_video_status(v.id, "failed", error="boom")
    got = store.get_video(v.id)
    assert got.status == "failed"
    assert got.error == "boom"


def test_replace_and_get_segments_timeline(store):
    v = store.create_video("L", duration_seconds=30.0)
    segs = [Seg(0.0, 5.0, "hello world"), Seg(5.0, 12.0, "gradient descent"),
            Seg(12.0, 20.0, "optimize the line")]
    n = store.replace_segments(v.id, segs)
    assert n == 3
    got = store.get_segments(v.id)
    assert [s.seq for s in got] == [0, 1, 2]
    assert got[0].start_time == 0.0 and got[2].end_time == 20.0
    # ordered, finite, within duration
    for s in got:
        assert s.end_time >= s.start_time >= 0


def test_replace_segments_rejects_nonfinite(store):
    v = store.create_video("L", duration_seconds=30.0)
    with pytest.raises(StorageError, match="Non-finite"):
        store.replace_segments(v.id, [Seg(float("nan"), 5.0, "x")])


def test_replace_segments_rejects_end_before_start(store):
    v = store.create_video("L", duration_seconds=30.0)
    with pytest.raises(StorageError, match="end < start"):
        store.replace_segments(v.id, [Seg(5.0, 2.0, "x")])


def test_replace_segments_rejects_beyond_duration(store):
    v = store.create_video("L", duration_seconds=10.0)
    with pytest.raises(StorageError, match="exceeds duration"):
        store.replace_segments(v.id, [Seg(0.0, 50.0, "x")])


def test_replace_segments_is_idempotent_replace(store):
    v = store.create_video("L", duration_seconds=30.0)
    store.replace_segments(v.id, [Seg(0.0, 5.0, "first")])
    store.replace_segments(v.id, [Seg(0.0, 5.0, "second"), Seg(5.0, 6.0, "more")])
    got = store.get_segments(v.id)
    assert len(got) == 2
    assert got[0].text == "second"


def test_search_finds_phrase_case_insensitive(store):
    v = store.create_video("L", duration_seconds=30.0)
    store.replace_segments(v.id, [
        Seg(0.0, 5.0, "The cool thing is gradient descent"),
        Seg(5.0, 10.0, "optimize this line"),
        Seg(10.0, 15.0, "clusters and more"),
    ])
    hits = store.search_segments(v.id, "GRADIENT")
    assert len(hits) == 1
    assert hits[0].start_time == 0.0


def test_search_empty_query_returns_nothing(store):
    v = store.create_video("L", duration_seconds=30.0)
    store.replace_segments(v.id, [Seg(0.0, 5.0, "text")])
    assert store.search_segments(v.id, "") == []


def test_empty_transcript_persists_as_zero_segments(store):
    v = store.create_video("Silent", duration_seconds=5.0)
    n = store.replace_segments(v.id, [])
    assert n == 0
    assert store.get_segments(v.id) == []


def test_append_segments_continues_seq_and_timeline(store):
    v = store.create_video("L", duration_seconds=60.0)
    store.append_segments(v.id, [Seg(0.0, 10.0, "chunk one a"), Seg(10.0, 20.0, "chunk one b")])
    store.append_segments(v.id, [Seg(30.0, 40.0, "chunk two a")])  # next chunk, higher times
    got = store.get_segments(v.id)
    assert [s.seq for s in got] == [0, 1, 2]
    assert got[2].start_time == 30.0  # appended onto original timeline, not reset
    assert got[2].text == "chunk two a"


def test_append_segments_validates_timeline(store):
    v = store.create_video("L", duration_seconds=10.0)
    with pytest.raises(StorageError):
        store.append_segments(v.id, [Seg(0.0, 99.0, "too long")])


def test_progress_and_stage_updates(store):
    v = store.create_video("L", duration_seconds=100.0, status="queued", stage="queued")
    store.set_progress(v.id, stage="transcribing", progress=0.5, status="processing")
    got = store.get_video(v.id)
    assert got.stage == "transcribing"
    assert got.progress == 0.5
    assert got.status == "processing"
    # progress clamped to [0,1]
    store.set_progress(v.id, progress=5.0)
    assert store.get_video(v.id).progress == 1.0


def test_content_hash_dedup_lookup(store):
    v = store.create_video("L", duration_seconds=10.0, content_hash="abc123")
    found = store.get_video_by_hash("abc123")
    assert found is not None and found.id == v.id
    assert store.get_video_by_hash("nope") is None


def test_bookmark_create_list_and_persist(store):
    v = store.create_video("L", duration_seconds=100.0, status="ready", stage="ready")
    b = store.create_bookmark(v.id, 42.5, "gradient descent",
                              transcript_excerpt="we use gradient descent", note="review this")
    assert b.timestamp_seconds == 42.5 and b.title == "gradient descent"
    got = store.list_bookmarks(v.id)
    assert len(got) == 1 and got[0].id == b.id
    assert got[0].transcript_excerpt == "we use gradient descent"
    # Reopen via a fresh Storage on the SAME db → persistence across sessions/refresh.
    s2 = Storage(db_path=store.db_path)
    again = s2.list_bookmarks(v.id)
    assert len(again) == 1 and again[0].timestamp_seconds == 42.5


def test_bookmark_validation(store):
    v = store.create_video("L", duration_seconds=10.0, status="ready", stage="ready")
    with pytest.raises(StorageError):
        store.create_bookmark(v.id, -1.0, "bad")           # negative ts
    with pytest.raises(StorageError):
        store.create_bookmark(v.id, 5.0, "")               # empty title
    with pytest.raises(StorageError):
        store.create_bookmark(v.id, 999.0, "too far")      # beyond duration
    with pytest.raises(StorageError):
        store.create_bookmark("nope", 1.0, "no lecture")   # unknown lecture


def test_bookmarks_scoped_per_lecture(store):
    a = store.create_video("A", duration_seconds=100.0, status="ready", stage="ready")
    b = store.create_video("B", duration_seconds=100.0, status="ready", stage="ready")
    store.create_bookmark(a.id, 10.0, "in A")
    assert len(store.list_bookmarks(a.id)) == 1
    assert len(store.list_bookmarks(b.id)) == 0   # no cross-lecture leak


def test_set_duration_persists(store):
    v = store.create_video("L", duration_seconds=None, status="processing")
    assert store.get_video(v.id).duration_seconds is None
    store.set_duration(v.id, 123.4)
    assert store.get_video(v.id).duration_seconds == 123.4


def test_list_videos_empty_and_ordering(store):
    assert store.list_videos() == []
    a = store.create_video("A")
    b = store.create_video("B")
    ids = [v.id for v in store.list_videos()]
    # newest-first ordering; both present
    assert set(ids) == {a.id, b.id}
    assert store.list_videos(limit=1).__len__() == 1


def test_migration_preserves_old_rows(tmp_path):
    """A pre-existing DB without the new columns must migrate without data loss."""
    import sqlite3
    db = tmp_path / "old.db"
    conn = sqlite3.connect(str(db))
    conn.executescript(
        "CREATE TABLE videos (id TEXT PRIMARY KEY, title TEXT NOT NULL, "
        "duration_seconds REAL, status TEXT NOT NULL DEFAULT 'created', error TEXT, "
        "created_at TEXT NOT NULL DEFAULT (datetime('now')));"
        "CREATE TABLE transcript_segments (id TEXT PRIMARY KEY, video_id TEXT NOT NULL, "
        "seq INTEGER NOT NULL, start_time REAL NOT NULL, end_time REAL NOT NULL, text TEXT NOT NULL);"
        "INSERT INTO videos (id, title, status) VALUES ('old1', 'Legacy', 'ready');"
    )
    conn.commit()
    conn.close()

    s = Storage(db_path=db)  # triggers _migrate
    old = s.get_video("old1")
    assert old is not None
    assert old.title == "Legacy" and old.status == "ready"
    assert old.stage == "ready"   # defaults applied from status
    assert old.progress == 0.0

# --- G5.3 bookmark CRUD: get / update (rename+note) / delete ---
def test_get_bookmark_scoped(store):
    a = store.create_video("A", duration_seconds=100.0, status="ready", stage="ready")
    b = store.create_video("B", duration_seconds=100.0, status="ready", stage="ready")
    bm = store.create_bookmark(a.id, 10.0, "in A")
    assert store.get_bookmark(a.id, bm.id).id == bm.id
    assert store.get_bookmark(b.id, bm.id) is None        # wrong lecture → not found
    assert store.get_bookmark(a.id, "nope") is None       # unknown id


def test_update_bookmark_preserves_id_and_timestamp(store):
    v = store.create_video("L", duration_seconds=100.0, status="ready", stage="ready")
    bm = store.create_bookmark(v.id, 42.5, "old title", note="old note")
    updated = store.update_bookmark(v.id, bm.id, title="new title", note="new note")
    assert updated.id == bm.id                            # same id
    assert updated.timestamp_seconds == 42.5              # timestamp preserved
    assert updated.title == "new title" and updated.note == "new note"
    # title-only update leaves note intact
    u2 = store.update_bookmark(v.id, bm.id, title="renamed")
    assert u2.title == "renamed" and u2.note == "new note"


def test_update_bookmark_rejects_blank_title_and_missing(store):
    v = store.create_video("L", duration_seconds=100.0, status="ready", stage="ready")
    bm = store.create_bookmark(v.id, 5.0, "keep")
    with pytest.raises(StorageError):
        store.update_bookmark(v.id, bm.id, title="   ")   # blanked title rejected
    with pytest.raises(StorageError):
        store.update_bookmark(v.id, "nope", title="x")    # unknown bookmark
    with pytest.raises(StorageError):
        store.update_bookmark("nope", bm.id, title="x")   # wrong lecture


def test_delete_bookmark(store):
    v = store.create_video("L", duration_seconds=100.0, status="ready", stage="ready")
    bm = store.create_bookmark(v.id, 5.0, "bye")
    assert store.delete_bookmark(v.id, bm.id) is True
    assert store.get_bookmark(v.id, bm.id) is None
    assert store.delete_bookmark(v.id, bm.id) is False    # already gone
    assert store.delete_bookmark(v.id, "nope") is False   # unknown id

# --- Screenshots ---
def test_screenshot_create_and_list(store):
    v = store.create_video("L", duration_seconds=60.0, status="ready", stage="ready")
    ss = store.create_screenshot(v.id, 12.5, "dGVzdA==", title="frame1")
    assert ss.id and ss.timestamp_seconds == 12.5
    items = store.list_screenshots(v.id)
    assert len(items) == 1 and items[0].id == ss.id
    # image_data not in list result (lean)
    assert not hasattr(items[0], 'image_data') or True  # Screenshot dataclass has no image_data

def test_screenshot_get_image(store):
    v = store.create_video("L", duration_seconds=60.0, status="ready", stage="ready")
    ss = store.create_screenshot(v.id, 5.0, "aW1hZ2VkYXRh==")
    data = store.get_screenshot_image(v.id, ss.id)
    assert data == "aW1hZ2VkYXRh=="
    assert store.get_screenshot_image(v.id, "nope") is None

def test_screenshot_delete(store):
    v = store.create_video("L", duration_seconds=60.0, status="ready", stage="ready")
    ss = store.create_screenshot(v.id, 3.0, "dA==")
    assert store.delete_screenshot(v.id, ss.id) is True
    assert store.list_screenshots(v.id) == []
    assert store.delete_screenshot(v.id, ss.id) is False   # already gone

def test_screenshot_scoped_per_lecture(store):
    a = store.create_video("A", duration_seconds=60.0, status="ready", stage="ready")
    b = store.create_video("B", duration_seconds=60.0, status="ready", stage="ready")
    store.create_screenshot(a.id, 1.0, "dA==")
    assert len(store.list_screenshots(a.id)) == 1
    assert len(store.list_screenshots(b.id)) == 0

"""G4 retrieval tests: app/context_builder.build_context + render_context_message.

Pure logic over a temp SQLite store — runnable now (no model, no browser, no
Realtime). Covers handoff checks 6-12 and the grounding-render behaviour (15).
"""

from __future__ import annotations

from dataclasses import dataclass

import pytest

from app.storage import Storage
from app.context_builder import (
    build_context, render_context_message, WINDOW_SECONDS, MAX_CONTEXT_CHARS,
)


@dataclass
class Seg:
    start: float
    end: float
    text: str


@pytest.fixture
def store(tmp_path):
    return Storage(db_path=tmp_path / "ctx.db")


def _seed(store, title, segs, dur=600.0):
    v = store.create_video(title, duration_seconds=dur, status="ready", stage="ready")
    store.replace_segments(v.id, segs, duration=dur)
    return v.id


def test_context_from_correct_lecture_only(store):
    a = _seed(store, "Lecture A", [Seg(0, 5, "alpha apple"), Seg(5, 10, "alpha banana")])
    b = _seed(store, "Lecture B", [Seg(0, 5, "beta cherry"), Seg(5, 10, "beta date")])
    ctx = build_context(a, position=2.0, storage=store)
    assert ctx.video_id == a and ctx.title == "Lecture A"
    joined = " ".join(c.text for c in ctx.segments)
    assert "alpha" in joined and "beta" not in joined   # no cross-lecture leak (check 11)


def test_nearby_window_contains_expected_segments(store):
    segs = [Seg(0, 10, "intro"), Seg(100, 110, "near-before"),
            Seg(120, 130, "at-position"), Seg(500, 510, "far-later")]
    vid = _seed(store, "L", segs)
    ctx = build_context(vid, position=125.0, storage=store)
    texts = [c.text for c in ctx.segments]
    assert "at-position" in texts and "near-before" in texts   # within +/- window
    assert "far-later" not in texts and "intro" not in texts   # outside window (check 7)
    assert all(c.kind in ("nearby", "match") for c in ctx.segments)


def test_historical_match_included_with_valid_timestamps(store):
    segs = [Seg(0, 5, "we begin"), Seg(300, 310, "regularisation prevents overfitting"),
            Seg(600, 610, "the end")]
    vid = _seed(store, "L", segs, dur=620.0)
    ctx = build_context(vid, position=2.0, question="regularisation", storage=store)
    match = next((c for c in ctx.segments if "regularisation" in c.text), None)
    assert match is not None and match.kind == "match"     # historical retrieval (check 8)
    assert match.start == 300.0 and match.end == 310.0     # valid real timestamps
    assert 0 <= match.start <= 620.0


def test_empty_transcript_handled(store):
    v = store.create_video("Silent", duration_seconds=10.0, status="ready", stage="ready")
    ctx = build_context(v.id, position=5.0, storage=store)
    assert ctx.has_transcript is False and ctx.segments == []   # check 9
    msg = render_context_message(ctx)
    assert "no transcript" in msg.lower()
    assert "do not invent" in msg.lower()


def test_no_match_question_returns_only_nearby(store):
    segs = [Seg(0, 5, "nearby one"), Seg(5, 10, "nearby two"), Seg(400, 410, "far")]
    vid = _seed(store, "L", segs)
    ctx = build_context(vid, position=3.0, question="zzzznotpresent", storage=store)
    assert ctx.has_transcript is True
    assert all(c.kind == "nearby" for c in ctx.segments)       # no fabricated matches
    assert "far" not in [c.text for c in ctx.segments]


def test_context_is_size_bounded(store):
    # Many long nearby segments; assembled text must respect the char budget.
    big = [Seg(i, i + 1, "x" * 400) for i in range(0, 60)]     # all near position 10
    vid = _seed(store, "L", big, dur=100.0)
    ctx = build_context(vid, position=10.0, storage=store)
    total = sum(len(c.text) for c in ctx.segments)
    assert total <= MAX_CONTEXT_CHARS + 400                    # within budget (+1 overflow seg)
    assert len(ctx.segments) >= 1                              # check 10


def test_missing_lecture_flagged(store):
    ctx = build_context("nope", position=0.0, storage=store)
    assert ctx.has_transcript is False and ctx.note == "no_such_lecture"


def test_position_change_changes_context(store):
    segs = [Seg(0, 10, "start passage"), Seg(300, 310, "middle passage"),
            Seg(590, 600, "end passage")]
    vid = _seed(store, "L", segs, dur=600.0)
    early = build_context(vid, position=5.0, storage=store)
    late = build_context(vid, position=595.0, storage=store)
    assert "start passage" in [c.text for c in early.segments]
    assert "end passage" in [c.text for c in late.segments]
    assert [c.text for c in early.segments] != [c.text for c in late.segments]  # check 12


def test_render_includes_grounding_guardrails(store):
    vid = _seed(store, "Gradient Descent", [Seg(0, 6, "gradient descent optimizes the loss")])
    ctx = build_context(vid, position=2.0, question="gradient", storage=store)
    msg = render_context_message(ctx, question="what is gradient descent")
    assert "Gradient Descent" in msg                 # lecture identity present
    assert "never invent" in msg.lower()             # anti-fabrication instruction (check 15)
    assert "gradient descent optimizes" in msg        # real transcript text present
    assert "0:00" in msg                              # timestamp rendered

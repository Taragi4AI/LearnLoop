"""Grounded-context assembly for Looper (G4).

Builds a BOUNDED, deduplicated, lecture-scoped context block from the saved
transcript so the Realtime assistant can answer grounded in what the lecture
actually said. Pure/testable; reuses Storage.get_segments + search_segments.

Two sources, combined:
  1. Nearby-playback window: segments within +/- WINDOW_SECONDS of the current
     video position (what the student is watching right now).
  2. Historical matches: keyword hits for the student's question elsewhere in
     the lecture (so "where was X explained?" retrieves the real passage).

Everything is tagged with the lecture id + real start/end timestamps, deduped
by segment id, ranked (nearby first, then matches by time), and capped by a
character budget so we never resend the whole transcript.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.storage import Storage

WINDOW_SECONDS = 45.0        # +/- around current playback position
MAX_MATCHES = 6              # historical keyword matches to include
MAX_CONTEXT_CHARS = 2400     # hard cap on assembled transcript text


@dataclass
class ContextSegment:
    seq: int
    start: float
    end: float
    text: str
    kind: str                # "nearby" | "match"


@dataclass
class LectureContext:
    video_id: str
    title: str
    position: float
    segments: list[ContextSegment]
    has_transcript: bool
    note: str = ""


def _fmt_ts(seconds: float) -> str:
    s = int(seconds); return f"{s // 60}:{s % 60:02d}"


def build_context(video_id: str, position: float | None, question: str | None = None,
                  storage: Storage | None = None) -> LectureContext:
    storage = storage or Storage()
    video = storage.get_video(video_id)
    if video is None:
        return LectureContext(video_id=video_id, title="", position=position or 0.0,
                              segments=[], has_transcript=False, note="no_such_lecture")

    all_segs = storage.get_segments(video_id)
    if not all_segs:
        return LectureContext(video_id=video_id, title=video.title, position=position or 0.0,
                              segments=[], has_transcript=False, note="no_transcript")

    pos = position if (position is not None and position >= 0) else 0.0
    picked: dict[int, ContextSegment] = {}

    # 1) Nearby-playback window (storage segments use start_time/end_time).
    for s in all_segs:
        if s.end_time >= pos - WINDOW_SECONDS and s.start_time <= pos + WINDOW_SECONDS:
            picked[s.seq] = ContextSegment(s.seq, s.start_time, s.end_time, s.text, "nearby")

    # 2) Historical keyword matches for the question (dedup against nearby).
    if question and question.strip():
        matches = storage.search_segments(video_id, question.strip())
        for m in matches[:MAX_MATCHES]:
            if m.seq not in picked:
                picked[m.seq] = ContextSegment(m.seq, m.start_time, m.end_time, m.text, "match")

    # Rank: by time order (stable, predictable); nearby + matches interleave by seq.
    ordered = sorted(picked.values(), key=lambda c: c.start)

    # Enforce character budget (keep earliest-by-time within the window first,
    # but always keep at least the nearby ones we can fit).
    out: list[ContextSegment] = []
    total = 0
    for c in ordered:
        if total + len(c.text) > MAX_CONTEXT_CHARS and out:
            break
        out.append(c); total += len(c.text)

    return LectureContext(video_id=video_id, title=video.title, position=pos,
                          segments=out, has_transcript=True)


def render_context_message(ctx: LectureContext, question: str | None = None) -> str:
    """Render a compact, grounding-oriented text block to inject into Realtime.

    Explicitly instructs the assistant to stay grounded and never fabricate.
    """
    if not ctx.has_transcript:
        reason = "this lecture has no transcript yet" if ctx.note == "no_transcript" else "lecture unavailable"
        return (f"[LearnLoop context] Current lecture: \"{ctx.title}\". "
                f"No transcript context is available ({reason}). If asked what the lecturer "
                f"said, say you don't have the transcript to confirm; do not invent lecture content.")

    lines = [
        f"[LearnLoop lecture context] Lecture: \"{ctx.title}\" (id {ctx.video_id}). "
        f"Student is at {_fmt_ts(ctx.position)}.",
        "Use ONLY the transcript excerpts below to answer questions about what the lecture/"
        "lecturer said. Cite the timestamp when you reference a passage. If the excerpts do "
        "not contain the answer, say the transcript doesn't establish it — never invent a "
        "quote, timestamp, or lecture claim. You may add clearly-labelled general background.",
        "",
        "Transcript excerpts (timestamp — text):",
    ]
    for c in ctx.segments:
        tag = "near" if c.kind == "nearby" else "match"
        lines.append(f"  [{_fmt_ts(c.start)}] ({tag}) {c.text}")
    if question:
        lines.append("")
        lines.append(f"Student's question: {question}")
    return "\n".join(lines)

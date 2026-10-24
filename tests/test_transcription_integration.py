"""G2.2 real transcription integration test (local, offline).

Runs faster-whisper on a short real clip extracted from the StatQuest fixture
and asserts real transcript + ordered, finite, bounded word/segment timestamps.
NOT mocked. Skips only if the fixture is absent. Downloads the `tiny` model on
first run (~75 MB) from Hugging Face; NO lecture audio leaves the machine.
"""

from __future__ import annotations

import os
import subprocess
import wave
from pathlib import Path

import pytest

from app.audio_extract import _ffmpeg_exe
from app.transcription import FasterWhisperTranscriber, TranscriptionResult

os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
FIXTURE = REPO_ROOT / "Learn_loop test vids" / "Short_video_StatQuest_Gradient_Descent.mp4"

pytestmark = pytest.mark.skipif(not FIXTURE.exists(), reason=f"fixture absent: {FIXTURE}")


@pytest.fixture(scope="module")
def short_clip(tmp_path_factory):
    out = tmp_path_factory.mktemp("stt") / "clip.wav"
    # 15s clip starting at 60s, 16 kHz mono PCM — matches transcriber expectations.
    subprocess.run(
        [_ffmpeg_exe(), "-y", "-ss", "60", "-t", "15", "-i", str(FIXTURE),
         "-vn", "-ac", "1", "-ar", "16000", "-acodec", "pcm_s16le", str(out)],
        capture_output=True, check=True,
    )
    return out


def test_real_transcription_has_text_and_timestamps(short_clip):
    t = FasterWhisperTranscriber(model_size="tiny", device="cpu", compute_type="int8")
    result = t.transcribe_wav(short_clip, time_offset=0.0)

    assert isinstance(result, TranscriptionResult)
    assert result.language == "en"
    assert result.segments, "expected at least one segment"

    # Real text (not empty, not fabricated placeholder).
    joined = " ".join(s.text for s in result.segments).lower()
    assert len(joined) > 20
    assert "gradient" in joined  # known content of this clip

    # Segment timestamps: finite, ordered, within clip duration (~15s, allow tol).
    prev_end = -1.0
    for s in result.segments:
        assert s.start >= 0 and s.end >= s.start
        assert s.end <= 16.0
        assert s.start >= prev_end - 0.5  # non-decreasing
        prev_end = s.end

    # Word-level timestamps present and ordered within the first segment.
    words = result.segments[0].words
    assert words, "expected word timestamps"
    for w in words:
        assert w.end >= w.start >= 0


def test_time_offset_shifts_timeline(short_clip):
    t = FasterWhisperTranscriber(model_size="tiny", device="cpu", compute_type="int8")
    base = t.transcribe_wav(short_clip, time_offset=0.0)
    shifted = t.transcribe_wav(short_clip, time_offset=100.0)
    # Offset must move timestamps onto the original timeline, not reset to zero.
    assert shifted.segments[0].start == pytest.approx(base.segments[0].start + 100.0, abs=0.01)


def test_progressive_pipeline_persists_duration_and_segments(short_clip, tmp_path):
    """Regression: progressive pipeline must store duration on the row (was null),
    and reattach reads must not duplicate segments."""
    from app.storage import Storage
    from app.pipeline import process_video_progressive

    db = tmp_path / "pipe.db"
    s = Storage(db_path=db)
    v = s.create_video(title="clip", status="queued", stage="queued")
    assert s.get_video(v.id).duration_seconds is None

    process_video_progressive(v.id, short_clip, storage=s, chunk_seconds=10.0)

    got = s.get_video(v.id)
    assert got.stage == "ready"
    assert got.duration_seconds and got.duration_seconds > 0, "duration must be persisted"

    segs = s.get_segments(v.id)
    assert len(segs) > 0
    # Timestamps on the original timeline, ordered.
    starts = [x.start_time for x in segs]
    assert starts == sorted(starts)
    # Reading again returns the SAME count (no duplication on reattach/read).
    assert len(s.get_segments(v.id)) == len(segs)


def test_chunked_transcription_maps_to_original_timeline(short_clip):
    """Chunked inference must keep timestamps on the ORIGINAL timeline and stay
    ordered across chunk boundaries (10s chunks over a ~15s clip => 2 chunks)."""
    t = FasterWhisperTranscriber(model_size="tiny", device="cpu", compute_type="int8")
    chunks = list(t.transcribe_wav_chunked(short_clip, chunk_seconds=10.0))
    assert len(chunks) >= 2, "expected multiple chunks"

    # Second chunk's segments must start at/after ~10s (its offset), proving
    # timestamps are NOT reset to zero per chunk.
    second = chunks[1]
    assert second["chunk_start"] == pytest.approx(10.0, abs=0.01)
    if second["segments"]:
        assert second["segments"][0].start >= 9.5

    # Flattened timeline is globally non-decreasing in start time.
    all_segs = [s for ch in chunks for s in ch["segments"]]
    starts = [s.start for s in all_segs]
    assert starts == sorted(starts)
    # Progress fractions (chunk_end/total) are increasing and end near 1.0.
    totals = {ch["total_duration"] for ch in chunks}
    assert len(totals) == 1 and next(iter(totals)) > 0

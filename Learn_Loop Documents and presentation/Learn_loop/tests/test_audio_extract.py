"""G2.1 tests for app/audio_extract.py.

The happy-path test performs a REAL extraction from a real local video fixture
using the venv-bundled ffmpeg, then decodes the output with stdlib `wave` to
validate it. It is NOT mocked. If the fixture is absent (e.g. CI without the
video), the real-extraction tests skip rather than fail, but failure cases and
input validation always run.

No network calls are made; no audio is sent anywhere.
"""

from __future__ import annotations

import wave
from pathlib import Path

import pytest

from app.audio_extract import (
    extract_audio, probe_duration, has_audio_stream,
    ExtractionError, TARGET_SAMPLE_RATE, TARGET_CHANNELS,
)

REPO_ROOT = Path(__file__).resolve().parent.parent.parent  # E:/higgs_hackathon
FIXTURE = REPO_ROOT / "Learn_loop test vids" / "Short_video_StatQuest_Gradient_Descent.mp4"

fixture_available = pytest.mark.skipif(
    not FIXTURE.exists(), reason=f"test video not present: {FIXTURE}"
)


# ---------------------------------------------------------------------------
# Input validation / failure cases (always run — no fixture needed)
# ---------------------------------------------------------------------------
def test_missing_input_raises(tmp_path):
    with pytest.raises(ExtractionError, match="does not exist"):
        extract_audio(tmp_path / "nope.mp4", tmp_path / "out.wav")


def test_non_file_input_raises(tmp_path):
    d = tmp_path / "adir"
    d.mkdir()
    with pytest.raises(ExtractionError):
        extract_audio(d, tmp_path / "out.wav")


def test_no_audio_stream_raises(tmp_path):
    # A text file masquerading as mp4 has no audio stream -> clean error,
    # not a crash and not a false success.
    fake = tmp_path / "fake.mp4"
    fake.write_bytes(b"not a real video")
    with pytest.raises(ExtractionError):
        extract_audio(fake, tmp_path / "out.wav")


# ---------------------------------------------------------------------------
# Real extraction from the StatQuest fixture
# ---------------------------------------------------------------------------
@fixture_available
def test_fixture_has_audio_stream():
    assert has_audio_stream(FIXTURE) is True


@fixture_available
def test_real_extraction_produces_valid_wav(tmp_path):
    out = tmp_path / "statquest.wav"
    art = extract_audio(FIXTURE, out)

    # 1. Output exists and is non-empty.
    assert out.exists()
    assert art.size_bytes > 0
    assert out.stat().st_size == art.size_bytes

    # 2. Decodable by an independent tool (stdlib wave) and correctly formatted.
    with wave.open(str(out), "rb") as w:
        assert w.getnchannels() == TARGET_CHANNELS           # mono
        assert w.getframerate() == TARGET_SAMPLE_RATE         # 16 kHz
        assert w.getsampwidth() == 2                          # 16-bit
        n_frames = w.getnframes()
        assert n_frames > 0
        wav_duration = n_frames / float(w.getframerate())

    # 3. Duration consistent with the source video (within tolerance).
    src_duration = art.duration_seconds
    assert src_duration > 0, "source duration should be known"
    assert abs(wav_duration - src_duration) <= 1.0, (
        f"wav {wav_duration:.2f}s vs source {src_duration:.2f}s"
    )


@fixture_available
def test_probe_duration_positive():
    assert probe_duration(FIXTURE) > 0

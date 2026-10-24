"""Audio extraction for LearnLoop (G2.1 spike).

Single, replaceable responsibility: turn a video file into a WAV audio artifact
suitable for speech-to-text. The FFmpeg binary is the venv-bundled one from
`imageio-ffmpeg` (no system install, no PATH dependency). FFmpeg is invoked via
an explicit argument array — never a shell string — per the project's safety
rules (constraints.md).

Target format (recorded assumption, verify before STT in G2.2):
  WAV / PCM signed 16-bit little-endian, mono, 16 kHz.
  Rationale: `api-notes.md` chose WAV as the canonical intermediate, and Higgs
  audio processing is documented at 16-bit mono PCM (24 kHz internally for
  Realtime). 16 kHz is the STT-standard rate and resamples cleanly to 24 kHz.
  NOTE: the current Boson docs do NOT expose a hosted batch STT file endpoint
  (only live `higgs-stt-3.1` inside Realtime, or self-hosted weights). The exact
  STT input contract therefore remains UNVERIFIED (spec gate VG-1).

This module performs NO network calls and sends NO audio anywhere.
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path

import imageio_ffmpeg

# Target audio parameters.
TARGET_SAMPLE_RATE = 16000
TARGET_CHANNELS = 1
TARGET_CODEC = "pcm_s16le"   # WAV signed 16-bit little-endian
TARGET_FORMAT = "wav"


class ExtractionError(RuntimeError):
    """Raised when audio extraction fails for a known, reportable reason."""


@dataclass
class AudioArtifact:
    path: Path
    sample_rate: int
    channels: int
    codec: str
    duration_seconds: float
    size_bytes: int


def _ffmpeg_exe() -> str:
    return imageio_ffmpeg.get_ffmpeg_exe()


def probe_duration(video_path: Path) -> float:
    """Return the source duration in seconds using ffmpeg (no ffprobe needed).

    We read duration from ffmpeg's -i stderr banner. Returns 0.0 if unknown.
    """
    exe = _ffmpeg_exe()
    proc = subprocess.run(
        [exe, "-i", str(video_path)],
        capture_output=True, text=True,
    )
    # ffmpeg prints stream info to stderr and exits non-zero on -i only; parse it.
    for line in proc.stderr.splitlines():
        line = line.strip()
        if line.startswith("Duration:"):
            # e.g. "Duration: 00:03:21.44, start: 0.000000, bitrate: ..."
            token = line.split("Duration:", 1)[1].split(",", 1)[0].strip()
            if token.lower() == "n/a":
                return 0.0
            h, m, s = token.split(":")
            return int(h) * 3600 + int(m) * 60 + float(s)
    return 0.0


def has_audio_stream(video_path: Path) -> bool:
    """True if ffmpeg reports at least one audio stream in the file."""
    exe = _ffmpeg_exe()
    proc = subprocess.run([exe, "-i", str(video_path)], capture_output=True, text=True)
    return "Audio:" in proc.stderr


def extract_audio(
    video_path: str | Path,
    out_path: str | Path,
    *,
    sample_rate: int = TARGET_SAMPLE_RATE,
    channels: int = TARGET_CHANNELS,
) -> AudioArtifact:
    """Extract audio from `video_path` into a WAV file at `out_path`.

    Raises ExtractionError on missing input, missing audio stream, or a failed
    ffmpeg run. Returns an AudioArtifact describing the output on success.
    """
    video_path = Path(video_path)
    out_path = Path(out_path)

    if not video_path.exists():
        raise ExtractionError(f"Input video does not exist: {video_path}")
    if not video_path.is_file():
        raise ExtractionError(f"Input path is not a file: {video_path}")
    if not has_audio_stream(video_path):
        raise ExtractionError(f"No audio stream found in: {video_path}")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    exe = _ffmpeg_exe()
    args = [
        exe,
        "-y",                      # overwrite output
        "-i", str(video_path),
        "-vn",                     # drop video
        "-ac", str(channels),      # channel count
        "-ar", str(sample_rate),   # sample rate
        "-acodec", TARGET_CODEC,   # PCM s16le
        "-f", TARGET_FORMAT,       # WAV container
        str(out_path),
    ]
    proc = subprocess.run(args, capture_output=True, text=True)
    if proc.returncode != 0:
        tail = "\n".join(proc.stderr.splitlines()[-5:])
        raise ExtractionError(f"ffmpeg failed (exit {proc.returncode}):\n{tail}")
    if not out_path.exists() or out_path.stat().st_size == 0:
        raise ExtractionError("ffmpeg reported success but output is missing or empty.")

    return AudioArtifact(
        path=out_path,
        sample_rate=sample_rate,
        channels=channels,
        codec=TARGET_CODEC,
        duration_seconds=probe_duration(video_path),
        size_bytes=out_path.stat().st_size,
    )

"""Lecture processing pipeline (G2.2): extract -> transcribe -> persist.

Ties together the replaceable seams:
  app.audio_extract.extract_audio  (G2.1, ffmpeg -> WAV, timeline preserved)
  app.transcription.Transcriber    (faster-whisper, local/offline)
  app.storage.Storage              (SQLite, validated timeline segments)

Status is recorded honestly on the video row: processing -> ready | failed.
No lecture audio leaves the machine.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

from app.audio_extract import extract_audio, ExtractionError, probe_duration
from app.transcription import (
    Transcriber, get_default_transcriber, TranscriptionError, FasterWhisperTranscriber,
)
from app.storage import Storage, StorageError


class PipelineError(RuntimeError):
    pass


def process_video_progressive(
    video_id: str,
    video_path: str | Path,
    *,
    storage: Storage,
    transcriber: Transcriber | None = None,
    chunk_seconds: float = 30.0,
) -> None:
    """Progressive pipeline for an EXISTING video row (created by the upload route).

    Extract audio, then transcribe in chunks, appending segments and updating
    stage/progress after each chunk. Honest stages:
      extracting -> transcribing (progress = chunk_end/duration) -> ready | failed.
    Never fabricates content; records errors on the row.
    """
    video_path = Path(video_path)
    transcriber = transcriber or get_default_transcriber()
    tmp_wav = Path(tempfile.gettempdir()) / f"learnloop_{video_id}.wav"
    try:
        storage.set_progress(video_id, stage="extracting", status="processing", progress=0.0)
        duration = probe_duration(video_path)
        if duration and duration > 0:
            # Persist duration on the row so the UI (seek clamping, timeline) has it.
            storage.set_duration(video_id, duration)
        extract_audio(video_path, tmp_wav)

        storage.set_progress(video_id, stage="transcribing")
        # Chunked transcription requires the concrete faster-whisper transcriber.
        if not hasattr(transcriber, "transcribe_wav_chunked"):
            transcriber = FasterWhisperTranscriber()

        any_chunk = False
        for chunk in transcriber.transcribe_wav_chunked(tmp_wav, chunk_seconds=chunk_seconds):
            any_chunk = True
            storage.append_segments(video_id, chunk["segments"],
                                    duration=duration or chunk["total_duration"])
            total = duration or chunk["total_duration"] or 0.0
            frac = (chunk["chunk_end"] / total) if total > 0 else 0.0
            storage.set_progress(video_id, progress=frac)

        storage.set_progress(video_id, stage="ready", status="ready", progress=1.0)
    except (ExtractionError, TranscriptionError, StorageError) as e:
        storage.set_progress(video_id, stage="failed", status="failed", error=str(e))
        raise PipelineError(str(e)) from e
    except Exception as e:  # unexpected — still mark failed honestly
        storage.set_progress(video_id, stage="failed", status="failed", error=str(e))
        raise
    finally:
        try:
            if tmp_wav.exists():
                tmp_wav.unlink()
        except OSError:
            pass


def process_video(
    video_path: str | Path,
    *,
    title: str | None = None,
    storage: Storage | None = None,
    transcriber: Transcriber | None = None,
) -> str:
    """Process one local video end to end. Returns the created video_id.

    Records status transitions and never fabricates transcript content on
    failure. Raises PipelineError with a clear message on hard failure, after
    marking the video row 'failed'.
    """
    video_path = Path(video_path)
    storage = storage or Storage()
    transcriber = transcriber or get_default_transcriber()

    duration = probe_duration(video_path) if video_path.exists() else None
    video = storage.create_video(
        title=title or video_path.name,
        duration_seconds=duration or None,
        status="processing",
    )

    tmp_wav = Path(tempfile.gettempdir()) / f"learnloop_{video.id}.wav"
    try:
        extract_audio(video_path, tmp_wav)  # timeline preserved, offset 0
        result = transcriber.transcribe_wav(tmp_wav, time_offset=0.0)
        n = storage.replace_segments(video.id, result.segments, duration=duration or result.duration)
        storage.set_video_status(video.id, "ready")
        return video.id
    except (ExtractionError, TranscriptionError, StorageError) as e:
        storage.set_video_status(video.id, "failed", error=str(e))
        raise PipelineError(str(e)) from e
    finally:
        try:
            if tmp_wav.exists():
                tmp_wav.unlink()
        except OSError:
            pass

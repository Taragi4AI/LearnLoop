"""Local, offline transcription for LearnLoop (G2.2).

faster-whisper (CTranslate2) runs entirely on-device; no lecture audio leaves
the machine. Transcription sits behind a small, replaceable interface
(`Transcriber`) so the backend never hard-codes a provider.

Design notes:
- Audio is fed as a NumPy float32 array decoded from the WAV produced by
  `app.audio_extract`, NOT via faster-whisper's built-in PyAV decoder. The
  installed `av` build is incompatible with faster-whisper's internal
  `av.open(metadata_errors=...)` call, and this also reuses the G2.1 seam.
- Timestamps are emitted relative to the START of the decoded audio. A
  `time_offset` lets callers map chunk-local times back onto the original video
  timeline (so chunked processing never resets timestamps to zero).
"""

from __future__ import annotations

import wave
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

import numpy as np

from app.config import STT_MODEL, STT_DEVICE, STT_COMPUTE_TYPE, STT_SAMPLE_RATE


class TranscriptionError(RuntimeError):
    pass


@dataclass
class Word:
    start: float
    end: float
    text: str


@dataclass
class Segment:
    start: float
    end: float
    text: str
    words: list[Word] = field(default_factory=list)


@dataclass
class TranscriptionResult:
    language: str
    duration: float
    segments: list[Segment]


class Transcriber(Protocol):
    """Replaceable transcription interface."""

    def transcribe_wav(self, wav_path: str | Path, *, time_offset: float = 0.0) -> TranscriptionResult:
        ...


def _decode_wav_to_float32(wav_path: Path) -> tuple[np.ndarray, int]:
    """Decode a PCM16 mono WAV into a float32 [-1,1] array + sample rate."""
    with wave.open(str(wav_path), "rb") as w:
        if w.getsampwidth() != 2:
            raise TranscriptionError("WAV must be 16-bit PCM.")
        if w.getnchannels() != 1:
            raise TranscriptionError("WAV must be mono.")
        sr = w.getframerate()
        frames = w.readframes(w.getnframes())
    audio = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    return audio, sr


class FasterWhisperTranscriber:
    """Default local transcriber backed by faster-whisper."""

    def __init__(self, model_size: str | None = None, device: str | None = None,
                 compute_type: str | None = None):
        self.model_size = model_size or STT_MODEL
        self.device = device or STT_DEVICE
        self.compute_type = compute_type or STT_COMPUTE_TYPE
        self._model = None  # lazy — avoids download until first use

    def _ensure_model(self):
        if self._model is None:
            try:
                from faster_whisper import WhisperModel
            except ImportError as e:  # pragma: no cover
                raise TranscriptionError(
                    "faster-whisper is not installed; cannot transcribe."
                ) from e
            self._model = WhisperModel(
                self.model_size, device=self.device, compute_type=self.compute_type
            )
        return self._model

    def _transcribe_array(self, audio, *, time_offset: float) -> tuple[list[Segment], str, float]:
        model = self._ensure_model()
        raw_segments, info = model.transcribe(audio, word_timestamps=True)
        segments: list[Segment] = []
        for s in raw_segments:
            words = [
                Word(start=float(w.start) + time_offset,
                     end=float(w.end) + time_offset,
                     text=w.word)
                for w in (s.words or [])
                if w.start is not None and w.end is not None
            ]
            segments.append(Segment(
                start=float(s.start) + time_offset,
                end=float(s.end) + time_offset,
                text=s.text.strip(),
                words=words,
            ))
        return segments, (info.language or ""), float(info.duration)

    def transcribe_wav(self, wav_path: str | Path, *, time_offset: float = 0.0) -> TranscriptionResult:
        wav_path = Path(wav_path)
        if not wav_path.exists():
            raise TranscriptionError(f"WAV not found: {wav_path}")

        audio, sr = _decode_wav_to_float32(wav_path)
        if sr != STT_SAMPLE_RATE:
            raise TranscriptionError(
                f"WAV sample rate {sr} != expected {STT_SAMPLE_RATE}; "
                "extract audio at 16 kHz."
            )
        if audio.size == 0:
            # Honest empty result rather than inventing content.
            return TranscriptionResult(language="", duration=0.0, segments=[])

        segments, language, duration = self._transcribe_array(audio, time_offset=time_offset)
        return TranscriptionResult(language=language, duration=duration, segments=segments)

    def transcribe_wav_chunked(self, wav_path: str | Path, *, chunk_seconds: float = 30.0):
        """Generator: transcribe the WAV in time windows, yielding per-chunk results.

        Yields dicts: {segments, chunk_start, chunk_end, total_duration}.
        Each chunk's timestamps are mapped onto the ORIGINAL timeline via
        time_offset = chunk_start, so progressive output stays timeline-accurate.
        """
        wav_path = Path(wav_path)
        if not wav_path.exists():
            raise TranscriptionError(f"WAV not found: {wav_path}")
        audio, sr = _decode_wav_to_float32(wav_path)
        if sr != STT_SAMPLE_RATE:
            raise TranscriptionError(
                f"WAV sample rate {sr} != expected {STT_SAMPLE_RATE}; extract at 16 kHz.")

        total_samples = audio.size
        total_duration = total_samples / float(sr) if total_samples else 0.0
        if total_samples == 0:
            return  # nothing to yield; caller treats as empty

        window = int(chunk_seconds * sr)
        for start_sample in range(0, total_samples, window):
            end_sample = min(start_sample + window, total_samples)
            chunk = audio[start_sample:end_sample]
            chunk_start = start_sample / float(sr)
            chunk_end = end_sample / float(sr)
            segments, _lang, _dur = self._transcribe_array(chunk, time_offset=chunk_start)
            # Clamp any segment end to the chunk boundary to avoid spill from
            # model padding; timeline mapping is already applied via offset.
            for seg in segments:
                if seg.end > chunk_end:
                    seg.end = chunk_end
            yield {
                "segments": segments,
                "chunk_start": chunk_start,
                "chunk_end": chunk_end,
                "total_duration": total_duration,
            }


def get_default_transcriber() -> Transcriber:
    return FasterWhisperTranscriber()

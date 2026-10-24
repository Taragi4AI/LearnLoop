"""LearnLoop configuration — kept separate from application logic.

Transcription/model settings are read from environment variables with safe
defaults so the model choice can change without touching code.
"""

from __future__ import annotations

import os
from pathlib import Path

# Project root = this file's parent's parent (Learn_loop/).
PROJECT_ROOT = Path(__file__).resolve().parent.parent

# --- Storage ---
DATA_DIR = Path(os.environ.get("LEARNLOOP_DATA_DIR", PROJECT_ROOT / "data"))
DB_PATH = Path(os.environ.get("LEARNLOOP_DB_PATH", DATA_DIR / "learnloop.db"))

# --- Transcription (faster-whisper, local/offline) ---
# Model size: tiny | base | small | medium | large-v3. Default tiny for speed.
STT_MODEL = os.environ.get("LEARNLOOP_STT_MODEL", "tiny")
# Device: cpu | cuda. Default cpu (no GPU assumed).
STT_DEVICE = os.environ.get("LEARNLOOP_STT_DEVICE", "cpu")
# Compute type: int8 (CPU default), int8_float16, float16 (GPU), float32.
STT_COMPUTE_TYPE = os.environ.get("LEARNLOOP_STT_COMPUTE_TYPE", "int8")
# Target sample rate Whisper expects.
STT_SAMPLE_RATE = 16000

"""G3.1 privacy guard: the local wake-word module must NOT transmit audio.

Static source checks on public/wakeword.js:
  - It performs local mic capture (getUserMedia) and local ONNX inference.
  - It does NOT open a WebSocket, does NOT POST audio, and does NOT reference
    Higgs Realtime / boson endpoints. (Realtime wiring is a SEPARATE later gate.)

This is a source-level guard, not a runtime proof; the browser-observed
"no audio egress" acceptance remains a manual check (documented).
"""

from __future__ import annotations

from pathlib import Path

WW = Path(__file__).resolve().parent.parent / "public" / "wakeword.js"


def test_wakeword_module_exists():
    assert WW.exists(), "public/wakeword.js missing"


def test_wakeword_has_no_network_egress_primitives():
    src = WW.read_text(encoding="utf-8")
    forbidden = ["WebSocket", "boson.ai", "realtime", "input_audio_buffer",
                 "fetch(", "XMLHttpRequest", "navigator.sendBeacon"]
    hits = [tok for tok in forbidden if tok in src]
    assert not hits, f"wakeword.js must not reference network/Realtime primitives: {hits}"


def test_wakeword_is_local_capture():
    src = WW.read_text(encoding="utf-8")
    assert "getUserMedia" in src, "expected local mic capture via getUserMedia"
    assert "onnxruntime-web" in src, "expected local ONNX inference"

"""G3.2 gating guard: Looper Realtime must not capture mic before activation.

Source-level checks on public/looper-realtime.js:
  - getUserMedia is called inside startMic(), which is only invoked from onOpen()
    AFTER start() mints a secret and opens the WebSocket — i.e. only on explicit
    activation. There is no module-top-level getUserMedia.
  - The long-lived key is never referenced; it uses /api/realtime/client-secret.

Not a runtime proof (live two-way audio needs a browser + mic + credentials,
flagged for HITL), but it guards the "no pre-activation streaming" invariant.
"""

from __future__ import annotations

import re
from pathlib import Path

RT = Path(__file__).resolve().parent.parent / "public" / "looper-realtime.js"


def test_module_exists():
    assert RT.exists()


def test_getusermedia_only_inside_startmic():
    src = RT.read_text(encoding="utf-8")
    # getUserMedia must appear, and only within the startMic function body.
    assert "getUserMedia" in src
    # crude scope check: getUserMedia occurs after "async function startMic"
    gum = src.index("getUserMedia")
    startmic = src.index("async function startMic")
    assert gum > startmic, "getUserMedia must live inside startMic (post-activation)"
    # and startMic is invoked from onOpen (post-connect), not at module load
    assert "await startMic()" in src


def test_uses_server_minted_secret_not_raw_key():
    src = RT.read_text(encoding="utf-8")
    assert "/api/realtime/client-secret" in src
    assert "BOSON_API_KEY" not in src  # no long-lived key in the browser module


def test_no_top_level_side_effect_capture():
    src = RT.read_text(encoding="utf-8")
    # The exported factory must not auto-start; start() is explicit.
    assert "export function createLooperSession" in src
    # No immediate invocation of start at module scope.
    assert not re.search(r"\n\s*start\(\)\s*;", src)

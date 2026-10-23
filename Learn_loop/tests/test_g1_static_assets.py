"""G1 regression: the lecture player assets are served and M0 is intact.

These run against the FastAPI backend (and the legacy one) using the same
fixture harness as the M0 suite. They do NOT exercise browser playback — that
requires a real browser and is reported separately as manual/unverified.
"""

from __future__ import annotations

from tests import http_client as hc

G1_ASSETS = [
    ("/learn.html", "text/html", b"<video"),
    ("/learn.js", "javascript", b"createPlayerController"),
    ("/learn.css", "css", b".drop-zone"),
    ("/learn.js", "javascript", b"searchTranscript"),      # search wiring present
    ("/learn.js", "javascript", b"autoProcess"),           # auto upload+process
    ("/learn.js", "javascript", b"highlightCurrent"),      # current-segment highlight
    ("/learn.js", "javascript", b"reattachLecture"),       # D-refresh reattach
    ("/learn.js", "javascript", b"seekPlayer"),            # robust deferred seek
    ("/learn.js", "javascript", b"createWakeWordListener"),# G3.1 wake-word import
    ("/wakeword.js", "javascript", b"createWakeWordListener"),
    ("/wakeword.js", "javascript", b"getUserMedia"),       # local mic acquisition
    ("/learn.html", "text/html", b"wwToggle"),             # wake-word control present
    ("/learn.js", "javascript", b"createLooperSession"),   # G3.2 Realtime import
    ("/looper-realtime.js", "javascript", b"createLooperSession"),
    ("/looper-realtime.js", "javascript", b"input_audio_buffer.append"),  # mic→Realtime
    ("/looper-realtime.js", "javascript", b"conversation.item.create"),   # G4 context injection
    ("/looper-realtime.js", "javascript", b"turn_detection: null"),       # manual turns (race fix)
    ("/looper-realtime.js", "javascript", b"requestResponse"),            # explicit response trigger
    ("/turn-sequencer.js", "javascript", b"createTurnSequencer"),         # sequencer module
    ("/learn.html", "text/html", b"rtStop"),               # stop-conversation control
    ("/learn.html", "text/html", b"rtExport"),             # debug chat export control
    ("/learn.js", "javascript", b"createTurnSequencer"),   # G4 race-free wiring
    ("/learn.js", "javascript", b"exportConvoLog"),        # conversation debug export
    ("/learn.js", "javascript", b"saveBookmark"),          # G5 bookmark save
    ("/learn.html", "text/html", b"bmSave"),               # bookmark control present
    ("/looper-realtime.js", "javascript", b"LOOPER_TOOLS"),             # G5 tool definitions
    ("/looper-realtime.js", "javascript", b"function_call_output"),     # tool-result protocol
    ("/looper-realtime.js", "javascript", b"returnToolResult"),         # tool-result sender
    ("/learn.js", "javascript", b"executeTool"),                        # host tool executor
    ("/learn.js", "javascript", b"prepare_bookmark"),                   # propose-before-save
    ("/learn.js", "javascript", b"pendingBookmarks"),                   # non-persisted proposals
    # --- G5.3: audio no-overlap coordinator, expanded player controls, bookmark CRUD ---
    ("/looper-realtime.js", "javascript", b"gateAndPlay"),              # audio gate (no overlap)
    ("/looper-realtime.js", "javascript", b"beforeAgentAudio"),        # pause-before-speak hook
    ("/looper-realtime.js", "javascript", b"get_player_state"),        # observed-state read tool
    ("/looper-realtime.js", "javascript", b"update_bookmark"),         # rename/renote tool
    ("/looper-realtime.js", "javascript", b"delete_bookmark"),         # delete tool
    ("/learn.js", "javascript", b"ensureLecturePausedForSpeech"),      # verified pause policy
    ("/learn.js", "javascript", b"resumeLectureAfterSpeech"),          # resume on session end (unstick)
    ("/learn.js", "javascript", b"captureResumeIntent"),               # remember pre-activation play state
    ("/learn.js", "javascript", b"renameBookmark"),                    # UI rename
    ("/learn.js", "javascript", b"deleteBookmark"),                    # UI delete
    ("/player-core.js", "javascript", b"setVolume"),                   # volume control surface
    ("/player-core.js", "javascript", b"isPlaying"),                   # observed-playing read
    ("/learn.js", "javascript", b"nextOccurrence"),        # Next-occurrence nav
    ("/learn.js", "javascript", b"prevOccurrence"),        # Previous nav
    ("/learn.js", "javascript", b"toggleAutoScan"),        # Auto-scan
    ("/learn.js", "javascript", b"createSearchNav"),       # imports pure nav controller
    ("/search-nav.js", "javascript", b"export function createSearchNav"),
    ("/search-nav.js", "javascript", b"previous()"),       # controller has previous
    ("/learn.html", "text/html", b"tpNext"),               # Next button present
    ("/learn.html", "text/html", b"tpPrev"),               # Previous button present
    ("/learn.html", "text/html", b"tpAuto"),               # Auto-scan button present
    ("/learn.html", "text/html", b"recentList"),           # recent-lectures UI
    ("/player-core.js", "javascript", b"export function createPlayerController"),
]


def test_g1_assets_served(app_server):
    for path, ctype_fragment, must_contain in G1_ASSETS:
        status, headers, body = hc.get(app_server["base"] + path)
        assert status == 200, f"{path} -> {status}"
        assert ctype_fragment in headers.get("Content-Type", ""), \
            f"{path} content-type was {headers.get('Content-Type')!r}"
        assert must_contain in body, f"{path} missing expected marker {must_contain!r}"


def test_learn_html_links_player_entry(app_server):
    _, _, body = hc.get(app_server["base"] + "/learn.html")
    text = body.decode("utf-8", errors="replace")
    assert 'src="learn.js"' in text
    assert 'type="module"' in text


def test_m0_playground_still_served(app_server):
    """The original playground index must remain intact alongside the new page."""
    status, headers, body = hc.get(app_server["base"] + "/")
    assert status == 200
    assert "text/html" in headers.get("Content-Type", "")
    # index.html is the Higgs playground; learn.html is the new G1 page.
    assert b"<html" in body.lower()


def test_m0_health_unchanged(app_server):
    status, _, body = hc.get(app_server["base"] + "/api/health")
    assert status == 200
    data = hc.as_json(body)
    assert data["ok"] is True and "keyConfigured" in data

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
    ("/looper-realtime.js", "javascript", b"semantic_vad"),               # server-side turn detection
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
    # --- Warm academic theme + live streaming chat ---
    ("/learn.css", "css", b"#FAF7F0"),                                 # warm ivory background
    ("/learn.css", "css", b".convo-row.looper.streaming"),             # live-streaming caret state
    ("/learn.js", "javascript", b"appendConvoDelta"),                  # incremental bubble update
    ("/learn.js", "javascript", b"setSpeakingIndicator"),              # subtle speaking indicator
    ("/looper-realtime.js", "javascript", b"onUserPending"),           # provisional user-turn signal
    ("/looper-realtime.js", "javascript", b"onAssistantInterrupted"),  # barge-in interruption signal
    # --- Phase 2: three-panel workspace layout ---
    ("/learn.html", "text/html", b'class="workspace'),                 # grid workspace container
    ("/learn.html", "text/html", b'id="leftRail"'),                    # left lecture-nav rail
    ("/learn.html", "text/html", b'id="centerCol"'),                   # center player+transcript
    ("/learn.html", "text/html", b'id="looperRail"'),                  # right Looper rail
    ("/learn.html", "text/html", b"looper-activate"),                  # always-visible activation controls
    ("/learn.css", "css", b"grid-template-columns"),                   # CSS grid layout
    ("/learn.js", "javascript", b"toggleRail"),                        # rail collapse logic
    # --- Phase 3: video priority, display settings, focus/scroll fixes ---
    ("/learn.js", "javascript", b"revealInContainer"),                 # container-only scroll (no page jump)
    ("/learn.js", "javascript", b"followTranscript"),                  # opt-in follow mode (default off)
    ("/learn.js", "javascript", b"toggleFullscreen"),                  # fullscreen control
    ("/learn.js", "javascript", b"applyDisplayPrefs"),                 # fit/ratio/size settings
    ("/learn.html", "text/html", b'id="settingsBtn"'),                 # display settings menu
    ("/learn.html", "text/html", b'id="fullscreenBtn"'),               # fullscreen button
    ("/learn.html", "text/html", b'id="followTranscript"'),            # follow-transcript toggle
    ("/learn.html", "text/html", b'data-fit="contain"'),               # default fit container
    ("/learn.css", "css", b"minmax(520px, 1fr)"),                      # center min-width guard
    ("/learn.css", "css", b"object-fit"),                              # no-distortion fit
    # --- Phase 5: purposeful motion + microinteractions ---
    ("/learn.css", "css", b"prefers-reduced-motion"),                  # reduced-motion gate
    ("/learn.css", "css", b"--ease-out"),                              # shared motion tokens
    ("/learn.css", "css", b"@keyframes bubble-in"),                    # restrained bubble entrance
    ("/learn.css", "css", b".bm-item.just-saved"),                     # post-save confirmation flash
    ("/learn.css", "css", b"thinking-dots"),                           # discreet thinking indicator
    ("/learn.js", "javascript", b"setThinkingIndicator"),              # thinking state wiring
    ("/learn.js", "javascript", b"justSavedBookmarkId"),               # confirm only after backend save
    # --- live chat sync + auto-scroll ---
    ("/chat-stream.js", "javascript", b"shouldApplyResponseEvent"),    # stale-response guard
    ("/chat-stream.js", "javascript", b"reconcileFinalText"),          # no duplicate final text
    ("/learn.js", "javascript", b"bubbleForResponse"),                 # response-id → bubble mapping
    ("/learn.js", "javascript", b"maybeAutoScroll"),                   # follow-bottom logic
    ("/learn.html", "text/html", b'id="rtJumpLatest"'),                # jump-to-latest control
    ("/learn.html", "text/html", b'id="rtSentinel"'),                  # bottom sentinel
    ("/looper-realtime.js", "javascript", b"onResponseStart"),         # response lifecycle id
    ("/looper-realtime.js", "javascript", b"activeResponseId"),        # stale-guard source
    # --- realtime voice fixes: barge-in, latency tuning, instrumentation ---
    ("/looper-realtime.js", "javascript", b"bargeInCancel"),           # interrupt-cancel path
    ("/looper-realtime.js", "javascript", b"response.cancel"),         # supported cancel protocol
    ("/looper-realtime.js", "javascript", b"detectBargeIn"),           # local speech-onset while speaking
    ("/looper-realtime.js", "javascript", b"cancelledResponseId"),     # stale-audio guard after cancel
    ("/looper-realtime.js", "javascript", b"silenceCallbacks"),        # configurable end-of-turn
    ("/learn.js", "javascript", b"latency_mark"),                      # pipeline timing instrumentation
    ("/learn.css", "css", b".ws-right .convo-scroll { max-height"),    # bounded chat scroll (laptops)
    # --- voice activity cues ---
    ("/learn.html", "text/html", b'id="cueStrip"'),                    # activity cue strip
    ("/learn.js", "javascript", b"showRetrievalResult"),               # retrieval timestamp card
    ("/learn.js", "javascript", b"showActionCueResult"),               # confirmed action outcome
    ("/learn.js", "javascript", b"CUE_DEFS"),                          # the five cue definitions
    ("/learn.css", "css", b".cue-card-strip"),                         # cue card styling
    ("/learn.css", "css", b"@keyframes cwave"),                        # waveform cue
    ("/learn.js", "javascript", b"captureFrameThumb"),                 # real-frame thumbnail (safe)
    ("/learn.js", "javascript", b"const SVG"),                         # inline SVG icon set (no emoji)
    # --- chat scroll / listening controls / seek fixes ---
    ("/learn.js", "javascript", b"seekAndConfirm"),                    # async-verified seek
    ("/learn.js", "javascript", b"isStopListeningCommand"),            # "stop listening" control phrase
    ("/learn.js", "javascript", b"userStoppedExplicitly"),             # no auto-restart after explicit stop
    ("/learn.css", "css", b"max-height: 52vh"),                        # hard chat-scroll bound fallback
    ("/looper-realtime.js", "javascript", b"minutes: { type"),         # minutes/seconds seek path
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

"""Regression guards for the wake-word -> Realtime voice-session handoff."""

from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
LEARN = (ROOT / "public" / "learn.js").read_text(encoding="utf-8")
REALTIME = (ROOT / "public" / "looper-realtime.js").read_text(encoding="utf-8")
HTML = (ROOT / "public" / "learn.html").read_text(encoding="utf-8")
WAKEWORD = (ROOT / "public" / "wakeword.js").read_text(encoding="utf-8")


def test_realtime_uses_documented_ephemeral_secret_subprotocol():
    assert "bai-client-secret.${ephemeralKey}" in REALTIME
    assert "openai-insecure-api-key" not in REALTIME


def test_wake_handoff_releases_local_capture_without_touching_video():
    detect = LEARN[LEARN.index("onDetect: () =>"):LEARN.index("let wwDesired", LEARN.index("onDetect: () =>"))]
    assert "disableWakeWord().finally" in detect
    assert "startConversation()" in detect
    assert "player.pause" not in detect
    assert "captureResumeIntent" not in detect


def test_normal_ui_has_no_manual_activation_bypass_and_chat_starts_hidden():
    assert 'id="wwManual" type="button" hidden' in HTML
    assert 'id="looperConvo"' in HTML and 'looper-convo hidden' in HTML
    assert "debugVoice" in LEARN
    assert "function trigger()" not in WAKEWORD


def test_stop_is_application_owned_and_never_auto_rearms_wake_word():
    assert "Stopped listening — mic off." in LEARN
    assert "Stopped listening — multiple speakers detected. Mic off." in LEARN
    assert "wwDesired = false;                 // never silently re-arm after a stop" in LEARN
    closed = LEARN[LEARN.index("if (s === 'closed' || s === 'error')"):LEARN.index("  // User finished/started speaking", LEARN.index("if (s === 'closed' || s === 'error')"))]
    assert "wakeword.enable" not in closed


def test_barge_in_and_multi_speaker_shutdown_drop_stale_events_and_release_mic():
    assert "input_audio_buffer.speech_started" in REALTIME
    assert "interruptActiveResponse('barge_in')" in REALTIME
    assert "conversation.item.truncate" in REALTIME
    assert "generation !== sessionGeneration" in REALTIME
    assert "onMultipleSpeakers" in REALTIME
    assert "micStream.getTracks().forEach((t) => t.stop())" in REALTIME

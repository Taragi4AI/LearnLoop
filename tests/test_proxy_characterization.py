"""Characterization / route-parity suite for the LearnLoop backend proxy.

Runs identically against the legacy Python proxy (server.py) and the FastAPI
migration (server_fastapi.py), selected by LEARNLOOP_BACKEND. The Boson upstream
is mocked at the network boundary by the fake_upstream fixture (see conftest).

Scope (Milestone 0): the five existing proxy route groups only —
health, TTS speech (JSON + binary), voices CRUD, videos (create/get/content),
realtime client-secret — plus key-handling and error relay behavior.
"""

from __future__ import annotations

import json

from tests import http_client as hc


# ---------------------------------------------------------------------------
# Health / config
# ---------------------------------------------------------------------------
def test_health_reports_key_configured(app_server):
    status, headers, body = hc.get(app_server["base"] + "/api/health")
    assert status == 200
    assert "application/json" in headers.get("Content-Type", "")
    data = hc.as_json(body)
    assert data["ok"] is True
    assert data["keyConfigured"] is True
    assert "apiBase" in data


# ---------------------------------------------------------------------------
# TTS — JSON envelope (timestamps=true) vs binary audio (timestamps=false)
# ---------------------------------------------------------------------------
def test_tts_binary_audio_passthrough(app_server, fake_upstream):
    status, headers, body = hc.post(
        app_server["base"] + "/api/tts/speech",
        json_body={"model": "higgs-tts-3", "input": "hi", "response_format": "mp3"},
    )
    assert status == 200
    assert headers.get("Content-Type", "").startswith("audio/")
    assert body == b"ID3FAKEAUDIOBYTES"
    # The proxy must have attached the bearer key to the upstream call.
    auth = fake_upstream["recorder"].last["headers"].get("Authorization", "")
    assert auth.startswith("Bearer bai-")


def test_tts_json_envelope_when_timestamps(app_server):
    status, headers, body = hc.post(
        app_server["base"] + "/api/tts/speech",
        json_body={"model": "higgs-tts-3", "input": "hi", "timestamps": True},
    )
    assert status == 200
    assert "application/json" in headers.get("Content-Type", "")
    data = hc.as_json(body)
    assert data["audio"] == "QUJD"
    assert isinstance(data["timestamps"], list)


# ---------------------------------------------------------------------------
# Voices CRUD
# ---------------------------------------------------------------------------
def test_voices_list(app_server):
    status, headers, body = hc.get(app_server["base"] + "/api/voices")
    assert status == 200
    assert "application/json" in headers.get("Content-Type", "")
    data = hc.as_json(body)
    assert data["data"][0]["voice"] == "voice_abc"


def test_voices_create(app_server):
    status, headers, body = hc.post(
        app_server["base"] + "/api/voices",
        json_body={"ref_audio": "https://x/a.mp3", "ref_text": "hello"},
    )
    assert status == 200
    assert hc.as_json(body)["voice"] == "voice_new"


def test_voices_get_by_id(app_server):
    status, headers, body = hc.get(app_server["base"] + "/api/voices/voice_abc")
    assert status == 200
    assert hc.as_json(body)["voice"] == "voice_abc"


def test_voices_delete(app_server):
    status, headers, body = hc.delete(app_server["base"] + "/api/voices/voice_abc")
    assert status == 200
    data = hc.as_json(body)
    assert data["deleted"] is True
    assert data["voice"] == "voice_abc"


# ---------------------------------------------------------------------------
# Videos (avatar jobs): create -> get -> content
# ---------------------------------------------------------------------------
def test_videos_create(app_server):
    status, headers, body = hc.post(
        app_server["base"] + "/api/videos",
        json_body={"model": "higgs-avatar", "ref_image": "https://x/f.jpg"},
    )
    assert status == 200
    data = hc.as_json(body)
    assert data["id"] == "vid_123"
    assert data["status"] == "queued"


def test_videos_get_status(app_server):
    status, headers, body = hc.get(app_server["base"] + "/api/videos/vid_123")
    assert status == 200
    data = hc.as_json(body)
    assert data["status"] == "completed"
    assert data["progress"] == 100


def test_videos_content_is_binary_mp4(app_server):
    status, headers, body = hc.get(app_server["base"] + "/api/videos/vid_123/content")
    assert status == 200
    assert headers.get("Content-Type", "").startswith("video/")
    assert body.startswith(b"\x00\x00\x00\x18ftyp")


# ---------------------------------------------------------------------------
# Realtime client secret
# ---------------------------------------------------------------------------
def test_realtime_client_secret(app_server):
    status, headers, body = hc.post(
        app_server["base"] + "/api/realtime/client-secret",
        json_body={"expires_after": {"seconds": 600}},
    )
    assert status == 200
    data = hc.as_json(body)
    assert data["value"] == "bai-eph-fake"


# ---------------------------------------------------------------------------
# Static frontend is served
# ---------------------------------------------------------------------------
def test_index_html_served(app_server):
    status, headers, body = hc.get(app_server["base"] + "/")
    assert status == 200
    assert "text/html" in headers.get("Content-Type", "")
    assert b"<html" in body.lower()


def test_shared_js_served_with_js_mime(app_server):
    status, headers, body = hc.get(app_server["base"] + "/shared.js")
    assert status == 200
    assert "javascript" in headers.get("Content-Type", "")


# ---------------------------------------------------------------------------
# Error handling / relay behavior
# ---------------------------------------------------------------------------
def test_unknown_api_route_returns_404_json(app_server):
    status, headers, body = hc.post(app_server["base"] + "/api/does-not-exist",
                                    json_body={})
    assert status == 404
    data = hc.as_json(body)
    assert "error" in data


def test_key_never_exposed_to_client(app_server):
    """The long-lived key must not appear in any client-visible response body."""
    for path in ["/api/health", "/"]:
        _, _, body = hc.get(app_server["base"] + path)
        assert b"bai-test-key-not-real" not in body

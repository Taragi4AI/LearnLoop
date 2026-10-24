"""Avatar creation retries only responses known not to have created a session."""

import asyncio
import json

import server_fastapi


def test_listed_preset_missing_once_is_retried(monkeypatch):
    calls = []

    def request(method, path, *, json_body, include_headers):
        calls.append((method, path, json_body, include_headers))
        if len(calls) == 1:
            return 404, "application/json", json.dumps({"error": {"code": "avatar_not_found"}}).encode(), {}
        return 200, "application/json", b'{"id":"avrt_test"}', {}

    monkeypatch.setattr(server_fastapi, "_boson_request", request)
    result = asyncio.run(server_fastapi._create_boson_avatar_session({"avatar_id": "builtin_emma_v1"}, "builtin_emma_v1"))
    assert result[0] == 200
    assert len(calls) == 2


def test_custom_avatar_not_found_is_not_retried(monkeypatch):
    calls = []

    def request(method, path, *, json_body, include_headers):
        calls.append(path)
        return 404, "application/json", json.dumps({"error": {"code": "avatar_not_found"}}).encode(), {}

    monkeypatch.setattr(server_fastapi, "_boson_request", request)
    result = asyncio.run(server_fastapi._create_boson_avatar_session({}, "custom_missing"))
    assert result[0] == 404
    assert len(calls) == 1


def test_ambiguous_proxy_error_is_not_retried(monkeypatch):
    calls = []

    def request(method, path, *, json_body, include_headers):
        calls.append(path)
        return 502, "application/json", b'{"error":{"code":"proxy_error"}}', {}

    monkeypatch.setattr(server_fastapi, "_boson_request", request)
    result = asyncio.run(server_fastapi._create_boson_avatar_session({}, "builtin_emma_v1"))
    assert result[0] == 502
    assert len(calls) == 1

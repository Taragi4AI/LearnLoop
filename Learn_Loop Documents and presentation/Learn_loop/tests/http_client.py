"""Tiny stdlib HTTP client for tests — no third-party deps.

Returns (status, headers_dict, body_bytes). Does not raise on 4xx/5xx so the
tests can assert on error responses the way the browser observes them.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request


class _CIHeaders(dict):
    """Case-insensitive view of response headers.

    HTTP header names are case-insensitive (RFC 9110). The stdlib http.server
    emits them title-cased while uvicorn emits them lower-cased; tests must not
    depend on either casing.
    """

    def __init__(self, headers):
        super().__init__({str(k).lower(): v for k, v in dict(headers).items()})

    def get(self, key, default=None):
        return super().get(str(key).lower(), default)

    def __getitem__(self, key):
        return super().__getitem__(str(key).lower())


def request(method: str, url: str, *, json_body=None, raw_body: bytes | None = None,
            headers: dict | None = None):
    data = None
    hdrs = dict(headers or {})
    if json_body is not None:
        data = json.dumps(json_body).encode("utf-8")
        hdrs["Content-Type"] = "application/json"
    elif raw_body is not None:
        data = raw_body

    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, _CIHeaders(resp.headers), resp.read()
    except urllib.error.HTTPError as e:
        return e.code, _CIHeaders(e.headers), e.read()


def get(url, **kw):
    return request("GET", url, **kw)


def post(url, **kw):
    return request("POST", url, **kw)


def delete(url, **kw):
    return request("DELETE", url, **kw)


def patch(url, **kw):
    return request("PATCH", url, **kw)


def as_json(body: bytes):
    return json.loads(body.decode("utf-8"))

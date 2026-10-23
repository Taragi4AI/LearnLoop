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

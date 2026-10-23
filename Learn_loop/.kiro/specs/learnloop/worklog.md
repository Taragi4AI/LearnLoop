# LearnLoop — Work Log

Timestamps use Toronto local time (EDT/EST) and are preserved as supplied by the
user or recorded by Kiro at the time of the event. They are not retrofitted.

---

## 2026-10-22 20:26:00 EDT — Milestone 0: FastAPI proxy migration (Option B)

**Authorization:** User approved the three spec files in principle and authorized
Milestone 0 only, via Option B (characterization tests first, then migrate).

### Environment findings
- `python` = **3.14.8**. `pip` available via `python -m pip` (26.2.1). `pytest` 9.1.1 present.
- **`node` / `npm` are NOT on PATH.** Therefore `server.js` cannot be independently
  executed or verified in this environment. The legacy baseline is `server.py` only.
  `server.js` was left **untouched** and remains unverified here.

### Python 3.14 compatibility (verified by real install, not just metadata)
Isolated `.venv` created; installed successfully on Python 3.14.8:
- fastapi 0.161.1, starlette 1.9.0, uvicorn 0.54.0, pydantic 2.14.1 (V2, native cp314 wheel),
  python-multipart 0.0.32.
- No build errors, no Pydantic V1 fallback (V1 is known-incompatible with 3.14; V2 is used).

### Baseline (legacy `server.py`, unchanged)
- Command: `$env:LEARNLOOP_BACKEND="legacy"; python -m pytest -v`
- First run: **9 failed, 6 passed.** Investigated per instruction (do not force a pass).
  Root cause = **test harness bug**, not the app: the fake Boson upstream matched paths
  like `/audio/speech` but the proxy correctly forwards to `{BASE}/v1` → `/v1/audio/speech`.
  Verified with a probe (`FAKE UPSTREAM SAW: [('POST', '/v1/audio/speech')]`).
  Fix: fake upstream strips a leading `/v1`. **`server.py` was not modified.**
- Second run: **15 passed.** This is the executable baseline / parity spec.

### FastAPI migration (`server_fastapi.py`, new file)
- Reproduces server.py's contract exactly: same routes, server-side key attachment,
  JSON-vs-binary TTS branch, binary video passthrough, upstream error relay, static
  serving with `/` → index.html, 404 JSON for unknown `/api/*`.
- First parity run: **7 failed, 8 passed.** Investigated: **test harness bug again**,
  not FastAPI — assertions used case-sensitive `Content-Type`, but uvicorn emits
  lowercase `content-type` (HTTP headers are case-insensitive per RFC 9110). The correct
  content types WERE present in every failing case. Fix: case-insensitive header lookup
  in the test client. Neither server modified.
- After fix: **15 passed against FastAPI AND 15 passed against legacy** (same suite).

### Startup / health smoke test (documented command)
- `python -m uvicorn server_fastapi:app --port 3999` (via venv)
  - `GET /api/health` → `{"ok":true,"keyConfigured":true,"apiBase":"https://api.boson.ai/v1"}`
  - `GET /` → index served (11,322 bytes)
  - `GET /api/unknown` → `404`

### Changed / added files
- `server_fastapi.py` (new) — FastAPI proxy.
- `tests/conftest.py`, `tests/http_client.py`, `tests/test_proxy_characterization.py`,
  `tests/__init__.py` (new) — characterization/parity suite + fake Boson upstream.
- `pytest.ini` (new) — test config.
- `requirements-dev.txt` (new) — pinned M0 deps.
- `.venv/` (new, gitignored) — isolated environment.
- **Unchanged:** `server.py`, `server.js`, everything under `public/`, `.env*`.

### Acceptance check (Milestone 0)
- [x] Existing proxy functionality available with compatible request/response behavior (15/15 parity).
- [x] API keys remain server-side (test asserts key never appears in client-visible responses).
- [x] Health and error handling work (health JSON + 404 JSON verified).
- [x] Existing frontend integrations not broken (static serving + all five route groups pass).
- [x] Automated regression tests pass (15/15 on both backends).
- [x] App starts using documented command (uvicorn smoke test).

### Limitations / notes
- `server.js` unverified (Node absent). FastAPI parity is proven only against `server.py`.
- Upstream is mocked at the network boundary; no real Boson calls or credentials were used.
  Live upstream behavior (real status codes, headers, streaming) is NOT exercised by these tests.
- WebSocket Realtime proxying is unchanged in M0 — the browser still connects directly to
  Boson with an ephemeral secret; only the secret-minting REST route is covered here.
- FastAPI re-emits JSON bodies as `application/json` and passes binary through unchanged,
  matching server.py's observable contract (not necessarily byte-identical header sets).

**Stop gate reached. Awaiting review before Milestone 1.**

---

## 2026-10-23 — Phase 1 / Gate G1: Playable lecture

**Authorization:** User authorized Phase 1, Gate G1 only (playable lecture foundation).

### Prerequisite verification
- Re-ran M0 regression suite: **15/15 on FastAPI AND 15/15 on legacy server.py.**
- M0 intact and reproducible; no foundation defect. No M0 code rewritten.

### G1 design decision
- Satisfied "select or load a supported local lecture video" with a **client-side
  local-file** flow (object URL), NOT upload/storage. This needs **zero new deps and
  zero new backend routes** and keeps upload/FFmpeg/DB for G2. A separate `/learn.html`
  page was added so the existing M0 playground UI (`index.html`) is untouched.

### Files added (all new; nothing existing modified except worklog)
- `public/learn.html` — lecture player page (file picker + `<video>` + controls).
- `public/player-core.js` — pure, DOM-free player logic (validation, time format,
  seek/rate clamping, readiness state machine). Testable in isolation.
- `public/learn.js` — DOM wiring: file pick/drop, object URL, real `<video>` events,
  controls, honest error reporting (MediaError codes), state→UI labels.
- `public/learn.css` — player styling (layered over styles.css).
- `tests/player_core.test.mjs` — Node `node:test` unit tests for player-core.js.
- `tests/test_g1_static_assets.py` — backend regression: G1 assets served + M0 intact.

### Commands executed and actual results
- `pytest` (FastAPI): **19 passed** (15 M0 + 4 G1).
- `pytest` (legacy): **19 passed.**
- Live asset serve check (uvicorn on :3998): `/learn.html` 200 text/html, `/learn.js`
  200 text/javascript, `/learn.css` 200 text/css, `/player-core.js` 200 text/javascript.

### Tests written but NOT executed here
- `tests/player_core.test.mjs` (12 JS unit tests) — **not run**: Node.js is not installed
  on PATH or in common locations (verified). The tests exercise the ACTUAL shipped module
  and will run with `node --test tests/player_core.test.mjs` on any machine with Node 18+.
  No Python reimplementation was substituted (that would be dishonest coverage).

### Untested / blocked
- **Real browser playback is NOT automatically verified** — no headless browser available.
  Actual play/pause/seek/speed against a decoded video must be confirmed manually (steps below).
- JS unit tests unexecuted (no Node runtime) — see above.

### Assessment: see chat report for PASS/PARTIAL/BLOCKED.

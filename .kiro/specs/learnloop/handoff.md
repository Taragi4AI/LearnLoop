# LearnLoop — Durable Handoff (LL-G53-FINAL)

**Updated:** 2026-10-23 07:07:59 UTC-04:00
**Branch:** `feature/learnloop-g1` (repo root `E:/higgs_hackathon`; project `Learn_loop/`).
**Git:** baseline commit `20c8e84`; ALL G1–G6 work is UNCOMMITTED on this branch. No commits/pushes/tags were ever made this project.

## Publishing status (added 2026-10-23)
- The original playground monorepo at `E:/higgs_hackathon` (`origin` =
  `Taragi4AI/higgs_api_playground`) also received a local checkpoint commit
  `2019834` on `feature/learnloop-g1` (local only; not pushed) — supersedes the
  "uncommitted" note above for that repo.
- **LearnLoop is now published as a clean standalone repository:**
  - **Remote:** `https://github.com/Taragi4AI/LearnLoop` (private, owner `Taragi4AI`).
  - **Local standalone working copy:** `E:/higgs_hackathon_LearnLoop/` (separate
    from the playground monorepo; fresh independent Git history).
  - **Branch:** `main` → tracks `learnloop/main`.
  - **Published commit SHA:** `9519c1c7121aa0dacea450582fa2c6f1ccffeca9`
    ("feat: LearnLoop … (standalone)"), 65 files.
  - Built via `git archive` of the tracked `Learn_loop/` subtree, so secrets
    (`.env`), venv, `data/` (DB + uploads + extracted audio), caches, and
    wake-word model blobs were excluded. Secret scan clean (placeholders only).
  - Tests on the standalone copy: **97 passed, 7 skipped** (skips need local
    media excluded from the repo).
  - Note: the very first push was rejected because the GitHub repo was created
    with an auto-README (`9280aed`); per explicit approval it was overwritten
    with `--force-with-lease`. The playground repo + its `origin` were untouched.

## Gate status
- **G1 Playable lecture** — PASS (HITL-accepted earlier).
- **G2 Upload/transcribe/persist/search/seek** — PASS (HITL-accepted: A & B checklists).
- **G3.1 Local wake word ("Hey Jarvis")** — WORKS but finicky on laptop mic (speaker bleed). Manual "Activate" is the reliable trigger. Custom "Looper" model NOT built.
- **G3.2 Manual-activation Realtime voice** — code complete; pause-on-activation fixed; live two-way audio HITL-confirmed earlier (heard user + replied); pause confirmed.
- **G4 Grounded conversation** — retrieval + context delivery built & unit/API-verified; Realtime context-race FIXED via manual turns + turn sequencer. Live grounded-answer quality = HITL-pending.
- **G5 MVP completion** — see table; agentic tools + bookmarks implemented.
- **G5.3 Voice orchestration + playback reliability** — audio no-overlap coordinator, verified pause, expanded player controls, full bookmark CRUD. Backend + routes live-verified; audio/voice-tool behavior HITL-pending.
- **G6 live HITL** — checklist prepared; AWAITING user results (not accepted yet).

## G5.3 COMPLETION (2026-10-23 07:07 UTC-04:00): audio no-overlap + bookmark CRUD
Addressed three confirmed defects with the smallest coherent changes (no rewrite):
1. **Audio overlap** — Looper could talk over a playing lecture. Fix: a single-audio
   coordinator in `looper-realtime.js`. The first audio chunk of each response calls
   `beforeAgentAudio()` → host `ensureLecturePausedForSpeech()` which pauses AND verifies
   via the real element (`isPlaying()`). If it can't confirm the lecture is paused, Looper
   audio is SUPPRESSED (never knowingly overlaps) and a visible error shows. Flags reset on
   `response.created`, barge-in (`speech_started`), and `response.done`.
2. **Unreliable pause** — `control_video` pause now uses explicit `player.pause()` +
   verification instead of the state-lagged `togglePlay()`.
3. **No update/rename/delete** — added storage `get/update/delete_bookmark`, routes
   `PATCH`/`DELETE /api/lectures/{id}/bookmarks/{bid}` (both re-export JSON atomically),
   voice tools `update_bookmark`/`delete_bookmark` (+`get_player_state` read tool), and
   UI Rename/Delete per bookmark (prompt/confirm; list refresh only after backend 2xx).
Expanded `control_video` enum: pause/play/resume/rewind/forward/replay/mute/unmute/
volume_up/volume_down/set_volume/set_speed. Player-core gained play/setVolume/getVolume/
setMuted/isMuted/position/rate (no DOM refs; unit-testable).
Live-verified routes (lecture `566779079711`): create→rename(title-only, ts preserved)→
renote(note-only)→blank-title 400→unknown 404→delete(re-exported)→gone from list→unknown
delete 404. Live Looper audio-no-overlap + voice-driven CRUD = HITL-pending (needs
browser+mic+credits).

## G5 CORRECTION (2026-10-23 ~06:10): agentic tool calling added
Earlier "G5" = manual bookmarks only; the real G5 (model-initiated AGENTIC video actions) was
MISSING. Now implemented via Higgs Realtime function tools (verified against
docs/tool-calling): `control_video`, `seek_video`, `prepare_bookmark`, `save_bookmark`,
`list_bookmarks`, `open_bookmark`. Protocol: tools in session.update; on response.done the
host executes client `function_call` items, returns `function_call_output` (echo call_id) +
response.create. Active lecture derived from trusted `currentVideoId` (never the model).
prepare→save is two-step: prepare_bookmark shows a PENDING preview (not persisted); save only
after explicit user approval (Save button) or an explicit save_bookmark on a valid proposal id;
stale/consumed ids rejected. Saving also exports `data/lectures/<id>/bookmarks.json` (atomic).
Live model tool execution = HITL-pending (needs browser+mic+credits); API-level export/list
verified.

## Five mandatory acceptance criteria
| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Process a lecture end-to-end | PASS | Real StatQuest lecture `60fad9f08318`, 265 segments persisted; G2 HITL-accepted. |
| 2 | Timestamped transcript persisted + searchable | PASS | SQLite transcript_segments; `/transcript` + `/search`; tests + G2 HITL. |
| 3 | Search result → seek player | PASS | `/search` returns start/seek; click→seekPlayer; Range-seek fix; G2 HITL (B checklist). |
| 4 | Grounded understanding (lecture vs AI) | PARTIAL / HITL-pending | context_builder + /context (API-verified: 20 bounded segs, guardrails); race fixed; grounded SPOKEN answer needs live HITL. |
| 5 | Save + reopen a bookmark | PASS (API, full CRUD) / HITL-pending (browser UI) | storage + `POST/GET/PATCH/DELETE /api/lectures/{id}/bookmarks`; full lifecycle live-verified (create/rename/renote/delete, ts preserved, JSON re-export); browser save/reopen/rename/delete + voice-driven CRUD need HITL. |

## Automated tests — final (G5.3)
Command: `$env:LEARNLOOP_BACKEND="fastapi"; $env:HF_HUB_DISABLE_SYMLINKS_WARNING="1"; .\.venv\Scripts\python.exe -m pytest -q`
Result: **104 passed** (G1/G2 proxy+assets incl. G5.3 markers, G2.1 extraction, storage incl. bookmark CRUD, lecture routes incl. context + bookmark create/list/update/delete, transcription integration, context_builder, turn_sequencer race, wakeword/realtime gating, frontend import guard).
Note: JS `.mjs` tests (player-core incl. new play/volume/mute/position, search-nav, looper_tools incl. expanded enum + new tools) are written/updated but UNRUN — no Node runtime in this env.

## Files changed in G5.3
- `app/storage.py` — `get_bookmark`, `update_bookmark` (title/note; id+timestamp preserved; blank title rejected), `delete_bookmark`.
- `server_fastapi.py` — `PATCH`/`DELETE /api/lectures/{id}/bookmarks/{bid}` (both re-export bookmarks.json atomically).
- `public/player-core.js` — `play`, `setVolume`/`getVolume`, `setMuted`/`isMuted`, `position`, `rate`.
- `public/looper-realtime.js` — audio coordinator (`gateAndPlay`/`beforeAgentAudio`/suppress-on-no-pause); expanded `control_video` enum; `get_player_state`, `update_bookmark`, `delete_bookmark` tools.
- `public/learn.js` — `ensureLecturePausedForSpeech` (verified pause); rewritten `control_video` executor + `get_player_state`/`update_bookmark`/`delete_bookmark` executors (truthful success); `renameBookmark`/`deleteBookmark` UI; bookmark row restructure.
- `public/learn.css` — `.bm-item`/`.bm-open`/`.bm-actions` row layout.
- tests: `test_storage.py` (+4 CRUD), `test_lecture_routes.py` (+6 route), `test_g1_static_assets.py` (+G5.3 markers), `http_client.py` (+`patch`), `.mjs` updated (unrun).
(Prior sessions: context_builder, turn-sequencer, looper-realtime manual turns, chat export, G5 agentic tools — all intact.)

## HITL results received
NONE yet — G6 checklist below is awaiting the user's consolidated run.

## Known limitations / demo risks
- Wake word unreliable on laptop mic; **demo with the manual "Activate" button**.
- Manual-turn voice adds a brief commit→response latency vs server_vad (deliberate, race fix).
- Grounded-answer quality and historical-timestamp accuracy unverified live.
- `.mjs` JS unit tests unrun (no Node); live Realtime needs Boson credits.
- Bookmarks: full CRUD now (create/list/open/rename/renote/delete) via UI + voice; backend live-verified, browser/voice flows HITL-pending.
- Audio no-overlap: coordinator pauses+verifies before Looper speaks and suppresses audio if it can't; live audio behavior HITL-pending (needs mic + credits).
- ~37 MB wakeword + DB/upload binaries are gitignored; do NOT commit them.

## Launch
```
cd Learn_loop
$env:HF_HUB_DISABLE_SYMLINKS_WARNING="1"
.\.venv\Scripts\python.exe -m uvicorn server_fastapi:app --host 127.0.0.1 --port 3000
```
URL: http://localhost:3000/learn.html  (BOSON_API_KEY already in .env, server-side)

## Next action for a fresh session
1. Collect the user's G6 HITL results; mark criteria 4 & 5 PASS/FAIL accordingly.
2. Fix only mandatory defects surfaced by HITL.
3. Then (separate, NOT started): G7/G8 + post-MVP — see below.

## G7/G8 / post-MVP priorities (NOT started; keep separate from mandatory fixes)
- Wake-word reliability (train real "Looper"; tune VAD; or accept manual).
- Proposal enhancements: 5W2H learning cards, analogies, comprehension questions (Study Pack — NOT started, deferred per G5.3 handoff).
- Export of saved concepts (JSON snapshot already written per-lecture; add a UI export).
- Semantic (vector) transcript search beyond keyword.
- A real commit strategy (all work currently uncommitted).

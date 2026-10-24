# LearnLoop — Implementation Plan

Rules for every task: implement one module at a time, write tests for its acceptance criteria, keep prior milestones working, and do not claim success until tests pass. `[VERIFY]` tasks must complete before their dependents. No dependency installs until the milestone that needs them is approved.

Each milestone ends with a **Test Gate** — the slice is "done" only when the gate passes.

---

## Milestone 0 — Backend foundation (FastAPI absorbs the proxy)

- [ ] 0.1 Stand up a FastAPI app that serves `public/` and ports the existing proxy routes from `server.py` (`/api/health`, `/api/tts/speech`, `/api/voices*`, `/api/videos*`, `/api/realtime/client-secret`) with identical request/response contracts and server-side key attachment.
  - _Requirements: R8.1, R15, R16, R17.1_
- [ ] 0.2 Load `BOSON_API_KEY` from env/`.env` server-side; never expose it. Preserve the existing error-body shape.
  - _Requirements: R17.1_
- [ ] 0.3 Confirm the existing UI (`index.html` + tabs) still loads and `/api/health` reports key status.
  - _Requirements: R14_

**Test Gate 0:** existing playground UI loads under FastAPI; health check and one proxied call (e.g. voices list) behave exactly as before. Node `server.js` untouched.

---

## Milestone 1 — Lecture upload, storage, and immediate playback (preprocessing + persistence)

- [ ] 1.1 Add SQLite + Pydantic models for `Video`, `ProcessingJob` (schema per `data-model.md`).
  - _Requirements: R1.3_
- [ ] 1.2 `POST /api/lectures` — multipart upload with server-side validation (extension, MIME, content sniff, duration) against a configured allow-list; store media under a stable storage key; create `Video{uploaded}`.
  - _Requirements: R1.1, R1.2, R1.3, R17.4_
- [ ] 1.3 `GET /api/lectures`, `GET /api/lectures/{id}`, `GET /api/lectures/{id}/media` (range-capable streaming for playback).
  - _Requirements: R1.4, R1.5_
- [ ] 1.4 Frontend: Upload/Library screen + `player.js` that plays the stored media immediately (before any transcription).
  - _Requirements: R1.4, R2 (base)_

**Test Gate 1:** upload a valid file → it plays immediately; invalid file rejected with reason and no record; library lists status. Unit tests for validation pass.

---

## Milestone 2 — Deterministic local media controls

- [ ] 2.1 `player.js` exposes validated, bounded controls: play, pause, seek, rewind/skip, rate, volume, mute, brightness (CSS filter). All local, no network.
  - _Requirements: R2.1, R2.2, R2.3_
- [ ] 2.2 Controls remain functional with no backend/Realtime connection.
  - _Requirements: R2.4_

**Test Gate 2:** unit tests for bounds/clamp/reject rules; manual + scripted check that every control works offline; out-of-range handled per rule.

---

## Milestone 3 — Audio extraction + STT verification + transcription (Higgs core) `[VERIFY: VG-1]`

- [ ] 3.1 **VG-1 (blocking):** verify Higgs STT 3 batch endpoint, auth, formats, request/response schema, timestamp granularity against official docs + one real call; capture a sanitized fixture; record in `api-notes.md`.
  - _Requirements: R4.1_
- [ ] 3.2 Project-local FFmpeg extraction via arg-array; chunk audio preserving original-timeline offsets; status `uploaded→extracting_audio`.
  - _Requirements: R3.1, R3.2, R3.3, R3.4_
- [ ] 3.3 Background worker transcribes chunks via the verified STT client; persist `TranscriptSegment` with real timing or honest `timing_quality`; never fabricate timestamps; validate bounds.
  - _Requirements: R4.2, R4.3, R4.4_
- [ ] 3.4 `GET /api/lectures/{id}/status` exposes stages + transcript lag; segments appended progressively.
  - _Requirements: R5.1, R5.2, R5.3_

**Test Gate 3:** VG-1 recorded and passing; extraction preserves offsets (unit test on a known clip); a real short lecture produces timestamped segments validated against bounds; playback unaffected during processing. If VG-1 fails, stop and report — do not ship fabricated transcripts.

---

## Milestone 4 — Transcript display, search, timestamp navigation (post-processing)

- [ ] 4.1 `GET /api/lectures/{id}/transcript` (progressive) and `GET /api/lectures/{id}/search?q=` (keyword) returning segments with timestamps/excerpts.
  - _Requirements: R6.2_
- [ ] 4.2 Frontend `transcript.js`: live transcript with current-segment highlight; search UI; select → `player.seek` (R2 rules); present choices when multiple matches.
  - _Requirements: R6.1, R6.3, R6.4_

**Test Gate 4:** search returns real matching segments; selecting a result seeks accurately; multi-match shows choices; "still processing" path shown when unindexed.

---

## Milestone 5 — Bookmarks and notes (persistence slice)

- [ ] 5.1 Models + endpoints: create/list bookmarks and notes; server validates timestamp and segment refs; success only after DB confirmation; retry-safe (no duplicates).
  - _Requirements: R13.1, R13.2, R13.4, R17.4_
- [ ] 5.2 Frontend `bookmarks.js`: create from current position; Saved Concepts view; reopen → seek saved timestamp; evidence vs. AI-added labelling.
  - _Requirements: R13.3, R11.4_

**Test Gate 5:** bookmark persists and reopens to the right timestamp; UI shows success only after confirmed write; retry does not duplicate.

---

## Milestone 6 — Local "Looper" wake word + state machine (two-path invariant)

- [ ] 6.1 Decide wake-word engine (Porcupine Web vs. openWakeWord); spike a built-in phrase first to prove the pipeline, then custom "Looper".
  - _Requirements: R7 (open decision)_
- [ ] 6.2 `wakeword.js`: local detection only; never stream mic while passive; on detect → immediately pause video + capture timestamp.
  - _Requirements: R7.1, R7.2, R17.2_
- [ ] 6.3 `state.js`: implement the diagram's state machine + all UI state labels; graceful degrade to manual activate + text if mic denied or engine unavailable.
  - _Requirements: R7.3, R7.4, R14.1_

**Test Gate 6:** wake word pauses video before any network call; no mic bytes leave the device while passive (verified via network inspection); state labels reflect each transition; mic-denied path falls back to text.

---

## Milestone 7 — Higgs Realtime session, wake-word-gated (Higgs core) `[VERIFY: VG-3]`

- [ ] 7.1 **VG-3:** confirm Higgs Realtime function-call event names/shape against a real session.
  - _Requirements: R10 (wiring prerequisite)_
- [ ] 7.2 `POST /api/realtime/session`: mint secret + return tool schema + session instructions.
  - _Requirements: R8.1_
- [ ] 7.3 Refactor `realtime.js`: start mic **only after** `wake_word_detected`; keep the proven handshake, PCM16 path, `server_vad`, barge-in; on `conversation_end` stop mic, return to passive, keep video paused unless resume/auto-resume.
  - _Requirements: R8.2, R8.3, R8.4, R8.5_

**Test Gate 7:** session opens only after wake word; mic streams only in active mode; barge-in stops playback; ending returns to passive with video paused; disconnect leaves media controls working.

---

## Milestone 8 — Safe tool execution (Agents That Act)

- [ ] 8.1 Define the 12 tools with JSON schemas + validators (shared contract).
  - _Requirements: R10.1, R10.2_
- [ ] 8.2 Media tools dispatch to `player.js` locally; read back real state; return confirmed tool result (success only after confirmation).
  - _Requirements: R10.3, R10.4, R10.5, R2.1_
- [ ] 8.3 Data tools (`search_lecture`, `create_bookmark`, `create_note`, `get_bookmarks`) via backend `/api/tools/*`; return only after real result/DB write.
  - _Requirements: R10.3, R10.5, R13.1_
- [ ] 8.4 Invalid/out-of-bounds args → structured tool error, no state change, ask to rephrase.
  - _Requirements: R10 failure cases_

**Test Gate 8:** "Looper, rewind 20 seconds" seeks and confirms real new position; "bookmark this as X" persists and confirms; malformed/out-of-range tool calls rejected safely; assistant never reports unconfirmed success.

---

## Milestone 9 — Context assembly + injection + grounding (post-processing) `[VERIFY: VG-2]`

- [ ] 9.1 **VG-2 (blocking for live injection):** verify active-session context mechanism/limits/ordering; else fall back to context-in-instructions at turn setup; record in `api-notes.md`.
  - _Requirements: R9.2_
- [ ] 9.2 Context & Retrieval Service: assemble recent window (~30–90s) + retrieved passages + current position + student state; every reference maps to a real segment.
  - _Requirements: R9.1, R9.3_
- [ ] 9.3 Grounding: cite real segment IDs/timestamps; label AI-added context; "no evidence" when transcript doesn't establish an answer; UI distinguishes evidence vs. AI.
  - _Requirements: R11.1, R11.2, R11.3, R11.4_

**Test Gate 9:** VG-2 recorded; answers cite real segments; a question with no supporting passage yields an honest "not established"; context respects verified limits without dropping citations.

---

## Milestone 10 — Text fallback + full E2E hardening

- [ ] 10.1 `/api/tools/*` + a text Q&A path usable without voice; available regardless of Realtime status.
  - _Requirements: R12.1, R12.2_
- [ ] 10.2 Full failure-state pass: processing, connecting, disconnected, muted, errors; every external call has a visible failure state.
  - _Requirements: R14.1, R14.2, R14.3_

**Test Gate 10 (MVP gate):** full E2E — upload → immediate play → background transcription → wake "Looper" → grounded Q&A (voice) → voice media command confirmed → bookmark persists → return to passive. Text fallback performs the same with voice disabled.

---

## Milestone 11 — Higgs TTS explanation loop (planned Higgs core)

- [ ] 11.1 Spoken explanation of an asked/saved concept via Higgs TTS 3 (inline tags where useful); original lecture audio untouched; output labelled AI-generated; not a hard dependency of M1–M10.
  - _Requirements: R15.1, R15.2, R15.3_

**Test Gate 11:** requesting a spoken explanation produces labelled TTS audio; disabling TTS leaves the core loop intact.

---

## Milestone 12 — Higgs Avatar (optional, flagged)

- [ ] 12.1 Behind a flag, create→poll→download a talking-head MP4 for an explanation via the existing job pattern; disabled until M1–M11 work.
  - _Requirements: R16.1, R16.2, R16.3_

**Test Gate 12:** with core working and flag on, an avatar renders for an explanation; flag off leaves everything unaffected.

---

## Cross-cutting (every milestone)
- Preserve the two-audio-path invariant and server-side-only API key.
- Keep media controls + text fallback working whenever voice/API is down.
- Distinguish `[CONFIRMED]` / `[ASSUMPTION]` / `[VERIFY]` in code comments and docs.
- Don't duplicate existing working functionality; reuse `realtime.js` and ported proxy logic.

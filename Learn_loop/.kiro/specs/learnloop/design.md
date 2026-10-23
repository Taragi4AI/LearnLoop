# LearnLoop — Design

## Overview

This design translates the `LearnLoop System Architecture Diagram.png` and the seven source documents into concrete modules, interfaces, and data flows. It preserves the three implementation layers (preprocessing, Higgs core, post-processing) and the seven boundaries the diagram defines: browser media controls, local wake-word detection, background lecture transcription, Higgs Realtime sessions, context retrieval, tool execution, and persistent storage.

**Stack decision (confirmed against the repo):** The existing backend (`server.py` / `server.js`) is a stateless proxy with no storage, uploads, WebSocket server, or jobs. LearnLoop's FastAPI backend therefore *extends* the system and *absorbs* the five proxy routes — it does not replace working functionality. The existing `public/realtime.js` is a working Higgs Realtime client and is reused (refactored), not rewritten.

```
Browser (public/, vanilla JS)
  ├─ Video Player UI ............ deterministic local media controls (no AI)
  ├─ Wake-Word Detector ......... local "Looper" detection; never streams mic while passive
  ├─ Realtime Client ............ mic→Realtime after wake word; tool dispatch; playback
  └─ Transcript/Bookmarks UI .... transcript, search, bookmarks, notes, state labels
            │ HTTP (REST)                     │ WebSocket (Realtime, after wake word)
            ▼                                  ▼
FastAPI Backend (Python)
  ├─ API Gateway/Router ......... auth to Boson, routing, rate-limit, error shape
  ├─ Video Processing Service ... upload, validate, FFmpeg extract, chunk, job status
  ├─ Realtime Session Service ... mint client secret; (verify) context updates; tool bridge
  ├─ Context & Retrieval Service  recent window, search, context assembly
  ├─ Tool Execution Service ..... validate → execute → confirm tool results
  ├─ Boson Proxy ................ absorbs existing /api/tts, /api/voices, /api/videos, /api/realtime
  └─ Background Workers ......... transcription jobs, indexing, retries
            │
            ▼
SQLite (videos, transcript_segments, bookmarks, notes, processing_jobs, learning_session, student_state)
            │
            ▼
External Higgs: STT 3 [verify] · Realtime [confirmed] · TTS 3 [confirmed] · Avatar [confirmed, optional]
```

---

## Layer / module map

### Preprocessing layer
- **Video Processing Service** (backend) — upload handling, server-side validation, FFmpeg extraction (project-local binary, arg-array), chunking with preserved offsets, job lifecycle.
- **Background Workers** (backend) — run transcription jobs, index segments, handle bounded retries. MVP: FastAPI `BackgroundTasks` or a simple in-process worker; upgrade path to a queue if needed.

### Higgs core layer
- **Boson Proxy** — server-side key attachment; absorbs existing routes.
- **STT client** `[VERIFY]` — batch transcription of lecture chunks.
- **Realtime Session Service** — client-secret minting (confirmed) and context/tool bridging (`[VERIFY]` for live context injection).
- **TTS client** — spoken explanations (confirmed).
- **Avatar client** — optional talking-head (confirmed, flagged off).

### Post-processing layer
- **Context & Retrieval Service** — recent window, transcript search, context assembly, student-state read.
- **Tool Execution Service** — typed validation, execution, confirmation.
- **Grounding** — citation assembly, AI-added labelling, "no evidence" handling.

---

## Components and interfaces

### Backend REST API (FastAPI)

Existing proxy routes (ported from `server.py`, unchanged contract):
```
GET    /api/health
POST   /api/tts/speech
POST   /api/voices        GET /api/voices        GET/DELETE /api/voices/{id}
POST   /api/videos        GET /api/videos/{id}   GET /api/videos/{id}/content
POST   /api/realtime/client-secret
```
> Note: existing proxy uses `/api/videos` for **Avatar** jobs. LearnLoop lecture videos use a separate namespace to avoid collision:

New LearnLoop routes:
```
POST   /api/lectures                      # multipart upload → validate → store → Video{uploaded}
GET    /api/lectures                      # list with processing_status
GET    /api/lectures/{id}                 # metadata + status
GET    /api/lectures/{id}/media           # stream video for playback
GET    /api/lectures/{id}/status          # processing stages + transcript lag
GET    /api/lectures/{id}/transcript      # segments (paginated, progressive)
GET    /api/lectures/{id}/search?q=       # keyword search → segments w/ timestamps
POST   /api/lectures/{id}/bookmarks       # create bookmark (server validates ts/segments)
GET    /api/lectures/{id}/bookmarks       # list
POST   /api/lectures/{id}/notes           # create note
GET    /api/lectures/{id}/notes           # list
POST   /api/realtime/session              # mint secret + return tool schema + session instructions
POST   /api/tools/{tool_name}             # server-side tools (search_lecture, create_bookmark, ...)
```

### Typed models (Pydantic) — mirror `data-model.md`
`Video`, `TranscriptSegment`, `Bookmark`, `Note`, `ProcessingJob`, `LearningSession`, `StudentLearningState`. Provider responses are kept separate from canonical schema and validated at runtime.

### Tool interface (shared contract, model-facing)
Exactly the diagram's set. Each tool has a JSON schema, a validator, an executor, and a confirmed result.

| Tool | Args (validated) | Executed by | Confirmation |
|---|---|---|---|
| `pause_video` | — | browser | player.paused === true |
| `resume_video` | — | browser | player.paused === false |
| `seek_to_timestamp` | seconds ≥ 0, ≤ duration | browser | abs(currentTime − target) ≤ tol |
| `seek_relative` | seconds (±) | browser | new position within bounds |
| `set_playback_rate` | rate in allowed set | browser | playbackRate === rate |
| `set_volume` | 0.0–1.0 | browser | volume === level |
| `set_muted` | bool | browser | muted === value |
| `adjust_brightness` | 0.0–1.0 (CSS filter) | browser | filter applied |
| `search_lecture` | query string | backend | returns real segments |
| `create_bookmark` | timestamp, title, note? | backend | DB write confirmed |
| `create_note` | timestamp, text | backend | DB write confirmed |
| `get_bookmarks` | — | backend | returns stored rows |

**Media tools execute in the browser** (R2/R10.4); the Realtime client validates args, performs the action, reads back real player state, and returns the tool result. **Data tools execute on the backend** and return only after DB confirmation.

### Frontend modules (`public/`, vanilla JS)
- **player.js** — wraps `<video>`; exposes validated, bounded control functions; owns real media state.
- **wakeword.js** — local detector (engine TBD: Porcupine Web / openWakeWord); emits `wake_word_detected`; pauses video immediately; never streams mic while passive.
- **realtime.js** *(refactor of existing)* — change: start mic **only after** wake word; register tool definitions in `session.update`; handle `response.function_call*` events; dispatch to player.js (local) or backend `/api/tools/*` (data); return tool outputs. Keep the proven handshake, PCM16 path, barge-in, and waveform code.
- **transcript.js** — progressive transcript render, current-segment highlight, search, seek-on-select.
- **bookmarks.js** — create/list/reopen; success only after server confirmation.
- **state.js** — assistant state machine + UI labels (see below).

---

## Assistant state machine (from diagram panel C)

```
Passive  ──wake_word_detected──▶  WakeDetected ──realtime_connected──▶  Active
  ▲                                   │ (pause video, capture ts)          │
  │                                   │                                    │ user_speech_start
  └──────── conversation_end / realtime_disconnected / error ◀────────────┘ assistant_speaking
                                                                            tool_call → tool_result
```
Events: `wake_word_detected`, `realtime_connected`, `user_speech_start`, `assistant_speaking`, `tool_call`, `tool_result`, `conversation_end`, `realtime_disconnected`, `error`. Each maps to a required UI label (R14).

---

## Data flows (from diagram panel B)

- **HTTP (REST)** — uploads, queries, notes, bookmarks, search.
- **WebSocket (Realtime)** — user audio + events, **only after wake word**.
- **Audio file/chunks → STT** (orange) — lecture-audio path, backend→STT, offsets preserved.
- **Audio stream → Realtime** (pink) — user mic, only in active mode.
- **Context updates → Realtime** (purple) — **`[VERIFY]`** mechanism before wiring.
- **DB read/write** (dashed blue) and **async jobs** (dashed grey).

**Two-path invariant (enforced):** lecture audio never flows over the Realtime mic path; user mic never flows into the STT batch path. They share only the `TranscriptSegment` store and the video timeline.

---

## Verification gates (must pass before dependent code)

### VG-1 — Higgs STT 3 batch contract `[VERIFY → R4]`
Confirm endpoint, auth, accepted formats, request shape, response schema, timestamp granularity via docs + one real call. Capture a sanitized fixture. Record in `api-notes.md`. **Blocks:** R4, R5, R6.

### VG-2 — Realtime active-session context injection `[VERIFY → R9]`
Confirm whether/how transcript + student-state context can be supplied to an *active* session: event name, size limits, ordering vs. tool calls. If unsupported, fall back to context-in-instructions at turn setup. Record in `api-notes.md`. **Blocks:** R9's live-injection path (not R8 or R10).

### VG-3 — Realtime tool-calling event shape `[confirm event names → R10]`
Confirm the exact function-call request/response event names in Higgs' protocol (OpenAI-compatible, but verify against a real session). **Blocks:** R10 wiring.

---

## Error handling and honesty
- Provider schemas validated at runtime; mismatches surfaced, never silently coerced.
- Bounded retries for transient failures only; invalid requests not retried.
- "Success" (tool or persistence) reported only after real confirmation.
- Missing evidence → explicit "transcript does not establish this"; no fabrication.
- Media controls and text fallback remain available when voice/API fails.

---

## Testing strategy
- **Unit:** validation (upload, tool args, timestamp bounds), transcript normalization, state-machine transitions, context-window assembly, citation mapping.
- **Integration (gated):** STT batch (after VG-1), Realtime session + tools (after VG-2/VG-3), with real credentials; mocks clearly labelled otherwise.
- **E2E:** upload → immediate play → background transcription → wake "Looper" → grounded Q&A → voice media command → bookmark persists → return to passive.
- Each milestone ships a working, tested vertical slice; prior slices keep working.

---

## Deployment / project layout (planned, not yet created)
```
server.py (FastAPI app)        # absorbs proxy + new routes
app/ (backend package)         # services, models, workers, boson clients
bin/ or vendor/ffmpeg/         # project-local FFmpeg (gitignored)
data/ (sqlite db, media store) # gitignored
public/ (existing + new JS)    # player, wakeword, realtime(refactor), transcript, bookmarks, state
.kiro/specs/learnloop/         # this spec
```
`server.js` (Node proxy) is retained as reference only; not extended. **Open question:** keep or remove it.

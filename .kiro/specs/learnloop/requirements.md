# LearnLoop — Requirements

## Introduction

LearnLoop is a real-time AI learning companion for lecture videos. A student opens or uploads a lecture, plays it immediately, and lets the system transcribe the lecture audio in the background with timestamps. A local wake-word detector listens for **"Looper"**; only after it fires does the user's microphone stream to a Higgs Realtime session. The assistant answers questions grounded in the real transcript, controls playback through validated tools, and lets the student bookmark and annotate moments for revision.

This document defines testable requirements derived from the seven source documents (`vision.md`, `features.md`, `user-stories.md`, `data-model.md`, `constraints.md`, `ui.md`, `api-notes.md`) and the `LearnLoop System Architecture Diagram.png`. Those remain the source of truth for intended behavior.

### Three implementation layers (preserved throughout)
- **Preprocessing** — upload, validation, FFmpeg audio extraction, chunking, background transcription jobs.
- **Higgs core** — STT 3 (batch lecture transcription), Realtime (wake-word-gated voice session, tool calling), TTS 3 (spoken explanations), Avatar (optional talking-head).
- **Post-processing** — transcript indexing/search, context assembly, grounded answers with citations, bookmarks/notes, learning cards.

### Evaluation alignment (hackathon)
Higgs Audio must be a meaningful part of the experience, not a final TTS layer. Primary track: **Agents That Act** (voice-driven tool calling). Secondary: **Conversation as the Interface**. Optional: **Put a Face to the Voice** (Avatar).

### Capability status legend
- **[CONFIRMED]** — verified against official Boson docs and/or existing working code in this repo.
- **[ASSUMPTION]** — asserted by the architecture diagram or source docs but not yet verified; must be verified before the dependent code is written.
- **[VERIFY]** — explicit verification gate required before implementation.

---

## Confirmed vs. assumed capabilities

| Capability | Status | Basis |
|---|---|---|
| Realtime full-duplex over WebSocket, PCM16 @ 24kHz, `server_vad`, barge-in | **[CONFIRMED]** | Official docs + working `public/realtime.js` |
| Realtime ephemeral client-secret handshake (key stays server-side) | **[CONFIRMED]** | Docs + `server.py` / `server.js` + `realtime.js` |
| Realtime tool calling (JSON-schema function tools, mid-conversation) | **[CONFIRMED]** | Official Realtime overview |
| Realtime live input transcription via `higgs-stt-3.1` | **[CONFIRMED]** | Official docs + `realtime.js` session config |
| Higgs STT 3 batch file transcription with timestamps (WAV/MP3/FLAC) | **[ASSUMPTION]** | api-notes.md + diagram; exact endpoint/schema unverified |
| Higgs TTS 3 speech, inline tags, word-level timestamps, streaming | **[CONFIRMED]** | Official docs + existing `/api/tts/speech` proxy |
| Higgs Avatar async video jobs (POST/poll/download) | **[CONFIRMED]** | Official docs + existing `/api/videos` proxy |
| **Pushing transcript/student-state context updates INTO an active Realtime session** | **[VERIFY]** | Diagram asserts it; **not** confirmed by docs. Gate before Context→Realtime wiring. |
| Realtime accepts arbitrary mid-session text/context injection mechanism and limits | **[VERIFY]** | Must confirm event name, size limits, ordering vs. tool calls |

---

## Requirements

### R1 — Video upload, validation, and immediate playback
**User story:** As a student, I want to upload or select a lecture and start watching immediately, so that I do not wait for preprocessing.

#### Acceptance criteria
1. WHEN a user uploads a file THEN the backend SHALL validate extension, MIME type, real content, and duration server-side against a configured allow-list before accepting it.
2. WHEN a file fails validation THEN the system SHALL reject it with a safe, specific error and SHALL NOT store it.
3. WHEN a valid file is accepted THEN the system SHALL persist a `Video` record (id, title, original_filename, storage_key, processing_status=`uploaded`, created_at) and store the media under a stable storage key, never exposing raw filesystem paths.
4. WHEN a stored video exists THEN the player SHALL be able to begin playback before transcription is complete.
5. WHEN the library is opened THEN the system SHALL list available videos with their current processing status.

#### Failure cases
- Unsupported format / oversized / over-duration file → rejected with reason; no partial record.
- Storage write failure → no `Video` row is created; user sees a retryable error.

---

### R2 — Deterministic, local browser media controls
**User story:** As a student, I want playback controls that respond instantly, so that control never depends on the network or an LLM.

#### Acceptance criteria
1. WHEN a user invokes play, pause, seek, rewind/skip, playback speed, volume, mute, or brightness THEN the browser SHALL execute it locally without any server or LLM round trip.
2. WHEN brightness is adjusted THEN it SHALL be a visual filter on the video element, documented as not changing physical display brightness.
3. WHEN playback rate, volume, brightness, or seek target are set THEN the client SHALL validate them against defined bounds before applying.
4. IF Higgs Realtime is disconnected THEN all media controls SHALL remain fully functional.

#### Failure cases
- Out-of-range value → clamped only if a clamp rule is defined; otherwise rejected with a validation error, no state change.
- Media not ready to seek → report failure, do not claim the seek succeeded.

---

### R3 — Background audio extraction (preprocessing)
**User story:** As a student, I want lecture audio processed in the background, so that playback is never blocked.

#### Acceptance criteria
1. WHEN a video is accepted THEN a background job SHALL extract audio using a project-local FFmpeg binary invoked via an argument array (never shell-interpolated).
2. WHEN audio is extracted THEN the pipeline SHALL preserve exact offsets to the original video timeline.
3. WHEN extraction runs THEN playback SHALL remain available and `processing_status` SHALL progress `uploaded → extracting_audio`.
4. WHEN audio is chunked for transcription THEN each chunk SHALL carry its start offset in original-video seconds.

#### Failure cases
- FFmpeg missing/not executable → job fails with a clear error; playback remains usable; retry offered.
- Corrupt media → extraction fails safely; status set to `failed` with a safe `processing_error_code`.

---

### R4 — Lecture transcription via Higgs STT 3 (Higgs core) **[ASSUMPTION → VERIFY]**
**User story:** As a student, I want the lecture transcribed with timestamps, so that I can search and jump to passages.

#### Acceptance criteria
1. **[VERIFY]** BEFORE implementation, the exact STT 3 endpoint, auth, accepted audio format(s), request shape, response schema, and timestamp granularity SHALL be verified against current official docs and one real test call, and recorded in `api-notes.md`.
2. WHEN a chunk is transcribed THEN the system SHALL persist `TranscriptSegment` rows (video_id, start_time, end_time, text, source, timing_quality, language) mapped to the original video timeline.
3. WHEN the STT response supplies timing THEN segments SHALL use it; IF timing is absent THEN the system SHALL NOT fabricate timestamps and SHALL mark `timing_quality` accordingly and disable exact-seek claims for those segments.
4. WHEN segments are stored THEN each SHALL satisfy `start_time >= 0`, `end_time >= start_time`, and `end_time <= duration` (within documented tolerance) when duration is known.

#### Failure cases
- STT auth/schema mismatch at verification → block R4 implementation; record the gap; do not ship fabricated data.
- Per-chunk transcription failure → mark that chunk's job `failed` with bounded retry; other chunks proceed.

---

### R5 — Progressive context and transcript lag
#### Acceptance criteria
1. WHEN new segments become available THEN they SHALL be appended and indexed incrementally while playback continues.
2. WHEN the workspace is shown THEN the UI SHALL expose current video timestamp and transcript-processing lag.
3. The system SHALL mark transcript processing "complete" only when configured readiness criteria are met, and SHALL NOT imply the latest speech is already transcribed.

#### Failure cases
- Indexing behind playback → UI discloses lag; answers use only available evidence.

---

### R6 — Transcript display, search, and timestamp navigation (post-processing)
#### Acceptance criteria
1. WHEN transcript exists THEN the UI SHALL display it with the current segment highlighted.
2. WHEN a user searches THEN the system SHALL return matching segments with timestamps and excerpts (keyword match for MVP; vector search optional later).
3. WHEN a user selects a segment or search result THEN the player SHALL seek to that segment's source timestamp (R2 rules apply).
4. WHEN multiple passages may match THEN the UI SHALL present choices rather than silently picking one.

#### Failure cases
- Relevant passage not yet indexed → report "still processing," allow retry.

---

### R7 — Local "Looper" wake-word detection (two audio paths)
**User story:** As a student, I want to say "Looper" to wake the assistant, without my mic being streamed while passive.

#### Acceptance criteria
1. WHILE in passive mode THE local detector SHALL process microphone audio in the browser only and SHALL NOT stream microphone audio to any server.
2. WHEN "Looper" is detected THEN the client SHALL immediately pause the video and capture the current timestamp before any network activity.
3. WHEN the wake word fires THEN the client SHALL transition to the active-assistant state and begin the Realtime connection sequence.
4. The UI SHALL always show a clear state: passive-listening, connecting, active-listening, assistant-speaking, muted, disconnected.
5. Lecture-audio processing (R3/R4) and user-microphone conversational input (R8) SHALL remain separate pipelines at all times.

#### Failure cases
- Microphone permission denied → show guidance, offer text input (R12); remain in passive/text mode.
- Wake-word engine unavailable → degrade to a manual "activate" control and text input; disclose that voice wake is off.

> **Open decision:** wake-word engine. Candidates: Porcupine Web (custom "Looper", in-browser WASM, commercial free tier) vs. openWakeWord (open, WebGPU). A built-in phrase may be used to prove the pipeline before a custom "Looper" model is trained. ("Athena" was evaluated and rejected — it is an STT engine / full assistant, not a browser wake-word library.)

---

### R8 — Higgs Realtime session, wake-word-gated (Higgs core)
**User story:** As a student, I want to talk to Looper after waking it, so that I get spoken, grounded help.

#### Acceptance criteria
1. WHEN entering active-assistant mode THEN the backend SHALL mint a short-lived Realtime client secret; the long-lived API key SHALL NEVER reach the browser. **[CONFIRMED]**
2. WHEN the session opens THEN the client SHALL start microphone streaming ONLY THEN (not before wake-word activation). *(Refactor of existing `realtime.js`, which currently starts mic on connect.)*
3. WHEN the user speaks THEN the session SHALL use `server_vad` turn detection and SHALL support barge-in (interruption stops playback mid-utterance). **[CONFIRMED]**
4. WHEN the user speech ends THEN the assistant SHALL respond using audio output (PCM16 @ 24kHz) and a streaming transcript. **[CONFIRMED]**
5. WHEN the conversation ends THEN microphone streaming SHALL stop and the client SHALL return to passive mode; the video SHALL remain paused unless the user requests resume or has enabled auto-resume.

#### Failure cases
- Secret mint fails → voice unavailable; text controls preserved (R12); clear error.
- WebSocket error/disconnect → media controls remain (R2); UI shows `disconnected`; reconnection follows verified behavior.

---

### R9 — Context assembly and injection into the session (post-processing) **[VERIFY]**
**User story:** As a student, I want Looper to answer using what the lecture actually said near where I am.

#### Acceptance criteria
1. WHEN a user turn begins THEN the Context & Retrieval service SHALL assemble: the recent transcript window (~30–90s), relevant retrieved historical passages, the current video position, and relevant student state.
2. **[VERIFY]** BEFORE implementing context→Realtime wiring, the mechanism, event name, size limits, and ordering for supplying this context to an *active* Realtime session SHALL be verified against official docs and a real integration test, and recorded in `api-notes.md`. IF live mid-session injection is not supported THEN the design SHALL fall back to supplying context via session instructions at turn setup and/or a verified alternative, and this requirement SHALL be updated.
3. WHEN context is assembled THEN every transcript reference it contains SHALL map to a real stored `TranscriptSegment`.

#### Failure cases
- Context exceeds verified limits → truncate by recency/relevance with disclosure; never drop citations silently.
- No supporting passage exists → the assistant SHALL state the transcript does not establish the answer (see R11).

---

### R10 — Safe tool execution (Agents That Act)
**User story:** As a student, I want voice commands to actually control the app, reliably.

#### Acceptance criteria
1. The system SHALL expose exactly this tool set to the model: `pause_video`, `resume_video`, `seek_to_timestamp(seconds)`, `seek_relative(seconds)`, `set_playback_rate(rate)`, `set_volume(level)`, `set_muted(muted)`, `adjust_brightness(level)`, `search_lecture(query)`, `create_bookmark(timestamp, title, note)`, `create_note(timestamp, text)`, `get_bookmarks()`.
2. WHEN the model requests a tool THEN the app SHALL validate arguments against a typed schema BEFORE executing.
3. WHEN a tool executes THEN the app SHALL perform the action, confirm the actual result (e.g., the player's real new position), and ONLY THEN return a tool result to the model.
4. Media-control tools SHALL execute locally in the browser (R2) and SHALL NOT depend on an LLM round trip for the action itself.
5. WHEN a tool result is returned THEN the assistant SHALL report success ONLY after confirmed execution.

#### Failure cases
- Invalid/malformed/out-of-bounds arguments → reject safely, return a structured tool error, ask the user to rephrase; no state change.
- Action cannot complete (e.g., media not seekable, DB write fails) → return failure; assistant does not claim success.

---

### R11 — Grounding and honest behavior
#### Acceptance criteria
1. WHEN the assistant makes a lecture-specific claim THEN it SHALL cite actual `TranscriptSegment` IDs/timestamps.
2. WHEN the assistant adds explanation beyond the transcript THEN it SHALL label it as AI-added context.
3. WHEN evidence is missing THEN the assistant SHALL say so and SHALL NOT fabricate transcript text, timestamps, tool results, or successful actions.
4. The UI SHALL visually distinguish transcript evidence from AI-added explanation.

---

### R12 — Text fallback
#### Acceptance criteria
1. WHEN voice or a voice API is unavailable THEN the user SHALL be able to type questions and commands and receive the same grounded answers and tool actions.
2. Text fallback SHALL remain available at all times, independent of Realtime status.

---

### R13 — Bookmarks and notes (persistence)
**User story:** As a student, I want to save a moment with a note and return to it later.

#### Acceptance criteria
1. WHEN a bookmark is created THEN the system SHALL capture the actual current timestamp and relevant `segment_ids`, and persist `Bookmark` (video_id, timestamp_seconds, title, transcript_excerpt?, segment_ids?, note?, generated_explanation?, created_at, updated_at).
2. WHEN a bookmark/note is created THEN the UI SHALL show success ONLY after the database confirms the write.
3. WHEN a saved concept is reopened THEN selecting it SHALL return to the same lecture and seek to the saved timestamp.
4. Any `generated_explanation` SHALL be stored and displayed as AI-added, labelled as such.

#### Failure cases
- Persistence failure → show error, allow retry, and SHALL NOT create duplicate bookmarks on retry.

---

### R14 — Clear states and recovery (cross-cutting)
#### Acceptance criteria
1. The UI SHALL represent: loading, processing (per stage), passive-listening, connecting, active-listening, assistant-speaking, success, failure, muted, and disconnected.
2. Every external call and tool SHALL have a visible failure state.
3. Tool/action success SHALL be shown only after real confirmation (ties to R10.5, R13.2).

---

### R15 — Higgs TTS explanation loop (Higgs core, planned — not optional)
**User story:** As a student, I want Looper to speak a concise explanation of a saved or asked-about concept.

#### Acceptance criteria
1. WHEN the student requests a spoken explanation THEN the system SHALL synthesize it via Higgs TTS 3, using inline tags where helpful, and SHALL keep the original lecture audio available/untouched. **[CONFIRMED proxy exists]**
2. WHEN TTS output is presented THEN it SHALL be clearly labelled as AI-generated speech.
3. TTS SHALL NOT be a hard dependency of R1–R14; the core loop SHALL function if TTS is unavailable.

---

### R16 — Higgs Avatar (optional, after core works)
#### Acceptance criteria
1. Avatar SHALL remain disabled/behind a flag until R1–R15 are demonstrably working.
2. WHEN enabled THEN the system SHALL create an async video job, poll status, and download the MP4 using the existing verified job pattern. **[CONFIRMED proxy exists]**
3. Avatar SHALL NOT manage conversation; it renders a talking-head for a given explanation only.

---

### R17 — Security, privacy, and secrets (cross-cutting)
#### Acceptance criteria
1. The Boson API key SHALL be read from environment/secret config server-side and SHALL NEVER appear in frontend code or commits.
2. In passive mode the microphone stream SHALL NOT leave the device (ties to R7.1).
3. Raw microphone audio SHALL NOT be retained unless explicitly needed and disclosed.
4. The backend SHALL validate all video IDs, tool inputs, and file operations even in single-user mode.
5. External-call retries SHALL be bounded and limited to transient failures.

---

## Non-functional requirements
- **Stack:** Python + FastAPI backend (absorbing the existing proxy routes), existing vanilla-JS `public/` frontend (no React/Next). SQLite for MVP persistence. FFmpeg confined to the project folder.
- **Performance:** playback starts without full transcription; media controls local; wake-word local; pause-on-wake precedes Realtime connect. Numeric latency targets set after the first working prototype, not guessed.
- **Deployment:** local dev / hackathon demo, desktop browser; single-user (no auth for local demo, but inputs still validated).
- **Do not duplicate** existing working functionality; reuse the proven `realtime.js` handshake and the proxy logic from `server.py`.

---

## Traceability (requirements ↔ source features)
| Req | Source features |
|---|---|
| R1 | F01 |
| R2 | F02 |
| R3 | F03 |
| R4 | F04, F05 |
| R5 | F06 |
| R6 | F07, F08 |
| R7 | F09 |
| R8 | F10 |
| R9 | F11 |
| R10 | F12 |
| R11 | F15 |
| R12 | F16 |
| R13 | F13 |
| R14 | F14 |
| R15 | F23 (promoted from stretch) |
| R16 | F24 (optional) |
| R17 | constraints.md (privacy/security) |

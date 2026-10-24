# LearnLoop — User Stories and Flows

## Story 1: Watch while LearnLoop builds context
**As a student**, I want to start watching a lecture immediately while it is being transcribed, so that I do not wait for a long preprocessing job.

### Happy path
1. Student opens the portal and selects/uploads a video.
2. App validates the file and shows the video player.
3. Playback can start while a background job extracts audio and starts transcription.
4. UI shows processing status and transcript lag.
5. Timestamped segments appear progressively and become searchable.
6. App marks transcript processing complete only when the configured readiness criteria are met.

### Failure case
If extraction or transcription fails, playback remains usable. The UI shows the failure, offers retry where safe, and never claims the transcript is ready.

## Story 2: Wake the assistant and ask about the lecture
**As a student**, I want to say “Looper” and ask a question about what was just said, so that I can get help without manually searching.

### Happy path
1. Student watches the video.
2. Local wake-word detector processes microphone audio locally.
3. On detecting “Looper,” the browser pauses the video immediately and records the current video timestamp.
4. The app activates conversational microphone streaming and connects to Higgs Realtime.
5. The context builder supplies the latest available transcript segments, relevant retrieved history, current timestamp, and relevant student state using documented mechanisms.
6. Student asks: “Explain that last concept with an example.”
7. The agent answers using available evidence, cites transcript segments, and labels any supplementary explanation.
8. The student can ask a follow-up, bookmark the moment, or request a replay.
9. Conversation ends; conversational microphone streaming stops and the app returns to passive lecture mode. Video stays paused unless the student asks to resume or has explicitly enabled auto-resume.

### Failure cases
- Microphone permission denied: show instructions and offer text input.
- Realtime connection fails: preserve text controls and explain voice is unavailable.
- Transcript is behind playback: answer only from available evidence, disclose uncertainty, and optionally process the recent audio window.
- No supporting passage exists: say the transcript does not establish the answer; do not invent what the lecturer said.

## Story 3: Control playback by voice
**As a student**, I want to control playback with natural speech, so that I can focus on learning instead of operating controls manually.

### Happy path
1. Student says “Looper, rewind 20 seconds.”
2. Browser pauses on wake-word detection.
3. Higgs Realtime interprets the request and requests a typed tool call.
4. Application validates the requested offset and executes the seek in the browser.
5. Browser confirms the actual new position.
6. Agent confirms success only after execution is confirmed.

### Failure cases
- Requested time is outside the video duration: clamp only if that behavior is defined; otherwise return a clear validation error.
- Browser cannot seek because media is not ready: report failure, do not claim success.
- Tool call is malformed: reject it safely and ask the user to rephrase.

## Story 4: Save a concept for revision
**As a student**, I want to bookmark a lecture moment with a note, so that I can return to it later.

### Happy path
1. Student says “Looper, bookmark this as regularisation.”
2. The app captures the actual current timestamp and relevant transcript segment IDs.
3. Backend validates the video and timestamp and stores the bookmark.
4. The app shows success only after the database confirms the write.
5. Student can reopen the bookmark and jump to the saved timestamp.

### Failure case
If persistence fails, show an error and allow retry without creating duplicate bookmarks.

## Story 5: Ask about an earlier concept
**As a student**, I want to ask where a concept was introduced earlier in the lecture, so that I can revisit the original explanation.

### Happy path
1. Student activates “Looper” and asks: “Where was regularisation introduced?”
2. App searches indexed transcript segments.
3. Agent receives real matches with timestamps and excerpts.
4. App displays candidate results and allows the student to select one.
5. Selecting a result seeks the video to the exact stored timestamp.

### Failure case
If indexing has not reached the relevant passage, report that the transcript is still processing and allow retry later.

## Cross-cutting acceptance rules
- Browser media commands execute locally and do not depend on an LLM round trip.
- Passive mode never streams the user's microphone to the server.
- The lecture-audio pipeline and user-microphone pipeline remain separate.
- Every transcript reference maps to a real stored segment.
- All external calls and tools have visible failure states.

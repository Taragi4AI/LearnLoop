# LearnLoop — Non-Functional Requirements and Constraints

These are MVP defaults, not claims about the current repository. Kiro must inspect the repository and preserve existing valid decisions.

## Deployment and runtime
- Initial target: local development and hackathon demo.
- Deployment target beyond local demo: undecided.
- Primary device: desktop browser.
- Mobile browser support: not required for the first MVP unless the existing project already supports it.
- Use the repository's current framework and language; do not rewrite the stack without a documented reason.

## Users and authentication
- MVP: single-user experience.
- Full login/authentication: not required for a local demo.
- Backend must still validate video IDs, tool inputs, and file operations.
- If hosted or multi-user deployment is introduced, add authentication, authorization, per-user data isolation, and secure file access before exposing user data.

## Persistence
- Persistence is required for transcript segments, bookmarks, and notes.
- SQLite is the default for a local MVP if no database already exists.
- Uploaded video and extracted audio should be stored separately with stable storage keys.
- Do not rely on in-memory-only state for bookmarks or transcript data.
- Temporary audio buffers should be short-lived and cleared when no longer needed.

## Performance and responsiveness
- Video playback must begin without waiting for full transcription.
- Browser media controls must execute locally without an LLM/network round trip.
- Wake-word detection should run locally where feasible.
- On wake-word detection, pause the video immediately before waiting for Realtime connection.
- Expose transcription lag and do not imply that the latest speech is already transcribed.
- Measure and report time to first assistant response, transcript lag, tool execution latency, and seek accuracy.
- Exact numeric latency targets should be set after measuring the first working prototype rather than guessed.

## API costs, limits, and reliability
- Read credentials from environment variables or an approved secrets mechanism.
- Never expose API keys in frontend code or commit them.
- Verify current endpoint schemas, accepted audio formats, limits, quotas, and pricing from official documentation and actual test calls.
- Use bounded retries for transient failures; do not retry invalid requests indefinitely.
- Keep text controls available when voice APIs fail.
- Do not claim success until a provider response or local action has been validated.

## Audio and privacy
- Separate lecture audio from the user's microphone audio.
- In passive mode, the wake-word detector may process microphone samples locally; do not stream the user's microphone to a server before wake-word activation.
- Show a clear microphone/listening indicator and provide mute and push-to-talk controls.
- Do not retain raw microphone audio unless explicitly needed and clearly disclosed.
- Lecture audio processing must preserve offsets to the original video timeline.
- Do not fabricate timestamps if the STT response lacks timing data.

## Supported media
- Accept only explicitly configured and tested video formats and size/duration limits.
- Validate extension, MIME type, file content, and media duration server-side.
- Use FFmpeg safely via argument arrays, not shell-interpolated commands.
- The STT intermediate audio format and endpoint constraints must be recorded in `api-notes.md` after verification.

## Browser controls
- Implement playback, pause, seek, rate, volume, mute, and brightness through the actual player/application.
- Brightness may be implemented as a visual filter; document that it does not change physical display brightness.
- Validate rate, volume, brightness, and timestamp bounds.
- The application—not the LLM—owns actual media state and confirms command results.

## Grounding and quality
- Every lecture-grounded answer must cite actual transcript segments.
- Clearly label supplemental AI-generated explanation.
- If evidence is missing, say so.
- Never fabricate transcript text, timestamps, tool results, or successful actions.
- Use a small explicit tool set; no multi-agent framework for MVP.

## Testing
- Unit tests for data validation, transcript normalization, tool validation, and state transitions.
- Integration tests for actual STT and Realtime when credentials are configured.
- End-to-end test for upload/play, background transcription, wake word, Q&A, media control, bookmark persistence, and return to passive mode.
- Clearly distinguish real integrations from mocks in documentation and demos.

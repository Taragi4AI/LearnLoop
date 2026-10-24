# LearnLoop — Higgs API Notes

**Status:** Integration checklist. Confirmed application contracts must be updated from current official docs and actual test calls. Do not treat unverified items as facts.

## Official references supplied with the project
- Higgs Realtime overview: https://docs.boson.ai/models/higgs-realtime/overview
- Higgs TTS overview: https://docs.boson.ai/models/higgs-tts/overview
- Higgs Avatar overview: https://docs.boson.ai/models/higgs-avatar/overview
- Boson AI hackathon: https://www.boson.ai/hackathon?referrer=luma

Additional references in the technical team guide:
- Higgs STT 3: https://www.boson.ai/blog/higgs-stt-3
- Higgs Realtime tutorial: https://www.boson.ai/blog/higgs-realtime-tutorial
- Hackathon context: https://www.boson.ai/blog/mscac-higgs-audio-hackathon-2026

## Higgs STT 3
Project requirement:
- Use the documented file-transcription interface for initial implementation.
- The published Higgs STT 3 example is referenced in project planning as supporting common audio formats including WAV, MP3, and FLAC and an automatic-language option. Verify this against the current official endpoint reference before relying on it.
- WAV is the canonical intermediate format chosen by LearnLoop, subject to endpoint verification.
- Do not assume sample rate, channel count, maximum duration, request size, exact multipart field names, response schema, or timestamp granularity without verifying the current endpoint documentation and a real response.

Record after verification:
- API base URL:
- Endpoint:
- HTTP method:
- Authentication header:
- Multipart file field:
- Language parameter and accepted values:
- Supported audio formats:
- Maximum file size/duration:
- Sample-rate/channel requirements:
- Request timeout:
- Response schema:
- Transcript timing granularity:
- Rate limits/pricing:
- Sanitized response fixture path:
- Date verified:

## Higgs Realtime
Project requirement:
- Use Realtime for user-directed conversation after local wake-word detection.
- Keep lecture audio processing and user-microphone conversational input as distinct sources.
- Browser media controls are executed by LearnLoop tools, not directly by the model.
- Supply recent transcript, retrieved historical passages, current video position, and relevant student context through documented supported mechanisms.
- Do not assume arbitrary background text can be injected into an active session. Verify whether and how context updates are supported.

Record after verification:
- Connection method:
- Endpoint:
- Authentication/session setup:
- Supported input audio formats and encoding:
- Audio chunk/protocol requirements:
- Output audio format:
- Event types and ordering:
- Turn detection:
- Interruption/cancellation mechanism:
- Text/context input mechanism:
- Tool/function calling schema:
- Tool result return mechanism:
- Session context limits:
- Reconnect behavior:
- Rate limits/pricing:
- Minimal integration test result:
- Date verified:

## Higgs TTS — stretch feature
Do not make TTS a dependency of the core MVP. If added, verify:
- Endpoint and authentication.
- Accepted text and language options.
- Voice/style controls.
- Output format and streaming behavior.
- Limits, latency, and cost.
- Whether generated speech is clearly labelled as synthetic.

## Higgs Avatar — stretch feature
Not required for the MVP. Verify input/output requirements and latency before considering integration. Do not assume an avatar provides persistent bidirectional conversation.

## Integration rules
- All API secrets remain server-side.
- Pin/document SDK versions.
- Capture sanitized fixtures from real responses.
- Validate provider response schemas at runtime.
- Use bounded retries only for transient failures.
- Never log credentials or unnecessary raw audio.
- Distinguish `verified`, `unverified`, and `not supported` for every integration claim.

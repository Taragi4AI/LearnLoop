# LearnLoop — Ranked MVP Features

Priority definitions:
- **must-have**: required for a credible MVP.
- **should-have**: add after the must-have path is stable.
- **nice-to-have**: stretch only if time remains.

## Must-have

| ID | Feature | Description | Higgs dependency | Dependencies |
|---|---|---|---|---|
| F01 | Video load and playback | Open/upload one supported lecture and play immediately. | None / UI only | File validation and storage |
| F02 | Deterministic media controls | Pause, resume, seek, rewind/skip, playback speed, volume, mute, brightness. | None / UI only | F01 |
| F03 | Background audio extraction | Extract audio without blocking playback; preserve original video timeline. | None | F01, FFmpeg |
| F04 | Real transcription | Transcribe lecture audio using Higgs STT 3 through the verified documented interface. | Higgs STT 3 | F03, credentials, API contract verification |
| F05 | Timestamped transcript model | Store transcript segments with source, video ID, start/end seconds, text, and timing quality. Never fabricate timestamps. | STT output may supply timing; otherwise validated alignment method | F04 |
| F06 | Progressive lecture context | Append new segments as they become available and expose transcript lag. | STT | F03–F05 |
| F07 | Transcript display and search | Show transcript and find passages using full-text search. | None | F05 |
| F08 | Timestamp navigation | Selecting a segment or search result seeks the video to its source timestamp. | None | F02, F05, F07 |
| F09 | Local “Looper” wake-word | Detect wake word locally while in passive mode; do not stream user mic to server until activated. | None for detection | Microphone permission, wake-word engine |
| F10 | Higgs Realtime session | Active conversational audio session after wake-word detection, using documented protocol. | Higgs Realtime | F09, verified API contract |
| F11 | Context-grounded Q&A | Answer using recent transcript, retrieved older passages, and relevant student state. | Higgs Realtime and/or verified LLM API | F05–F07, context builder |
| F12 | Safe tool execution | Voice agent requests typed tools; app validates, executes, and confirms actual results. | Realtime tool/function calling if supported | F02, backend tool layer |
| F13 | Bookmarks and notes | Save video, timestamp, concept, transcript excerpt/source, note, and creation time; reopen later. | None | F01, database |
| F14 | Clear states and recovery | Show loading, processing, listening, speaking, success, failure, mute, and disconnected states. | None | All features |
| F15 | Grounding and honest behavior | Cite actual segment IDs/times; label supplemental explanations; admit missing evidence. | LLM | F11 |
| F16 | Text fallback | Allow typed questions/commands when voice or API is unavailable. | None required | F07, F11 |

## Should-have

| ID | Feature | Description | Higgs dependency | Dependencies |
|---|---|---|---|---|
| F17 | Recent audio context buffer | Keep a short rolling window of lecture audio with offsets for transcription catch-up or targeted processing. | STT or supported audio processing | F03–F06 |
| F18 | Semantic search | Retrieve conceptually related passages beyond keyword matches. | None necessarily; embedding model/provider | F07 |
| F19 | Topic summaries | Maintain compact incremental summaries of covered concepts. | LLM | F06, F11 |
| F20 | Interruption and follow-up handling | Support interruption of assistant speech and references such as “the second result.” | Higgs Realtime | F10–F12 |
| F21 | Learning card | Generate concise 5W2H explanation, analogy/example, and check question with source references. | LLM | F11 |
| F22 | Reopen saved concepts | Revision view for saved bookmarks, notes, and learning cards. | None | F13 |

## Nice-to-have / stretch

| ID | Feature | Description | Higgs dependency |
|---|---|---|---|
| F23 | Generated spoken explanation | Speak a verified transcript/explanation. Keep original audio available. | Higgs TTS |
| F24 | Avatar | Talking-head output for assistant responses. | Higgs Avatar |
| F25 | Quiz generation | Generate questions grounded in selected lecture segments. | LLM |
| F26 | Advanced personalization | User-controlled learning preferences and longer-term review suggestions. | LLM optional |
| F27 | Frame/image understanding | Analyze video frames when visual context is needed. | Separate vision-capable model; not assumed to be Higgs Realtime |

## Cut line for the first release
Do not delay the MVP for avatar, TTS, advanced semantic search, quizzes, multi-user collaboration, or advanced personalization. Do not require full-lecture preprocessing before playback. Do not assume Higgs Realtime automatically sees the video or ingests its audio; audio/context must be supplied through verified supported interfaces.

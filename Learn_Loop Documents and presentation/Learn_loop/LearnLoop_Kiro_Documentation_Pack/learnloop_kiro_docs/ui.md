# LearnLoop — UI / UX Specification

## Overall principle
The video is the primary object. Transcript, search, and assistant panels should be available alongside it. The student should not need to understand the internal agent architecture.

## Screen 1: Upload / Library
Required elements:
- Drag-and-drop upload area and file picker.
- List of recent or available lectures.
- Supported file formats and configured size/duration limits.
- Per-video processing state: uploaded → extracting audio → transcribing → aligning timestamps (if needed) → indexing → ready.
- Clear retry/error state.
- The video must be playable before transcription is complete.

## Screen 2: Lecture Workspace
Suggested desktop layout:
- Main/left: video player and media controls.
- Adjacent panel: transcript, current-segment highlight, and search results.
- Right or lower panel: conversation history, question input, and answer evidence.
- Bottom or side section: bookmarks and notes.

Required controls:
- Play/pause, seek, rewind/skip, playback speed, volume, mute, brightness.
- Search transcript.
- Text question input as fallback.
- Wake-word state indicator for “Looper”.
- Microphone mute and push-to-talk.
- Clear state labels: passive listening for wake word, connecting, active listening, assistant speaking, muted, disconnected.
- Current video timestamp and transcript-processing lag.

## Screen 3: Saved Concepts
Each saved concept should show:
- Title.
- Source lecture.
- Timestamp or time range.
- Actual transcript excerpt when available.
- Student note.
- Optional AI explanation, visibly labelled as AI-added.
- Open/replay action.

## Navigation
- Upload/library → lecture workspace.
- Lecture workspace → saved concepts.
- Selecting a search result, transcript segment, or bookmark returns to the same lecture and seeks the player.
- Keep the current video and playback state when opening/closing supporting panels where feasible.

## Interaction rules
- On local wake-word detection, pause the video immediately.
- While the assistant is responding, keep the video paused by default.
- Resume only when the user requests it or has explicitly configured auto-resume.
- Media controls remain available if Realtime disconnects.
- Show tool action success only after actual execution is confirmed.
- Search results should offer choices when multiple passages may be relevant.
- Highlight transcript evidence used in an answer.

## Visual style
- Clean, modern, information-dense but readable.
- Clear distinction between transcript evidence and AI-added explanation.
- Avoid decorative animations that delay interaction.
- Prioritize accessibility: keyboard-accessible controls, visible focus, readable contrast, captions/transcript, and clear microphone status.

## Existing UI
Kiro must inspect the current app before changing tabs or layouts. Preserve working UI patterns unless they conflict with the core workflow. Do not invent a screenshot or assume the current tabbed playground structure without inspecting it.

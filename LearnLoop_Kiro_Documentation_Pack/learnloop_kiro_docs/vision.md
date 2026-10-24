# LearnLoop — Product Vision

## One-sentence pitch
LearnLoop is a real-time AI learning companion that helps students understand lecture videos, find the exact moment a concept was explained, ask contextual questions, and save useful moments for revision.

## Target user
The primary user is a student or self-directed learner watching recorded lectures, tutorials, or MOOC videos on a desktop browser. They may be learning a technical subject and need to revisit difficult concepts without manually scrubbing through an entire video.

Secondary users, such as teachers preparing learning materials, are outside the initial MVP audience.

## Problem
Lecture videos are linear and difficult to search. Students often remember a concept but not where it was explained, have to scrub manually to find it, and lose useful explanations or questions after leaving the video. A generic chatbot may answer questions without knowing what the lecturer actually said or where the relevant passage occurred. LearnLoop combines a synchronized transcript, video navigation, grounded explanations, and durable concept bookmarks in one workspace.

## Core learning loop
1. Open or upload a lecture.
2. Start watching immediately while lecture audio is processed in the background.
3. Let LearnLoop build timestamped transcript context progressively.
4. Say “Looper” to activate the assistant, or use text controls.
5. Ask about the current passage or an earlier concept.
6. Review the answer and its transcript evidence.
7. Jump to a passage, control playback, bookmark it, or take a note.
8. Return to the lecture and continue learning.

## MVP success definition
The MVP succeeds when a student can play one lecture while background transcription runs, activate the assistant with “Looper,” ask a question grounded in available lecture context, navigate the video with a command, and save/reopen a timestamped bookmark.

## Product principles
- Playback must not wait for full-lecture transcription.
- The browser owns and confirms media-control actions.
- The lecture timeline is the source of truth for timestamps.
- Lecture-derived claims must link to actual transcript segments.
- Supplemental AI explanations must be labelled as AI-added context.
- The app must clearly show processing, listening, speaking, and failure states.
- The student must retain control over microphone activation, mute, and saved learning data.
- Keep the MVP small, reliable, and demonstrable.

## Explicit non-goals for the first MVP
- Avatar-based interaction.
- Guaranteed accent conversion or voice cloning.
- Multi-agent orchestration.
- Collaborative classrooms or shared notes.
- Full user-account and multi-tenant administration unless the existing deployment requires it.
- Adaptive curriculum planning or claims of measured mastery.
- Automatic execution of consequential actions.
- Perfect transcription of every language, accent, or noisy recording.
- Visual understanding of video frames unless separately implemented and verified.
- Sending the user's microphone to a server during passive wake-word mode.

## Core architecture concept
Three concurrent paths share a synchronized video timeline:
1. Media control in the browser.
2. Lecture awareness: audio extraction/capture, transcription, timestamp alignment, and progressive indexing.
3. User conversation: local wake-word detection, then user-microphone streaming to Higgs Realtime, tool execution, and grounded responses.

A persistent context layer maintains recent lecture segments, searchable lecture history, and user-controlled student learning state.

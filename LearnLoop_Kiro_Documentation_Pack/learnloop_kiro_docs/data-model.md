# LearnLoop — Data and Content Model

Use the existing repository's persistence choice if one is already established. For a single-user MVP, SQLite is a reasonable default. Keep provider-specific response objects separate from the canonical application schema.

## 1. Video
| Field | Type | Required | Meaning |
|---|---|---|---|
| id | string/UUID | yes | Stable video identifier |
| title | string | yes | Display title |
| original_filename | string | yes | Uploaded filename |
| storage_key | string | yes | Server-side storage reference; do not expose raw paths |
| duration_seconds | number | when known | Original video duration |
| processing_status | enum | yes | uploaded, extracting_audio, transcribing, indexing, ready, failed |
| processing_error_code | string/null | no | Safe machine-readable error |
| created_at | datetime | yes | Creation time |

## 2. TranscriptSegment
| Field | Type | Required | Meaning |
|---|---|---|---|
| id | string/UUID | yes | Stable segment ID |
| video_id | string/UUID | yes | Parent video |
| start_time | number | yes | Start offset in original video seconds |
| end_time | number | yes | End offset in original video seconds |
| text | string | yes | Actual recognized/caption text |
| source | enum/string | yes | e.g. source_caption, higgs_stt, aligned_transcript |
| timing_quality | enum | yes | word, sentence, segment, approximate, unknown |
| language | string/null | no | Language code if known |
| speaker_label | string/null | no | Only if provided/reliably inferred |
| provider_metadata | JSON/null | no | Sanitized debugging metadata |

Validation: start_time >= 0; end_time >= start_time; end_time <= video duration when duration is known, allowing documented tolerance. Never fabricate timing. If timing is missing, use a verified alignment process or disable exact-seek claims.

## 3. Bookmark
| Field | Type | Required | Meaning |
|---|---|---|---|
| id | string/UUID | yes | Stable bookmark ID |
| video_id | string/UUID | yes | Source video |
| timestamp_seconds | number | yes | Actual original-video position |
| end_time_seconds | number/null | no | Optional passage end |
| title | string | yes | Concept label |
| transcript_excerpt | string/null | no | Actual excerpt |
| segment_ids | JSON/list | no | Referenced transcript segments |
| note | string/null | no | Student's own note |
| generated_explanation | string/null | no | AI-generated content, labelled as such |
| created_at | datetime | yes | Creation time |
| updated_at | datetime | yes | Last update |

## 4. Note
| Field | Type | Required | Meaning |
|---|---|---|---|
| id | string/UUID | yes | Stable note ID |
| video_id | string/UUID | yes | Source video |
| timestamp_seconds | number/null | no | Optional video position |
| text | string | yes | Student-authored note |
| created_at | datetime | yes | Creation time |
| updated_at | datetime | yes | Last update |

## 5. ProcessingJob
| Field | Type | Required | Meaning |
|---|---|---|---|
| id | string/UUID | yes | Job ID |
| video_id | string/UUID | yes | Associated video |
| stage | enum | yes | extraction, transcription, alignment, indexing |
| status | enum | yes | queued, running, succeeded, failed |
| progress | number/null | no | 0–100 if meaningful |
| attempt_count | integer | yes | Retry tracking |
| error_code | string/null | no | Safe error |
| started_at | datetime/null | no | Start |
| completed_at | datetime/null | no | Completion |

## 6. LearningSession
| Field | Type | Required | Meaning |
|---|---|---|---|
| id | string/UUID | yes | Session ID |
| video_id | string/UUID | yes | Current video |
| started_at | datetime | yes | Session start |
| ended_at | datetime/null | no | Session end |
| last_video_time | number | yes | Last known player position |
| current_topic | string/null | no | Compact topic state |
| recent_questions | JSON/list | no | Concise recent interaction history |

## 7. StudentLearningState
For the single-user MVP, a single local profile is sufficient. Persist only user-controlled or directly relevant learning data.
- id
- learning_preferences (JSON, optional)
- saved_summary (text, optional)
- updated_at

Do not infer sensitive attributes. Avoid building elaborate profiles before there is a clear use case.

## 8. RecentContext (ephemeral/cache)
- video_id
- segment_ids
- start_time
- end_time
- text
- updated_at

This can be computed from recent transcript segments rather than stored separately. If stored, it must be rebuildable from canonical transcript data.

## Example records
Video:
```json
{
  "id": "video_demo_01",
  "title": "Regularisation and Overfitting",
  "original_filename": "lecture.mp4",
  "storage_key": "videos/video_demo_01",
  "duration_seconds": 1200,
  "processing_status": "transcribing",
  "created_at": "2026-10-22T12:00:00Z"
}
```

TranscriptSegment (illustrative shape only; not real lecture content):
```json
{
  "id": "seg_demo_014",
  "video_id": "video_demo_01",
  "start_time": 762.0,
  "end_time": 778.0,
  "text": "[Example placeholder: transcript text returned by the transcription provider]",
  "source": "higgs_stt",
  "timing_quality": "segment",
  "language": "en"
}
```

## Persistence versus ephemeral state
Persist: videos and metadata, processing status, transcript segments, bookmarks, notes, and user-approved learning preferences.
Ephemeral: live audio buffers, current wake-word detection state, active microphone stream, Realtime connection state, temporary tool-call state, and short-lived context assembled for a request.

# LearnLoop

The lecture player is at <http://localhost:3000/learn.html>. Its **Live avatar study buddy** link opens <http://localhost:3000/revise.html>, where you can choose a processed lecture for a viva, free discussion, or timed quiz with a lip-synced Higgs avatar. The page can also build and export a study pack.

To run this branch, install the Python packages in `requirements-dev.txt` and the JavaScript packages in `package.json`, then start the FastAPI server with `python server_fastapi.py`. Keep the server terminal open while using the site. Set `BOSON_API_KEY` in `.env`; for live avatar video also set `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` from the same LiveKit Cloud project. See `.env.example` for the names. The API keys remain on the server.

## Higgs API Playground

A full-stack playground that exercises **every Boson AI (Higgs) developer API** behind one UI:

| Tab | Boson endpoint(s) | What it tests |
| --- | --- | --- |
| **TTS 3** | `POST /v1/audio/speech` | Text→audio, inline emotion/style/prosody/sfx tags, preset & custom voices, output formats, word-level timestamps, one-off voice clone (`ref_audio`/`ref_text`), normalization controls |
| **Voices** | `POST` / `GET` / `GET {id}` / `DELETE {id}` `/v1/audio/voices` | Create a reusable cloned voice, list, inspect, delete |
| **Avatar** | `POST /v1/videos`, `GET /v1/videos/{id}`, `GET /v1/videos/{id}/content` | Create an async talking-head video (text- or audio-driven), poll status/progress, download the MP4 |
| **Realtime** | `POST /v1/realtime/client_secrets` + WebSocket `/v1/realtime` | Mint a short-lived client secret, open a full-duplex session, stream the mic, play streamed audio replies, server VAD turn detection + barge-in |

Your API key stays on the server. The browser calls a local proxy that attaches
`Authorization: Bearer <key>`. For Realtime, the server mints a short-lived
`bai-eph-...` client secret and the browser opens the WebSocket itself — the
long-lived key never reaches the page.

## Setup

1. Get an API key at <https://www.boson.ai/workspace/api-key> (format `bai-xxxx`).
2. Copy `.env.example` to `.env` and paste your key:
   ```
   BOSON_API_KEY=bai-xxxx
   ```

## Run

Two interchangeable backends serve the same `public/` UI. Pick whichever runtime you have.

### Python (no dependencies)
```powershell
python server.py
```

### Node.js
```powershell
npm install
npm start
```

Then open <http://localhost:3000>. The dot in the top-right confirms whether the
server found your key.

## Project layout

```
server.py        Python stdlib proxy (zero deps)
server.js        Node/Express proxy (same routes)
public/
  index.html     Tabbed UI
  styles.css     Styling
  shared.js      Constants (preset voices, tag list) + fetch/DOM helpers
  app.js         TTS, Voices, Avatar tabs + tab/key wiring
  realtime.js    WebSocket voice session (mic capture, PCM16 playback)
```

## Proxy routes

| UI route | Forwards to |
| --- | --- |
| `GET  /api/health` | — (reports whether a key is set) |
| `POST /api/tts/speech` | `POST /v1/audio/speech` |
| `POST /api/voices` | `POST /v1/audio/voices` |
| `GET  /api/voices` | `GET /v1/audio/voices` |
| `GET  /api/voices/:id` | `GET /v1/audio/voices/{id}` |
| `DELETE /api/voices/:id` | `DELETE /v1/audio/voices/{id}` |
| `POST /api/videos` | `POST /v1/videos` |
| `GET  /api/videos/:id` | `GET /v1/videos/{id}` |
| `GET  /api/videos/:id/content` | `GET /v1/videos/{id}/content` |
| `POST /api/realtime/client-secret` | `POST /v1/realtime/client_secrets` |

## Notes

- TTS input is capped at 5000 chars; the docs recommend ~300 chars per request.
- Avatar jobs are async — the UI polls `GET /v1/videos/{id}` every ~2.5s and shows progress, then downloads the MP4.
- Realtime streams 24 kHz PCM16 both ways and uses server-side VAD; speaking over the assistant (barge-in) stops playback.
- Higgs Realtime is protocol-compatible with the OpenAI Realtime API, which is why the event names mirror that schema.

API behavior summarized from the [Boson AI documentation](https://docs.boson.ai/overview).

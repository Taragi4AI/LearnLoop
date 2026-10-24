// Boson AI (Higgs) API playground — backend proxy.
//
// The browser never sees your BOSON_API_KEY. Every call the UI makes hits this
// Express server, which attaches the Authorization header and forwards the
// request to https://api.boson.ai. This mirrors the docs' guidance: keep the
// long-lived key on a trusted server, and mint short-lived client secrets for
// browser-side Realtime connections.

import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const API_BASE = process.env.BOSON_API_BASE || 'https://api.boson.ai/v1';
const API_KEY = process.env.BOSON_API_KEY;
const AVATAR_REFERENCE_PATH = path.join(__dirname, 'image.png');
const MAX_AVATAR_REFERENCE_BYTES = 10 * 1024 * 1024;

const app = express();
// TTS/avatar payloads can carry base64 audio/images, so allow large bodies.
app.use(express.json({ limit: '25mb' }));
// LearnLoop is intentionally bundle-free. Serve Mermaid's ESM build from the
// installed package rather than fetching code from a hosted diagram service.
app.use('/vendor/mermaid', express.static(path.join(__dirname, 'node_modules', 'mermaid', 'dist')));
app.use(express.static(path.join(__dirname, 'public')));

function requireKey(res) {
  if (!API_KEY) {
    res.status(500).json({
      error: {
        message:
          'BOSON_API_KEY is not set on the server. Copy .env.example to .env and add your key, then restart.',
        type: 'config_error',
      },
    });
    return false;
  }
  return true;
}

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${API_KEY}`, ...extra };
}

// Forward a Boson error body (or a generic one) to the client, preserving status.
async function relayError(res, upstream) {
  const text = await upstream.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { error: { message: text || upstream.statusText, type: 'upstream_error' } };
  }
  res.status(upstream.status).json(body);
}

// ---------------------------------------------------------------------------
// Health / config check — lets the UI show whether a key is configured.
// ---------------------------------------------------------------------------
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    keyConfigured: Boolean(API_KEY),
    apiBase: API_BASE,
  });
});

// The Calm Walkthrough avatar always uses the learner-provided root image. It
// is read-only: the browser converts this validated PNG to a data URI before
// submitting it through the existing /api/videos proxy.
app.get('/api/walkthrough/avatar-reference', (_req, res) => {
  try {
    const info = fs.statSync(AVATAR_REFERENCE_PATH);
    if (!info.isFile() || info.size > MAX_AVATAR_REFERENCE_BYTES) {
      return res.status(500).json({ error: { message: 'Avatar reference image is unavailable or exceeds 10 MB.' } });
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.type('png').sendFile(AVATAR_REFERENCE_PATH);
  } catch {
    return res.status(404).json({ error: { message: 'Avatar reference image is unavailable.' } });
  }
});

// ---------------------------------------------------------------------------
// Higgs TTS 3 — POST /v1/audio/speech
// Returns binary audio, or (when timestamps=true) a JSON envelope.
// ---------------------------------------------------------------------------
app.post('/api/tts/speech', async (req, res) => {
  if (!requireKey(res)) return;
  try {
    const upstream = await fetch(`${API_BASE}/audio/speech`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(req.body),
    });

    if (!upstream.ok) return relayError(res, upstream);

    const contentType = upstream.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      // timestamps=true -> JSON envelope with base64 audio + word list
      const json = await upstream.json();
      return res.json(json);
    }
    // Binary audio: stream the bytes straight through.
    res.setHeader('Content-Type', contentType || 'audio/mpeg');
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.send(buf);
  } catch (err) {
    res.status(502).json({ error: { message: String(err), type: 'proxy_error' } });
  }
});

// ---------------------------------------------------------------------------
// Custom voices — CRUD under /v1/audio/voices
// ---------------------------------------------------------------------------
app.post('/api/voices', async (req, res) => {
  if (!requireKey(res)) return;
  try {
    const upstream = await fetch(`${API_BASE}/audio/voices`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(req.body),
    });
    if (!upstream.ok) return relayError(res, upstream);
    res.json(await upstream.json());
  } catch (err) {
    res.status(502).json({ error: { message: String(err), type: 'proxy_error' } });
  }
});

app.get('/api/voices', async (_req, res) => {
  if (!requireKey(res)) return;
  try {
    const upstream = await fetch(`${API_BASE}/audio/voices`, { headers: authHeaders() });
    if (!upstream.ok) return relayError(res, upstream);
    res.json(await upstream.json());
  } catch (err) {
    res.status(502).json({ error: { message: String(err), type: 'proxy_error' } });
  }
});

app.get('/api/voices/:id', async (req, res) => {
  if (!requireKey(res)) return;
  try {
    const upstream = await fetch(`${API_BASE}/audio/voices/${encodeURIComponent(req.params.id)}`, {
      headers: authHeaders(),
    });
    if (!upstream.ok) return relayError(res, upstream);
    res.json(await upstream.json());
  } catch (err) {
    res.status(502).json({ error: { message: String(err), type: 'proxy_error' } });
  }
});

app.delete('/api/voices/:id', async (req, res) => {
  if (!requireKey(res)) return;
  try {
    const upstream = await fetch(`${API_BASE}/audio/voices/${encodeURIComponent(req.params.id)}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    if (!upstream.ok) return relayError(res, upstream);
    res.json(await upstream.json());
  } catch (err) {
    res.status(502).json({ error: { message: String(err), type: 'proxy_error' } });
  }
});

// ---------------------------------------------------------------------------
// Higgs Avatar — async video jobs under /v1/videos
// ---------------------------------------------------------------------------
app.post('/api/videos', async (req, res) => {
  if (!requireKey(res)) return;
  try {
    const upstream = await fetch(`${API_BASE}/videos`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(req.body),
    });
    if (!upstream.ok) return relayError(res, upstream);
    res.json(await upstream.json());
  } catch (err) {
    res.status(502).json({ error: { message: String(err), type: 'proxy_error' } });
  }
});

app.get('/api/videos/:id', async (req, res) => {
  if (!requireKey(res)) return;
  try {
    const upstream = await fetch(`${API_BASE}/videos/${encodeURIComponent(req.params.id)}`, {
      headers: authHeaders(),
    });
    if (!upstream.ok) return relayError(res, upstream);
    res.json(await upstream.json());
  } catch (err) {
    res.status(502).json({ error: { message: String(err), type: 'proxy_error' } });
  }
});

// Download rendered MP4 bytes once the job is completed.
app.get('/api/videos/:id/content', async (req, res) => {
  if (!requireKey(res)) return;
  try {
    const upstream = await fetch(
      `${API_BASE}/videos/${encodeURIComponent(req.params.id)}/content`,
      { headers: authHeaders() }
    );
    if (!upstream.ok) return relayError(res, upstream);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'video/mp4');
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.send(buf);
  } catch (err) {
    res.status(502).json({ error: { message: String(err), type: 'proxy_error' } });
  }
});

// ---------------------------------------------------------------------------
// Higgs Realtime — mint a short-lived client secret for the browser.
// The browser opens the WebSocket itself using this ephemeral key.
// ---------------------------------------------------------------------------
app.post('/api/realtime/client-secret', async (req, res) => {
  if (!requireKey(res)) return;
  try {
    const upstream = await fetch(`${API_BASE}/realtime/client_secrets`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(req.body || {}),
    });
    if (!upstream.ok) return relayError(res, upstream);
    res.json(await upstream.json());
  } catch (err) {
    res.status(502).json({ error: { message: String(err), type: 'proxy_error' } });
  }
});

app.listen(PORT, () => {
  console.log(`\n  Boson Higgs playground running at http://localhost:${PORT}`);
  console.log(`  API base: ${API_BASE}`);
  console.log(`  API key:  ${API_KEY ? 'configured ✓' : 'MISSING ✗  (copy .env.example to .env)'}\n`);
});

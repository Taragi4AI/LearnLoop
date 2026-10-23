// Higgs Realtime voice session.
//
// Flow:
//   1. Ask our server to mint a short-lived client secret (bai-eph-...).
//   2. Open a WebSocket to wss://api.boson.ai/v1/realtime?model=higgs-realtime
//      using the ephemeral key as a bearer subprotocol.
//   3. Send session.update to configure voice, instructions, turn detection,
//      and PCM16 audio formats.
//   4. Stream 24kHz PCM16 mic frames as input_audio_buffer.append events.
//   5. Play back audio deltas the server streams in response.audio.delta.
//
// Higgs Realtime is protocol-compatible with the OpenAI Realtime API, so the
// event names below mirror that schema.

import { $, el, postJSON } from './shared.js';

const WS_URL = 'wss://api.boson.ai/v1/realtime?model=higgs-realtime';
const SAMPLE_RATE = 24000;

let ws = null;
let audioCtx = null;
let micStream = null;
let micNode = null;
let micSource = null;
let playHead = 0; // scheduling cursor for queued playback

// Analysers tap the real signals so the waveforms reflect actual audio.
let inputAnalyser = null;   // mic input (user)
let outputAnalyser = null;  // decoded API audio (assistant)
let outputGain = null;      // all playback routes through here -> analyser -> speakers
let rafId = null;
let outputActiveUntil = 0;  // timestamp until which we consider the API "speaking"

const ui = {};

export function initRealtime() {
  ui.connect = $('#rtConnect');
  ui.disconnect = $('#rtDisconnect');
  ui.state = $('#rtState');
  ui.transcript = $('#rtTranscript');
  ui.result = $('#rtResult');
  ui.prompt = $('#rtPrompt');
  ui.voice = $('#rtVoice');
  ui.expiry = $('#rtExpiry');

  ui.userWave = $('#rtUserWave');
  ui.apiWave = $('#rtApiWave');
  ui.userCard = $('#rtUserCard');
  ui.apiCard = $('#rtApiCard');
  ui.userDot = $('#rtUserDot');
  ui.apiDot = $('#rtApiDot');
  ui.userLevel = $('#rtUserLevel');
  ui.apiLevel = $('#rtApiLevel');

  ui.connect.addEventListener('click', connect);
  ui.disconnect.addEventListener('click', () => disconnect('Disconnected.'));

  // Draw idle flat lines on load.
  drawIdle(ui.userWave, '#6ea8fe');
  drawIdle(ui.apiWave, '#9d7bff');
}

function setState(text, cls = '') {
  ui.state.textContent = text;
  ui.state.className = 'rt-state' + (cls ? ' ' + cls : '');
}

function addBubble(role, text) {
  const existing = ui.transcript.querySelector(`.bubble.${role}.pending`);
  if (existing) {
    existing.textContent += text;
    return existing;
  }
  const b = el('div', { className: `bubble ${role} pending`, textContent: text });
  ui.transcript.append(b);
  ui.transcript.scrollTop = ui.transcript.scrollHeight;
  return b;
}

function finalizeBubbles() {
  ui.transcript.querySelectorAll('.pending').forEach((b) => b.classList.remove('pending'));
}

async function connect() {
  try {
    ui.connect.disabled = true;
    ui.result.innerHTML = '';
    setState('requesting key…');

    const seconds = Math.max(10, Math.min(7200, Number(ui.expiry.value) || 600));
    const secret = await postJSON('/api/realtime/client-secret', { expires_after: { seconds } });
    const ephemeralKey = secret.value;
    if (!ephemeralKey) throw new Error('No client secret returned by server.');

    setState('connecting…');

    // The ephemeral key is passed as a WebSocket subprotocol bearer token,
    // matching the OpenAI-compatible Realtime handshake.
    ws = new WebSocket(WS_URL, [
      'realtime',
      `openai-insecure-api-key.${ephemeralKey}`,
      'openai-beta.realtime-v1',
    ]);

    ws.addEventListener('open', onOpen);
    ws.addEventListener('message', onMessage);
    ws.addEventListener('error', () => setState('connection error', 'error'));
    ws.addEventListener('close', () => {
      if (ui.state.textContent !== 'idle') setState('closed');
      teardownAudio();
      ui.connect.classList.remove('hidden');
      ui.disconnect.classList.add('hidden');
      ui.connect.disabled = false;
    });
  } catch (err) {
    setState('error', 'error');
    ui.result.append(el('div', { className: 'row err', textContent: String(err.message || err) }));
    ui.connect.disabled = false;
  }
}

async function onOpen() {
  // Configure the session using the Higgs Realtime schema (NOT the flat OpenAI
  // one). An invalid config closes the session, so the shape must be exact:
  //   - output_modalities must be exactly ["audio"] or ["text"]
  //   - audio is nested as { input: {...}, output: {...} }
  //   - PCM format is { type: "audio/pcm", rate: 24000 }
  //   - transcription model is "higgs-stt-3.1"
  send({
    type: 'session.update',
    session: {
      type: 'realtime',
      model: 'higgs-realtime',
      instructions: ui.prompt.value.trim() || 'You are a helpful voice assistant.',
      output_modalities: ['audio'],
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: SAMPLE_RATE },
          transcription: { model: 'higgs-stt-3.1', language: null },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.55,
            prefix_padding_ms: 300,
            silence_duration_ms: 500,
            min_speech_duration: 0.125,
          },
        },
        output: {
          format: { type: 'audio/pcm', rate: SAMPLE_RATE },
          voice: ui.voice.value || 'default',
        },
      },
      temperature: 0.3,
      max_output_tokens: 'inf',
    },
  });

  try {
    await startMic();
    setState('live — speak now', 'live');
    ui.connect.classList.add('hidden');
    ui.disconnect.classList.remove('hidden');
  } catch (err) {
    setState('mic blocked', 'error');
    ui.result.append(el('div', { className: 'row err', textContent: 'Microphone access failed: ' + err.message }));
    disconnect('Could not start microphone.');
  }
}

function onMessage(evt) {
  let msg;
  try { msg = JSON.parse(evt.data); } catch { return; }

  switch (msg.type) {
    case 'session.created':
      setState('session ready — speak now', 'live');
      break;

    case 'session.updated':
      // Config accepted; nothing to do.
      break;

    case 'input_audio_buffer.speech_started':
      // Barge-in: stop any audio we're currently playing.
      stopPlayback();
      setState('listening…', 'live');
      break;

    case 'input_audio_buffer.speech_stopped':
      setState('thinking…', 'live');
      break;

    case 'response.created':
      setState('assistant responding…', 'speaking');
      break;

    // Audio chunks from the model (Higgs event name).
    case 'response.output_audio.delta':
    case 'response.audio.delta': // fallback alias
      if (msg.delta) playPcmChunk(msg.delta);
      setState('assistant speaking…', 'speaking');
      break;

    // Streaming transcript of what the assistant is saying.
    case 'response.output_audio_transcript.delta':
    case 'response.audio_transcript.delta': // fallback alias
      if (msg.delta) addBubble('assistant', msg.delta);
      break;

    // Final transcript of the user's spoken turn.
    case 'conversation.item.input_audio_transcription.completed':
      if (msg.transcript) { addBubble('user', msg.transcript); finalizeBubbles(); }
      break;

    case 'response.done':
      finalizeBubbles();
      setState('live — speak now', 'live');
      break;

    case 'error': {
      const m = msg.error?.message || 'Realtime error';
      setState('error', 'error');
      ui.result.append(el('div', { className: 'row err', textContent: `${msg.error?.type || 'error'}: ${m}` }));
      break;
    }
  }
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ---- Microphone capture -> PCM16 -> input_audio_buffer.append ----
async function startMic() {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
  playHead = audioCtx.currentTime;
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  micSource = audioCtx.createMediaStreamSource(micStream);

  // Analyser on the mic path -> real user waveform.
  inputAnalyser = audioCtx.createAnalyser();
  inputAnalyser.fftSize = 2048;
  inputAnalyser.smoothingTimeConstant = 0.5;
  micSource.connect(inputAnalyser);

  // Output path: every playback buffer connects to outputGain, which feeds
  // an analyser (for the API waveform) and then the speakers. This way the
  // output waveform is the real decoded audio, not a guess.
  outputGain = audioCtx.createGain();
  outputAnalyser = audioCtx.createAnalyser();
  outputAnalyser.fftSize = 2048;
  outputAnalyser.smoothingTimeConstant = 0.5;
  outputGain.connect(outputAnalyser);
  outputAnalyser.connect(audioCtx.destination);

  // ScriptProcessor is deprecated but universally available with no extra files.
  // Note: we do NOT connect it to destination (that would echo the mic).
  micNode = audioCtx.createScriptProcessor(4096, 1, 1);
  micNode.onaudioprocess = (e) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const input = e.inputBuffer.getChannelData(0);
    const pcm16 = floatToPcm16(input);
    send({ type: 'input_audio_buffer.append', audio: base64FromBytes(pcm16) });
  };
  micSource.connect(micNode);
  // Keep the processor alive in browsers that require a destination link,
  // but mute it so the raw mic isn't played back.
  const mute = audioCtx.createGain();
  mute.gain.value = 0;
  micNode.connect(mute);
  mute.connect(audioCtx.destination);

  startWaveLoop();
}

// ---- Waveform rendering (driven by the real analyser signals) ----
function startWaveLoop() {
  const userBuf = new Uint8Array(inputAnalyser.fftSize);
  const apiBuf = new Uint8Array(outputAnalyser.fftSize);

  const loop = () => {
    rafId = requestAnimationFrame(loop);

    inputAnalyser.getByteTimeDomainData(userBuf);
    outputAnalyser.getByteTimeDomainData(apiBuf);

    const userRms = rms(userBuf);
    const apiRms = rms(apiBuf);

    const userActive = userRms > 0.012;
    const apiActive = apiRms > 0.012 || performance.now() < outputActiveUntil;

    drawWave(ui.userWave, userBuf, '#6ea8fe', userActive);
    drawWave(ui.apiWave, apiBuf, '#9d7bff', apiActive);

    ui.userCard.classList.toggle('active', userActive);
    ui.apiCard.classList.toggle('active', apiActive);
    ui.userDot.classList.toggle('live', userActive);
    ui.apiDot.classList.toggle('live', apiActive);
    ui.userLevel.textContent = levelBar(userRms);
    ui.apiLevel.textContent = levelBar(apiRms);
  };
  loop();
}

function stopWaveLoop() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  if (ui.userWave) drawIdle(ui.userWave, '#6ea8fe');
  if (ui.apiWave) drawIdle(ui.apiWave, '#9d7bff');
  ui.userCard?.classList.remove('active');
  ui.apiCard?.classList.remove('active');
  ui.userDot?.classList.remove('live');
  ui.apiDot?.classList.remove('live');
  if (ui.userLevel) ui.userLevel.textContent = '—';
  if (ui.apiLevel) ui.apiLevel.textContent = '—';
}

function rms(byteData) {
  let sum = 0;
  for (let i = 0; i < byteData.length; i++) {
    const v = (byteData[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / byteData.length);
}

function levelBar(r) {
  const n = Math.min(10, Math.round(r * 40));
  return '▁▂▃▄▅▆▇█'.slice(0, 1).repeat(0) + '█'.repeat(n) + '·'.repeat(10 - n);
}

function drawWave(canvas, data, color, active) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // Midline.
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();

  // Waveform.
  ctx.lineWidth = 2;
  ctx.strokeStyle = active ? color : 'rgba(139,147,167,0.5)';
  ctx.shadowBlur = active ? 8 : 0;
  ctx.shadowColor = color;
  ctx.beginPath();
  const step = Math.max(1, Math.floor(data.length / w));
  let x = 0;
  for (let i = 0; i < data.length; i += step) {
    const v = data[i] / 128 - 1; // -1..1
    const y = h / 2 + v * (h / 2) * 0.92;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
    x += (w / data.length) * step;
  }
  ctx.stroke();
  ctx.shadowBlur = 0;
}

function drawIdle(canvas, color) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(139,147,167,0.35)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();
}

// ---- Playback of streamed PCM16 output ----
let scheduled = [];
function playPcmChunk(base64) {
  const bytes = bytesFromBase64(base64);
  const pcm16 = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  const float = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) float[i] = pcm16[i] / 32768;

  const buffer = audioCtx.createBuffer(1, float.length, SAMPLE_RATE);
  buffer.copyToChannel(float, 0);
  const src = audioCtx.createBufferSource();
  src.buffer = buffer;
  // Route through the output analyser graph so the API waveform is the real signal.
  src.connect(outputGain || audioCtx.destination);
  // Keep the API waveform "active" a touch past the last scheduled chunk.
  outputActiveUntil = performance.now() + buffer.duration * 1000 + 150;
  const now = audioCtx.currentTime;
  if (playHead < now) playHead = now;
  src.start(playHead);
  playHead += buffer.duration;
  scheduled.push(src);
  src.onended = () => { scheduled = scheduled.filter((s) => s !== src); };
}

function stopPlayback() {
  scheduled.forEach((s) => { try { s.stop(); } catch {} });
  scheduled = [];
  if (audioCtx) playHead = audioCtx.currentTime;
}

function teardownAudio() {
  stopPlayback();
  stopWaveLoop();
  try { micNode && micNode.disconnect(); } catch {}
  try { micSource && micSource.disconnect(); } catch {}
  try { inputAnalyser && inputAnalyser.disconnect(); } catch {}
  try { outputGain && outputGain.disconnect(); } catch {}
  try { outputAnalyser && outputAnalyser.disconnect(); } catch {}
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  if (audioCtx) audioCtx.close().catch(() => {});
  micNode = micSource = micStream = audioCtx = null;
  inputAnalyser = outputAnalyser = outputGain = null;
}

function disconnect(note) {
  try { ws && ws.close(); } catch {}
  ws = null;
  teardownAudio();
  setState('idle');
  if (note) ui.result.append(el('div', { className: 'row muted', textContent: note }));
  ui.connect.classList.remove('hidden');
  ui.disconnect.classList.add('hidden');
  ui.connect.disabled = false;
}

// ---- PCM / base64 helpers ----
function floatToPcm16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return new Uint8Array(out.buffer);
}
function base64FromBytes(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
function bytesFromBase64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

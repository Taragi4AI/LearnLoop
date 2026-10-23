// LearnLoop — Looper live voice conversation via Higgs Realtime (G3.2).
//
// Reuses the PROVEN protocol from the playground realtime.js (same session.update
// schema, event names, PCM16 mic append, and audio-delta playback), but as a
// focused, gated module: the microphone starts streaming to Higgs Realtime ONLY
// when start() is called (i.e. after explicit Looper activation). Nothing streams
// before that. The long-lived API key stays server-side; this mints a short-lived
// ephemeral secret via /api/realtime/client-secret and opens the WS itself.
//
// G3.2 scope: a working two-way voice conversation. NO lecture tools / transcript
// grounding / seeking / bookmarks — those are G4.

const WS_URL = 'wss://api.boson.ai/v1/realtime?model=higgs-realtime';
const SAMPLE_RATE = 24000;

const LOOPER_INSTRUCTIONS =
  'You are Looper, a friendly, concise voice learning companion inside a lecture app. ' +
  'Keep replies short and conversational. You CAN control the lecture via tools: pause/play/' +
  'rewind/forward (control_video), jump to a timestamp (seek_video), and manage bookmarks ' +
  '(prepare_bookmark then save_bookmark after the user approves, list_bookmarks, open_bookmark, ' +
  'update_bookmark to rename/renote, delete_bookmark to remove). ' +
  'To jump to where a concept was explained, use the lecture transcript context you are given ' +
  'to find the timestamp, then call seek_video. Only claim an action succeeded after the tool ' +
  'result confirms it. Never save a bookmark without explicit user approval. ' +
  'When the user asks you to PLAY or RESUME the lecture, just call control_video(play) and ' +
  'stay quiet — do NOT say "playing now" or announce it, because the lecture is now playing ' +
  'and speaking would interrupt it.';

// G5 agentic tools exposed to Higgs Realtime. Names/params are the contract the
// model calls; the HOST executes them against trusted app state and returns a
// function_call_output. The active lecture is NEVER taken from the model — the
// host derives it from currentVideoId.
export const LOOPER_TOOLS = [
  { type: 'function', name: 'control_video',
    description: 'Control lecture playback. Actions: pause, play/resume, rewind, forward, '
      + 'replay (go back N seconds and play), mute, unmute, volume_up, volume_down, '
      + 'set_volume (level 0.0–1.0), set_speed (rate, e.g. 1.5).',
    parameters: { type: 'object',
      properties: {
        action: { type: 'string', enum: ['pause','play','resume','rewind','forward','replay',
                  'mute','unmute','volume_up','volume_down','set_volume','set_speed'] },
        seconds: { type: 'number', description: 'Seconds for rewind/forward/replay (default 10).' },
        level: { type: 'number', description: 'Volume 0.0–1.0 for set_volume.' },
        rate: { type: 'number', description: 'Playback rate for set_speed (e.g. 0.5, 1, 1.5, 2).' },
      }, required: ['action'] } },
  { type: 'function', name: 'get_player_state',
    description: 'Read the CURRENT observed player state: position, duration, playing, rate, '
      + 'volume, muted. Use this instead of guessing the current time/volume/speed.',
    parameters: { type: 'object', properties: {} } },
  { type: 'function', name: 'seek_video',
    description: 'Seek the lecture to an absolute timestamp in seconds. To jump to where a '
      + 'concept was explained, first use the lecture context you were given to find its timestamp.',
    parameters: { type: 'object',
      properties: { timestamp_seconds: { type: 'number' } }, required: ['timestamp_seconds'] } },
  { type: 'function', name: 'prepare_bookmark',
    description: 'Propose (do NOT save) a bookmark for the current moment or a given timestamp. '
      + 'Shows the user a preview to approve.',
    parameters: { type: 'object',
      properties: {
        title: { type: 'string' },
        timestamp_seconds: { type: 'number', description: 'Defaults to current playback position.' },
        note: { type: 'string' },
      }, required: ['title'] } },
  { type: 'function', name: 'save_bookmark',
    description: 'Persist a previously prepared bookmark that the user approved. Requires the '
      + 'proposal id from prepare_bookmark.',
    parameters: { type: 'object',
      properties: { bookmark_id: { type: 'string' } }, required: ['bookmark_id'] } },
  { type: 'function', name: 'list_bookmarks',
    description: 'List saved bookmarks for the current lecture.',
    parameters: { type: 'object', properties: {} } },
  { type: 'function', name: 'open_bookmark',
    description: 'Open a saved bookmark by id and seek the lecture to its timestamp.',
    parameters: { type: 'object',
      properties: { bookmark_id: { type: 'string' } }, required: ['bookmark_id'] } },
  { type: 'function', name: 'update_bookmark',
    description: 'Rename a saved bookmark and/or change its note. Provide the bookmark id '
      + '(use list_bookmarks to find it) and at least one of title/note. The timestamp is '
      + 'preserved. Use this for "rename the bookmark" or "change the note" requests.',
    parameters: { type: 'object',
      properties: {
        bookmark_id: { type: 'string' },
        title: { type: 'string', description: 'New title/name for the bookmark.' },
        note: { type: 'string', description: 'New note text.' },
      }, required: ['bookmark_id'] } },
  { type: 'function', name: 'delete_bookmark',
    description: 'Permanently delete a saved bookmark by id. This is destructive — only call '
      + 'it after the user has clearly asked to delete/remove that specific bookmark.',
    parameters: { type: 'object',
      properties: { bookmark_id: { type: 'string' } }, required: ['bookmark_id'] } },
];

export function createLooperSession({ onState, onUserText, onAssistantText, onReady, onToolCall,
                                      beforeAgentAudio, onAgentAudioStart, onAgentAudioEnd,
                                      voice = 'default' } = {}) {
  let ws = null;
  let audioCtx = null, micStream = null, micNode = null, micSource = null;
  let outputGain = null, playHead = 0, scheduled = [];
  let state = 'idle';     // idle | connecting | live | speaking | error | closed
  let starting = false;

  // Manual-turn client VAD state.
  let speaking = false;       // currently detecting speech
  let silenceFrames = 0;      // consecutive quiet processor callbacks
  let awaitingAnswer = false;  // a turn is committed; ignore VAD until answered
  const SPEECH_RMS = 0.015;   // above = speech
  const SILENCE_CALLBACKS = 12; // ~ (4096/24000)*12 ≈ 2s of silence ends a turn

  function setState(s, detail) { state = s; onState && onState(s, detail); }

  function detectTurnEnd(samples) {
    if (awaitingAnswer || state === 'speaking') return;  // don't segment during answer
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / samples.length);
    if (rms > SPEECH_RMS) { speaking = true; silenceFrames = 0; }
    else if (speaking) {
      silenceFrames++;
      if (silenceFrames >= SILENCE_CALLBACKS) {
        speaking = false; silenceFrames = 0;
        commitTurn();   // user finished speaking -> commit; server transcribes, no auto-response
      }
    }
  }

  function commitTurn() {
    if (awaitingAnswer) return;
    awaitingAnswer = true;
    setState('live', 'Thinking…');
    send({ type: 'input_audio_buffer.commit' });
    // Response is NOT requested here — the host sequencer injects context first,
    // then calls requestResponse() (race fix).
  }

  /** Called by the host (via the turn sequencer) AFTER context is injected. */
  function requestResponse() {
    send({ type: 'response.create' });
  }

  /** Return a tool-call result to the model and continue the response (G5).
   *  `output` is any JSON-serialisable value; echoes the call_id per protocol. */
  function returnToolResult(callId, output) {
    send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId,
              output: typeof output === 'string' ? output : JSON.stringify(output) },
    });
    send({ type: 'response.create' });
  }

  async function start() {
    if (starting || (ws && ws.readyState === WebSocket.OPEN)) return;  // no duplicate sessions
    starting = true;
    setState('connecting', 'Requesting session…');
    try {
      // 1) Mint ephemeral secret server-side (key never reaches the browser).
      const res = await fetch('/api/realtime/client-secret', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expires_after: { seconds: 600 } }),
      });
      const secret = await res.json();
      if (!res.ok) throw new Error(secret?.error?.message || `secret ${res.status}`);
      const ephemeralKey = secret.value;
      if (!ephemeralKey) throw new Error('No client secret returned.');

      // 2) Open the WebSocket with the ephemeral key as subprotocol bearer.
      setState('connecting', 'Connecting to Higgs Realtime…');
      ws = new WebSocket(WS_URL, [
        'realtime',
        `openai-insecure-api-key.${ephemeralKey}`,
        'openai-beta.realtime-v1',
      ]);
      ws.addEventListener('open', onOpen);
      ws.addEventListener('message', onMessage);
      ws.addEventListener('error', () => setState('error', 'Connection error.'));
      ws.addEventListener('close', () => {
        teardownAudio();
        if (state !== 'error') setState('closed', 'Session ended.');
        starting = false;
      });
    } catch (err) {
      setState('error', String(err.message || err));
      starting = false;
    }
  }

  async function onOpen() {
    // Exact Higgs Realtime session schema (verified working in the playground).
    send({
      type: 'session.update',
      session: {
        type: 'realtime',
        model: 'higgs-realtime',
        instructions: LOOPER_INSTRUCTIONS,
        output_modalities: ['audio'],
        tools: LOOPER_TOOLS,
        tool_choice: 'auto',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: SAMPLE_RATE },
            transcription: { model: 'higgs-stt-3.1', language: null },
            // MANUAL turn detection (race fix, LL-G4-TEST-002): the server will
            // NOT auto-respond on speech-end. The client commits the turn, waits
            // for the transcription, injects question-specific context, and only
            // THEN sends response.create — so context always precedes the answer.
            turn_detection: null,
          },
          output: { format: { type: 'audio/pcm', rate: SAMPLE_RATE }, voice },
        },
        temperature: 0.3,
        max_output_tokens: 'inf',
      },
    });
    try {
      await startMic();                       // mic streaming begins HERE, post-activation only
      setState('live', 'Listening — speak now.');
      starting = false;
      onReady && onReady();                   // host injects initial lecture context (G4)
    } catch (err) {
      setState('error', 'Microphone access failed: ' + (err?.message || err));
      stop();
    }
  }

  function onMessage(evt) {
    let msg; try { msg = JSON.parse(evt.data); } catch { return; }
    switch (msg.type) {
      case 'session.created': setState('live', 'Session ready — speak now.'); break;
      case 'input_audio_buffer.speech_started':
        stopPlayback(); agentAudioOpen = false; onAgentAudioEnd && onAgentAudioEnd();
        setState('live', 'Listening…'); break;      // barge-in
      case 'input_audio_buffer.speech_stopped': setState('live', 'Thinking…'); break;
      case 'response.created': setState('speaking', 'Looper is responding…'); agentAudioOpen = false; break;
      case 'response.output_audio.delta':
      case 'response.audio.delta':
        if (msg.delta) gateAndPlay(msg.delta);
        break;
      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta':
        if (msg.delta) onAssistantText && onAssistantText(msg.delta, false);
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (msg.transcript) onUserText && onUserText(msg.transcript);
        break;
      case 'response.done': {
        // A response may END in client tool calls (G5). Execute those and
        // continue; only a response.done with NO client calls is the final turn.
        const output = (msg.response && msg.response.output) || [];
        const clientCalls = output.filter(
          (it) => it && it.type === 'function_call' && (it.executor === 'client' || it.executor == null)
        );
        if (clientCalls.length && onToolCall) {
          setState('speaking', 'Looper is taking an action…');
          // Host executes each call and returns the result via returnToolResult.
          for (const call of clientCalls) onToolCall(call);
          // Do NOT clear awaitingAnswer / set 'live' yet — the continued
          // response (after tool outputs) will arrive and end with its own
          // response.done.
          break;
        }
        onAssistantText && onAssistantText('', true);
        awaitingAnswer = false;               // ready for the next manual turn
        agentAudioOpen = false; onAgentAudioEnd && onAgentAudioEnd();
        setState('live', 'Listening — speak now.');
        break;
      }
      case 'error':
        setState('error', (msg.error?.type || 'error') + ': ' + (msg.error?.message || 'Realtime error'));
        break;
    }
  }

  function send(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }

  // --- Audio coordination policy (Phase 3A): Looper audio must NOT overlap
  // lecture audio. The first audio chunk of each response runs beforeAgentAudio()
  // (host pauses the lecture + confirms). If pausing fails, we SUPPRESS Looper
  // audio rather than knowingly overlap, and surface a visible error. ---
  let agentAudioOpen = false;     // policy resolved for the current response?
  let agentAudioAllowed = false;  // may we play this response's audio?

  function gateAndPlay(base64) {
    if (!agentAudioOpen) {
      agentAudioOpen = true;
      // beforeAgentAudio returns true if it's safe (lecture paused) to play.
      agentAudioAllowed = beforeAgentAudio ? beforeAgentAudio() !== false : true;
      if (agentAudioAllowed) { onAgentAudioStart && onAgentAudioStart(); setState('speaking', 'Looper is speaking…'); }
      else { setState('error', 'Could not pause the lecture; suppressing Looper audio to avoid overlap.'); }
    }
    if (agentAudioAllowed) playPcmChunk(base64);
  }

  /** Inject a grounding/context text message into the live conversation (G4).
   *  Uses the documented conversation.item.create with a user text item. Does
   *  NOT itself trigger a response (server_vad drives responses from speech). */
  function sendContext(text) {
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return false;
    send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user',
              content: [{ type: 'input_text', text }] },
    });
    return true;
  }

  async function startMic() {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
    playHead = audioCtx.currentTime;
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    micSource = audioCtx.createMediaStreamSource(micStream);

    outputGain = audioCtx.createGain();
    outputGain.connect(audioCtx.destination);

    micNode = audioCtx.createScriptProcessor(4096, 1, 1);
    micNode.onaudioprocess = (e) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const samples = e.inputBuffer.getChannelData(0);
      send({ type: 'input_audio_buffer.append', audio: base64FromBytes(floatToPcm16(samples)) });
      // Client-side VAD for MANUAL turns: detect end-of-speech to auto-commit.
      detectTurnEnd(samples);
    };
    micSource.connect(micNode);
    const mute = audioCtx.createGain(); mute.gain.value = 0;   // keep processor alive, no echo
    micNode.connect(mute); mute.connect(audioCtx.destination);
  }

  function playPcmChunk(base64) {
    if (!audioCtx) return;
    const bytes = bytesFromBase64(base64);
    const pcm16 = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
    const f32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) f32[i] = pcm16[i] / 32768;
    const buffer = audioCtx.createBuffer(1, f32.length, SAMPLE_RATE);
    buffer.copyToChannel(f32, 0);
    const srcNode = audioCtx.createBufferSource();
    srcNode.buffer = buffer;
    srcNode.connect(outputGain || audioCtx.destination);
    const now = audioCtx.currentTime;
    if (playHead < now) playHead = now;
    srcNode.start(playHead);
    playHead += buffer.duration;
    scheduled.push(srcNode);
    srcNode.onended = () => { scheduled = scheduled.filter((s) => s !== srcNode); };
  }

  function stopPlayback() {
    scheduled.forEach((s) => { try { s.stop(); } catch {} });
    scheduled = [];
    if (audioCtx) playHead = audioCtx.currentTime;
  }

  function teardownAudio() {
    stopPlayback();
    try { micNode && micNode.disconnect(); } catch {}
    try { micSource && micSource.disconnect(); } catch {}
    try { outputGain && outputGain.disconnect(); } catch {}
    if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
    if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
    micNode = micSource = outputGain = null;
  }

  function stop() {
    try { ws && ws.close(); } catch {}
    ws = null;
    teardownAudio();
    starting = false;
    setState('closed', 'Session stopped.');
  }

  return { start, stop, sendContext, requestResponse, returnToolResult, get state() { return state; } };
}

// ---- PCM / base64 helpers (from the proven playground client) ----
function floatToPcm16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return new Uint8Array(out.buffer);
}
function base64FromBytes(bytes) {
  let bin = ''; const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin);
}
function bytesFromBase64(b64) {
  const bin = atob(b64); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

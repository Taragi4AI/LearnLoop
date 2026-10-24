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

// Server-side turn detection config (Boson Higgs Realtime). semantic_vad adds a
// "did the user truly finish?" judgment over server_vad to avoid mid-pause
// cut-offs — best for a learning tutor. Tunables per the turn-detection docs:
//   threshold (0.85 default) — higher ignores more background noise
//   silence_duration_ms (500) — silence that ends a turn
//   prefix_padding_ms (300) — audio kept before detected speech
//   min_speech_duration (0.125s) — minimum speech to start a segment
// We raise threshold slightly for laptop mics/room noise and keep a short
// silence window for responsiveness.
const TURN_DETECTION = {
  type: 'semantic_vad',
  threshold: 0.9,
  prefix_padding_ms: 300,
  silence_duration_ms: 600,
  min_speech_duration: 0.2,
};

const LOOPER_INSTRUCTIONS =
  'You are Jarvis, a friendly, concise voice learning companion inside a lecture app. ' +
  'If asked your name, say you are Jarvis. ' +
  'Keep replies short and conversational. You CAN control the lecture via tools: pause/play/' +
  'rewind/forward (control_video), jump to a timestamp (seek_video), and manage bookmarks ' +
  '(prepare_bookmark then save_bookmark after the user approves, list_bookmarks, open_bookmark, ' +
  'update_bookmark to rename/renote, delete_bookmark to remove). ' +
  'To jump to where a concept was explained, use the lecture transcript context you are given ' +
  'to find the timestamp, then call seek_video. Only claim an action succeeded after the tool ' +
  'result confirms it. Never save a bookmark without explicit user approval. ' +
  'For every playback control request — pause, play, resume, seek, rewind, forward, mute, ' +
  'volume, or speed — call the appropriate tool and stay quiet after a successful result. ' +
  'Do not announce actions such as "The lecture is now paused" or "Playing now" because ' +
  'the control itself is the confirmation and speech can interrupt the lecture. ' +
  'Do not end the listening session yourself. The app handles its explicit Stop control; ' +
  'continue normally when a user merely mentions stopping or listening.';

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
    description: 'Seek the lecture to a position. Provide EITHER timestamp_seconds (absolute '
      + 'seconds from the start) OR a minutes+seconds pair. For "12 minutes 34 seconds" pass '
      + 'minutes=12, seconds=34 (= 754 seconds) — do NOT pass 1234. To jump to where a concept '
      + 'was explained, use the lecture context you were given to find its timestamp first.',
    parameters: { type: 'object',
      properties: {
        timestamp_seconds: { type: 'number', description: 'Absolute seconds from the start.' },
        minutes: { type: 'number', description: 'Minutes part (use with seconds).' },
        seconds: { type: 'number', description: 'Seconds part 0–59 (use with minutes).' },
      }, required: ['timestamp_seconds'] } },
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
                                      onUserPending, onAssistantInterrupted, onResponseStart,
                                      onMark, onTurnEnd, onMultipleSpeakers,
                                      multiSpeakerDetector,
                                      // Tunables (issue 3 — latency). silenceCallbacks controls how
                                      // many quiet ~85ms frames end a turn: 12≈2.0s (old), 6≈1.0s (new
                                      // default). Lower = snappier but risks cutting mid-sentence pauses.
                                      silenceCallbacks = 6,
                                      voice = 'default' } = {}) {
  let ws = null;
  let audioCtx = null, micStream = null, micNode = null, micSource = null;
  let outputGain = null, playHead = 0, scheduled = [];
  let state = 'idle';     // idle | connecting | live | speaking | error | closed
  let starting = false;
  let stopping = false;
  let sessionGeneration = 0; // invalidates async callbacks from a closed socket
  let activeResponseId = null;   // id of the response currently streaming (for stale-guarding)
  let activeAudioItemId = null;
  let audioPlaybackStartedAt = null;
  let detectorStarted = false;

  // ---- Manual-turn client VAD (adaptive) ----
  // A fixed RMS threshold fails because mic gain / room noise vary. Instead we
  // track an ADAPTIVE ambient floor during quiet frames and treat "speech" as
  // energy clearly above that floor. This rejects steady lecture/room bleed
  // (which raises the floor, not the margin) and still catches short words like
  // "yes/no/stop" (brief but well above ambient) — evidence of speech, not
  // duration. Noise-only turns are DISCARDED rather than transcribed, which is
  // the real fix for the hallucinated-transcript bug.
  let speaking = false;       // currently in a voiced segment
  let silenceFrames = 0;      // consecutive below-threshold frames
  let speechFrames = 0;       // above-threshold frames in THIS turn
  let awaitingAnswer = false;  // a turn is committed; ignore VAD until answered
  let noiseFloor = 0.006;     // adaptive ambient RMS estimate
  const ABS_FLOOR = 0.012;    // hard minimum "speech" energy (silence guard)
  const SPEECH_MARGIN = 2.2;  // speech must be this × the ambient floor
  const MIN_SPEECH_FRAMES = 2;   // ~0.17s of real voice → a valid turn (keeps "yes/no")
  const SILENCE_CALLBACKS = Math.max(2, silenceCallbacks | 0);  // quiet frames that end a turn
  const MAX_SPEECH_CALLBACKS = 180; // ~15s SAFETY fallback only, not the normal end

  // Barge-in: speech-onset WHILE Jarvis is speaking. Server turn_detection is
  // null (manual turns), so we detect locally — as voice clearly above ambient.
  const BARGEIN_MARGIN = 3.0;     // stricter than normal speech (over Jarvis audio)
  const BARGEIN_ABS = 0.02;
  const BARGEIN_FRAMES = 3;       // ~0.25s sustained before cutting Jarvis off
  let bargeFrames = 0;
  let cancelledResponseId = null; // audio deltas for this id are ignored (stale guard)
  let firstTextMarked = false, firstAudioMarked = false;  // latency instrumentation

  function setState(s, detail) { state = s; onState && onState(s, detail); }
  function mark(name, extra) { try { onMark && onMark(name, extra || {}); } catch {} }

  function rmsOf(samples) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    return Math.sqrt(sum / samples.length);
  }
  function speechThreshold() { return Math.max(ABS_FLOOR, noiseFloor * SPEECH_MARGIN); }

  function detectTurnEnd(samples) {
    // Server VAD owns turn detection + barge-in now; the client energy VAD is
    // only used in the legacy manual-turn fallback (TURN_DETECTION === null).
    if (TURN_DETECTION) return;
    // While Jarvis is speaking, run barge-in detection instead of turn-end.
    if (state === 'speaking') { detectBargeIn(samples); return; }
    if (awaitingAnswer) return;  // committed, waiting for answer — ignore VAD
    const rms = rmsOf(samples);
    const isSpeech = rms > speechThreshold();
    if (isSpeech) {
      if (!speaking) mark('vad_speech_start', { rms: +rms.toFixed(4), floor: +noiseFloor.toFixed(4) });
      speaking = true; silenceFrames = 0; speechFrames++;
      if (speechFrames >= MAX_SPEECH_CALLBACKS) { endTurn('max_timeout'); }   // safety only
    } else {
      // Update the ambient floor ONLY on non-speech frames (slow EMA).
      noiseFloor = noiseFloor * 0.95 + rms * 0.05;
      if (speaking) {
        silenceFrames++;
        if (silenceFrames >= SILENCE_CALLBACKS) {
          if (speechFrames >= MIN_SPEECH_FRAMES) endTurn('silence');
          else {
            // Not enough real voice — a blip/noise. Discard, do NOT transcribe.
            mark('turn_discarded', { reason: 'insufficient_speech', speechFrames });
            speaking = false; silenceFrames = 0; speechFrames = 0;
            clearInputBuffer();
          }
        }
      }
    }
  }

  function endTurn(reason) {
    mark('vad_speech_end', { reason, speechFrames });
    speaking = false; silenceFrames = 0; speechFrames = 0;
    commitTurn();   // user finished -> commit; server transcribes, no auto-response
  }

  // Drop the server-side input buffer so discarded noise never gets transcribed.
  function clearInputBuffer() { send({ type: 'input_audio_buffer.clear' }); }

  // Barge-in: user voice clearly above ambient, sustained, while Jarvis speaks.
  function detectBargeIn(samples) {
    const rms = rmsOf(samples);
    if (rms > Math.max(BARGEIN_ABS, noiseFloor * BARGEIN_MARGIN)) {
      bargeFrames++;
      if (bargeFrames >= BARGEIN_FRAMES) { bargeFrames = 0; bargeInCancel(); }
    } else {
      bargeFrames = 0;
    }
  }

  // Stop Looper promptly and cancel the active Higgs response (supported
  // protocol: response.cancel). Guard stale audio so late deltas don't restart
  // playback. Does NOT roll back any tool action that already executed.
  function interruptActiveResponse(reason = 'barge_in') {
    if (stopping || (activeResponseId && cancelledResponseId === activeResponseId)) return false;
    mark(reason);
    if (activeResponseId) cancelledResponseId = activeResponseId;
    stopPlayback();
    agentAudioOpen = false;
    // If local playback ended early, truncate the stored audio item to what the
    // person actually heard. Some server events do not expose an item id; in
    // that case cancellation is still safe and the native VAD owns the turn.
    if (activeAudioItemId) {
      send({ type: 'conversation.item.truncate', item_id: activeAudioItemId,
             content_index: 0, audio_end_ms: heardAudioEndMs() });
    }
    send({ type: 'response.cancel' });
    onAssistantInterrupted && onAssistantInterrupted(activeResponseId);
    onAgentAudioEnd && onAgentAudioEnd();
    return true;
  }

  function bargeInCancel() {
    if (state !== 'speaking') return;
    interruptActiveResponse('barge_in');
    awaitingAnswer = false;                    // allow the follow-up turn to commit
    speaking = false; silenceFrames = 0;
    setState('live', 'Listening…');
  }

  function commitTurn() {
    if (awaitingAnswer) return;
    awaitingAnswer = true;
    mark('turn_commit', { responseContext: activeResponseId });
    setState('live', 'Thinking…');
    send({ type: 'input_audio_buffer.commit' });
    // Response is NOT requested here — the host sequencer injects context first,
    // then calls requestResponse() (race fix).
  }

  /** Request a response. Under server/semantic VAD the server auto-creates the
   *  response on end-of-turn, so this is a NO-OP (calling it would duplicate the
   *  turn). Only the legacy manual mode (TURN_DETECTION === null) sends it. */
  function requestResponse() {
    if (TURN_DETECTION) return;
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
    const generation = ++sessionGeneration;
    stopping = false;
    cancelledResponseId = null;
    activeResponseId = null;
    activeAudioItemId = null;
    audioPlaybackStartedAt = null;
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
      if (stopping || generation !== sessionGeneration) { starting = false; return; }

      // 2) Open the WebSocket with the ephemeral key as subprotocol bearer.
      setState('connecting', 'Connecting to Higgs Realtime…');
      ws = new WebSocket(WS_URL, [
        'realtime',
        `bai-client-secret.${ephemeralKey}`,
        'openai-beta.realtime-v1',
      ]);
      ws.addEventListener('open', () => onOpen(generation));
      ws.addEventListener('message', (evt) => onMessage(evt, generation));
      ws.addEventListener('error', () => {
        if (!stopping && generation === sessionGeneration) setState('error', 'Connection error.');
      });
      ws.addEventListener('close', () => {
        if (generation !== sessionGeneration) return;
        teardownAudio();
        if (state !== 'error' && state !== 'closed') setState('closed', 'Session ended.');
        starting = false;
      });
    } catch (err) {
      if (!stopping && generation === sessionGeneration) setState('error', String(err.message || err));
      starting = false;
    }
  }

  async function onOpen(generation) {
    if (stopping || generation !== sessionGeneration) return;
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
            // SERVER-SIDE turn detection (semantic_vad): the server's speech
            // model decides turn start/end and auto-responds, and user speech
            // during playback natively cancels the response (barge-in). This
            // replaces the fragile client energy-VAD and fixes noise-hallucinated
            // transcripts, unreliable barge-in, and stuck "listening".
            // Grounding is kept race-free by injecting lecture context
            // PROACTIVELY (at activation + on seek), so it is already present
            // when the server auto-responds — no per-turn commit ordering needed.
            turn_detection: TURN_DETECTION,
          },
          output: { format: { type: 'audio/pcm', rate: SAMPLE_RATE }, voice },
        },
        temperature: 0.3,
        max_output_tokens: 'inf',
      },
    });
    try {
      await startMic();                       // mic streaming begins HERE, post-activation only
      if (stopping || generation !== sessionGeneration) return;
      setState('live', 'Listening — speak now.');
      starting = false;
      onReady && onReady();                   // host injects initial lecture context (G4)
    } catch (err) {
      setState('error', 'Microphone access failed: ' + (err?.message || err));
      stop();
    }
  }

  function onMessage(evt, generation) {
    if (stopping || generation !== sessionGeneration) return; // a close races with queued WS frames
    let msg; try { msg = JSON.parse(evt.data); } catch { return; }
    switch (msg.type) {
      case 'session.created': setState('live', 'Session ready — speak now.'); break;
      case 'input_audio_buffer.speech_started':
        // SERVER VAD detected speech start. If Jarvis is speaking, this is the
        // native BARGE-IN signal: stop local playback (the server truncates its
        // own in-flight response automatically). Mark the bubble interrupted.
        if (state === 'speaking' || agentAudioOpen) {
          interruptActiveResponse('barge_in');
        }
        onUserPending && onUserPending();      // user is speaking → provisional bubble
        setState('live', 'Listening…'); break;
      case 'input_audio_buffer.speech_stopped':
        // Server VAD ended the turn; a response will follow automatically. Keep
        // grounding fresh just before the answer (context is already injected
        // proactively; this is a best-effort top-up, NOT a blocking commit).
        onUserPending && onUserPending();
        onTurnEnd && onTurnEnd();
        setState('live', 'Thinking…'); break;
      case 'response.created': {
        // A NEW response is starting. Any audio still queued from the PREVIOUS
        // response must be stopped so Jarvis doesn't keep speaking the old answer
        // over the new one (audio is scheduled ahead of real time).
        const newId = (msg.response && msg.response.id) || msg.response_id || null;
        if (newId && newId !== activeResponseId) stopPlayback();
        activeResponseId = newId || activeResponseId;
        activeAudioItemId = msg.item_id || msg.output_item_id || null;
        audioPlaybackStartedAt = null;
        firstTextMarked = false; firstAudioMarked = false;
        mark('response_created', { responseId: activeResponseId });
        onResponseStart && onResponseStart(activeResponseId);
        setState('speaking', 'Looper is responding…'); agentAudioOpen = false; break;
      }
      case 'response.output_audio.delta':
      case 'response.audio.delta': {
        const rid = msg.response_id || activeResponseId;
        if (rid && (rid === cancelledResponseId || (activeResponseId && rid !== activeResponseId))) break;
        if (msg.item_id) activeAudioItemId = msg.item_id;
        if (msg.delta) { if (!firstAudioMarked) { firstAudioMarked = true; mark('first_audio'); } gateAndPlay(msg.delta); }
        break;
      }
      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta': {
        const rid = msg.response_id || activeResponseId;
        if (rid && (rid === cancelledResponseId || (activeResponseId && rid !== activeResponseId))) break;
        // Pass the response id so the host associates this delta with the right
        // message and ignores stale deltas from a superseded response.
        if (msg.delta) { if (!firstTextMarked) { firstTextMarked = true; mark('first_text'); } onAssistantText && onAssistantText(msg.delta, false, rid); }
        break;
      }
      case 'conversation.item.input_audio_transcription.completed':
        mark('transcription_completed');
        if (msg.transcript) onUserText && onUserText(msg.transcript);
        break;
      case 'response.done': {
        const doneRid = (msg.response && msg.response.id) || msg.response_id;
        if (doneRid && doneRid === cancelledResponseId) {
          // This is the server acknowledging our barge-in cancel. UI/state were
          // already handled in bargeInCancel(); don't re-finalize or re-set state.
          break;
        }
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
        {
          const doneId = (msg.response && msg.response.id) || msg.response_id || activeResponseId;
          // Optional authoritative final text from the completed response; the
          // host reconciles it with the streamed text (no double-append).
          let finalText = null;
          try {
            for (const it of output) {
              const parts = (it && it.content) || [];
              for (const p of parts) {
                if (p && (p.transcript || p.text)) finalText = (finalText || '') + (p.transcript || p.text);
              }
            }
          } catch {}
          onAssistantText && onAssistantText('', true, doneId, finalText);
        }
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
      else {
        // Audio suppression protects against overlap, but the text conversation
        // remains healthy.  Do not transition to terminal `error`: the host
        // would otherwise append this same status as a red chat card for every
        // new response and leave the microphone session in an invalid state.
        setState('live', 'Response audio suppressed while the lecture is playing.');
      }
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
    // Standard speech-capture constraints: echoCancellation + noiseSuppression
    // ON remove lecture/speaker bleed and room noise that caused the server STT
    // to hallucinate (the PlayStation/1980s bug). Barge-in no longer relies on
    // raw un-ducked voice — it uses a RELATIVE-energy detector (see detectBargeIn)
    // that works with AEC on. autoGainControl lifts quiet voices.
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (multiSpeakerDetector?.start) {
      // VAD/volume cannot identify people. The default implementation is an
      // explicit disabled fallback; a vetted local diarization/overlap model
      // can use this narrow, testable interface without network egress.
      detectorStarted = true;
      await multiSpeakerDetector.start({ stream: micStream, onMultipleSpeakers: () => {
        if (stopping) return;
        onMultipleSpeakers && onMultipleSpeakers();
        stop('multiple-speakers');
      } });
      if (stopping) return;
    }
    micSource = audioCtx.createMediaStreamSource(micStream);
    // Diagnostic (no raw audio): what the browser actually granted.
    try {
      const st = micStream.getAudioTracks()[0]?.getSettings?.() || {};
      mark('mic_constraints', { echoCancellation: st.echoCancellation, noiseSuppression: st.noiseSuppression,
                                autoGainControl: st.autoGainControl, sampleRate: st.sampleRate });
    } catch {}

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
    if (audioPlaybackStartedAt == null) audioPlaybackStartedAt = playHead;
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

  function heardAudioEndMs() {
    if (!audioCtx || audioPlaybackStartedAt == null) return 0;
    return Math.max(0, Math.floor((audioCtx.currentTime - audioPlaybackStartedAt) * 1000));
  }

  function teardownAudio() {
    stopPlayback();
    try { micNode && micNode.disconnect(); } catch {}
    try { micSource && micSource.disconnect(); } catch {}
    try { outputGain && outputGain.disconnect(); } catch {}
    if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
    if (detectorStarted) { try { multiSpeakerDetector?.stop?.(); } catch {} detectorStarted = false; }
    if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
    micNode = micSource = outputGain = null;
  }

  function stop(reason = 'stopped') {
    if (stopping || state === 'closed') return;
    stopping = true;
    sessionGeneration++;
    // stop() deliberately owns its own cancellation, not only response.done,
    // so scheduled audio and stale deltas cannot resurrect a closed session.
    if (activeResponseId && cancelledResponseId !== activeResponseId) {
      cancelledResponseId = activeResponseId;
      stopPlayback();
      if (activeAudioItemId) {
        send({ type: 'conversation.item.truncate', item_id: activeAudioItemId,
               content_index: 0, audio_end_ms: heardAudioEndMs() });
      }
      send({ type: 'response.cancel' });
      onAssistantInterrupted && onAssistantInterrupted(activeResponseId);
    }
    try { ws && ws.close(); } catch {}
    ws = null;
    teardownAudio();
    starting = false;
    setState('closed', reason === 'multiple-speakers' ? 'Multiple speakers detected.' : 'Session stopped.');
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

// LearnLoop local wake-word listener (G3.1).
//
// Production wrapper around the browser-local openWakeWord pipeline validated in
// the PoC (LL-G3.0). Fully local: microphone audio is processed in-browser by
// ONNX models via onnxruntime-web (vendored under /wakeword/ort + /wakeword/models).
// NOTHING is streamed to a server here. Higgs Realtime connection is a SEPARATE
// later step (G3.2) — this module only emits a local "detect" event.
//
// Phrase: the prebuilt "Hey Jarvis" model. Custom "Looper" is a later swap.
//
// The host page must provide an import map resolving "onnxruntime-web" to
// /wakeword/ort/ort.min.mjs.

const BASE = '/wakeword';

export function createWakeWordListener({ onDetect, onState, onLevel, onScore,
                                         detectionThreshold = 0.3, cooldownMs = 2000 } = {}) {
  let engine = null;
  let state = 'off';            // off | starting | listening | activated | error
  let lastActivationAt = 0;
  let lastFrameAt = 0;          // updated whenever the engine processes audio
  let watchdog = null;

  function setState(s, detail) {
    state = s;
    onState && onState(s, detail);
  }

  // Keep the engine's audio pipeline alive. The #1 cause of "detects once then
  // goes quiet with no error" is the engine's AudioContext getting SUSPENDED
  // (tab focus change, media playback re-routing audio). We resume it, and if
  // frames stop flowing for too long while listening, we restart the engine.
  function startWatchdog() {
    stopWatchdog();
    lastFrameAt = performance.now();
    watchdog = setInterval(async () => {
      if (!engine || state === 'off' || state === 'error' || state === 'starting') return;
      const ctx = engine._audioContext;
      try {
        if (ctx && ctx.state === 'suspended') await ctx.resume();
      } catch {}
      // If no audio frames for 6s while supposedly listening, the pipeline is
      // dead silently — restart it to re-arm detection.
      const quietFor = performance.now() - lastFrameAt;
      if ((state === 'listening' || state === 'activated') && quietFor > 6000) {
        await restart();
      }
    }, 2000);
  }

  // Poll the engine's latest keyword score (~10x/s) and surface it to the UI so
  // the user can SEE sensitivity without opening DevTools.
  let scorePoll = null;
  function startScorePoll() {
    stopScorePoll();
    scorePoll = setInterval(() => {
      try {
        const km = engine?._keywordModels?.['hey_jarvis'];
        if (km?.scores?.length) {
          const s = km.scores[km.scores.length - 1];
          if (typeof s === 'number') { lastFrameAt = performance.now(); onScore && onScore(s); }
        }
      } catch {}
    }, 100);
  }
  function stopScorePoll() { if (scorePoll) { clearInterval(scorePoll); scorePoll = null; } }
  function stopWatchdog() {
    if (watchdog) { clearInterval(watchdog); watchdog = null; }
  }

  async function restart() {
    try { await engine?.stop?.(); } catch {}
    engine = null;
    await startEngine();
  }

  async function enable() {
    if (state !== 'off' && state !== 'error') return;   // no duplicate starts
    if (!navigator.mediaDevices?.getUserMedia) {
      setState('error', 'Microphone not supported in this browser.');
      return;
    }
    setState('starting', 'Loading wake-word detector…');
    await startEngine();
  }

  // SINGLE audio pipeline: the engine owns the one microphone + AudioContext.
  async function startEngine() {
    try {
      const ort = await import('onnxruntime-web');   // resolved by host import map
      ort.env.wasm.numThreads = 1;                   // no COOP/COEP requirement
      const mod = await import(`${BASE}/vendor/WakeWordEngine.js`);
      const WakeWordEngine = mod.default || mod.WakeWordEngine;
      engine = new WakeWordEngine({
        baseAssetUrl: `${BASE}/models`,
        keywords: ['hey_jarvis'],
        detectionThreshold,     // default 0.1 (very sensitive; see false-activation caveat in worklog)
        cooldownMs,
        debug: true,            // temporary: need "Chunk received" rms/peak to diagnose silent audio
      });
      engine.on('error', (e) => setState('error', 'Detector error: ' + (e?.message || e)));
      // Every engine audio event stamps liveness for the watchdog.
      const touch = () => { lastFrameAt = performance.now(); };
      engine.on('speech-start', () => { touch(); onLevel && onLevel(0.6); });
      engine.on('speech-end', () => { touch(); onLevel && onLevel(0); });
      try { engine.on('score', ({ score }) => { touch(); onLevel && onLevel(Math.min(1, score)); }); } catch {}
      engine.on('detect', ({ keyword, score }) => {
        touch();
        const now = performance.now();
        if (now - lastActivationAt < cooldownMs) return;   // debounce one utterance
        lastActivationAt = now;
        setState('activated', `Heard "${keyword}" (${score.toFixed(2)})`);
        onDetect && onDetect({ keyword, score, at: now });
        onLevel && onLevel(1);
      });
      await engine.load();
      await engine.start();              // engine prompts for mic permission (first time)
      lastFrameAt = performance.now();
      setState('listening', 'Listening locally for "Hey Jarvis". No audio leaves your device.');
      startWatchdog();
      startScorePoll();
    } catch (e) {
      const n = e?.name || '';
      const msg = n === 'NotAllowedError' || n === 'SecurityError'
        ? 'Microphone permission denied. Click to retry and Allow.'
        : n === 'NotFoundError' ? 'No microphone found.'
        : n === 'NotReadableError' ? 'Microphone is in use by another app.'
        : 'Could not start wake-word detector: ' + (e?.message || e);
      setState('error', msg);
      try { await engine?.stop?.(); } catch {}
      engine = null;
    }
  }

  async function disable() {
    stopWatchdog();
    stopScorePoll();
    try { await engine?.stop?.(); } catch {}   // engine stops its own mic + context
    engine = null;
    onLevel && onLevel(0);
    setState('off', 'Wake word off.');
  }

  /** Manual activation fallback — same effect as a wake-word detection, so the
   *  demo never depends solely on the model firing. */
  function trigger() {
    const now = performance.now();
    lastActivationAt = now;
    setState('activated', 'Activated manually');
    onDetect && onDetect({ keyword: 'manual', score: 1, at: now });
  }

  return {
    enable, disable, trigger,
    get state() { return state; },
    isActive() { return state === 'listening' || state === 'starting' || state === 'activated'; },
    /** Called by the host after it has handled an activation, to resume passive listening. */
    resumeListening() { if (state === 'activated') setState('listening', 'Listening locally for "Hey Jarvis".'); },
  };
}

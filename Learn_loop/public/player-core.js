// Pure, framework-free player logic for LearnLoop G1.
//
// This module holds NO DOM references so it can be unit-tested in Node. It
// validates media selection, formats time, clamps seek/rate values, and tracks
// a small readiness state machine. The DOM layer (learn.js) drives a real
// <video> element and calls into this controller.

export const SUPPORTED_MIME = ['video/mp4', 'video/webm'];
export const SUPPORTED_EXT = ['mp4', 'webm'];
export const ALLOWED_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];

// Readiness states surfaced to the UI (criterion 5).
export const STATE = {
  IDLE: 'idle',
  LOADING: 'loading',       // metadata not yet known
  READY: 'ready',           // canplay fired; playback allowed
  PLAYING: 'playing',
  PAUSED: 'paused',
  ENDED: 'ended',
  ERROR: 'error',
};

/** Validate a selected File. Returns { ok, reason? }. */
export function validateFile(file) {
  if (!file) return { ok: false, reason: 'No file selected.' };
  const name = file.name || '';
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  const typeOk = file.type ? SUPPORTED_MIME.includes(file.type) : false;
  const extOk = SUPPORTED_EXT.includes(ext);
  // Accept if either the MIME type or the extension is a supported video.
  // (Some browsers report an empty type for local files.)
  if (!typeOk && !extOk) {
    return { ok: false, reason: `Unsupported file type. Use ${SUPPORTED_EXT.join(' or ').toUpperCase()}.` };
  }
  return { ok: true };
}

/** Format seconds as m:ss or h:mm:ss. NaN/Infinity -> "0:00". */
export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const ss = String(s).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}

/** Clamp a seek target into [0, duration]. Unknown duration -> max(0, target). */
export function clampSeek(target, duration) {
  if (!Number.isFinite(target)) return 0;
  const lo = 0;
  const hi = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
  return Math.min(Math.max(target, lo), hi);
}

/** Normalize a requested playback rate to the nearest allowed value. */
export function normalizeRate(rate) {
  const r = Number(rate);
  if (!Number.isFinite(r)) return 1;
  if (ALLOWED_RATES.includes(r)) return r;
  // snap to nearest allowed
  return ALLOWED_RATES.reduce((best, v) =>
    Math.abs(v - r) < Math.abs(best - r) ? v : best, ALLOWED_RATES[0]);
}

/**
 * Create a controller around a minimal "media" port so it is testable without
 * a browser. `media` must expose: currentTime, duration, playbackRate,
 * paused (getter), play(), pause(). In the browser this is the <video> element.
 */
export function createPlayerController(media) {
  let state = STATE.IDLE;
  const listeners = new Set();

  function setState(next) {
    if (next === state) return;
    state = next;
    for (const fn of listeners) fn(state);
  }

  return {
    get state() { return state; },
    onStateChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    // Lifecycle signals driven by the DOM layer's media events.
    markLoading() { setState(STATE.LOADING); },
    markReady() { if (state === STATE.LOADING || state === STATE.IDLE) setState(STATE.READY); },
    markPlaying() { setState(STATE.PLAYING); },
    markPaused() { if (state !== STATE.ENDED && state !== STATE.ERROR) setState(STATE.PAUSED); },
    markEnded() { setState(STATE.ENDED); },
    markError() { setState(STATE.ERROR); },
    reset() { setState(STATE.IDLE); },

    canControl() {
      return state === STATE.READY || state === STATE.PLAYING ||
             state === STATE.PAUSED || state === STATE.ENDED;
    },

    togglePlay() {
      if (!this.canControl()) return;
      if (media.paused) media.play(); else media.pause();
    },

    seekTo(target) {
      if (!this.canControl()) return;
      media.currentTime = clampSeek(target, media.duration);
    },

    seekBy(delta) {
      if (!this.canControl()) return;
      media.currentTime = clampSeek((media.currentTime || 0) + delta, media.duration);
    },

    setRate(rate) {
      media.playbackRate = normalizeRate(rate);
      return media.playbackRate;
    },

    times() {
      return {
        current: media.currentTime || 0,
        duration: Number.isFinite(media.duration) ? media.duration : 0,
        label: `${formatTime(media.currentTime || 0)} / ${formatTime(media.duration)}`,
      };
    },
  };
}

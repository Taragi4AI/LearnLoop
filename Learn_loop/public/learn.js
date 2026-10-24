// LearnLoop G1 — DOM wiring for the playable lecture foundation.
//
// Responsibilities:
//   - Let the user choose a local MP4/WebM via click or drag-drop.
//   - Play it immediately (object URL) with no upload / transcription / AI.
//   - Drive deterministic local controls: play/pause, seek, speed, +/-10s.
//   - Report media readiness and surface load/playback errors honestly.
//
// All media logic lives in player-core.js (unit-tested). This file only binds
// that controller to real DOM + <video> events.

import { createPlayerController, validateFile, formatTime, STATE } from './player-core.js';
import { el } from './shared.js';
import { createSearchNav } from './search-nav.js';
import { createWakeWordListener } from './wakeword.js';
import { createLooperSession } from './looper-realtime.js';
import { createTurnSequencer } from './turn-sequencer.js';
import { shouldApplyResponseEvent, reconcileFinalText, autoScrollDecision } from './chat-stream.js';

const $ = (sel) => document.querySelector(sel);

const els = {
  picker: $('#picker'),
  dropZone: $('#dropZone'),
  fileInput: $('#fileInput'),
  pickerMsg: $('#pickerMsg'),
  playerWrap: $('#playerWrap'),
  lectureTitle: $('#lectureTitle'),
  closeBtn: $('#closeBtn'),
  video: $('#video'),
  videoOverlay: $('#videoOverlay'),
  mediaState: $('#mediaState'),
  playPause: $('#playPause'),
  seek: $('#seek'),
  timeLabel: $('#timeLabel'),
  rate: $('#rate'),
  back10: $('#back10'),
  fwd10: $('#fwd10'),
  playerError: $('#playerError'),
};

const player = createPlayerController(els.video);
let currentObjectUrl = null;
let seeking = false;

// ---- Key status banner (reuses the M0 /api/health route) ----
async function checkHealth() {
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    $('#keyDot').className = 'dot ' + (data.keyConfigured ? 'good' : 'bad');
    $('#keyLabel').textContent = data.keyConfigured ? 'API key configured' : 'No API key — see .env';
  } catch {
    $('#keyDot').className = 'dot bad';
    $('#keyLabel').textContent = 'server unreachable';
  }
}

// ---- State → UI label ----
const STATE_LABEL = {
  [STATE.IDLE]: 'Idle',
  [STATE.LOADING]: 'Loading media…',
  [STATE.READY]: 'Ready to play',
  [STATE.PLAYING]: 'Playing',
  [STATE.PAUSED]: 'Paused',
  [STATE.ENDED]: 'Ended',
  [STATE.ERROR]: 'Media error',
};

player.onStateChange((s) => {
  els.mediaState.textContent = STATE_LABEL[s] || s;
  els.mediaState.dataset.state = s;
  const playable = player.canControl();
  els.playPause.disabled = !playable;
  els.seek.disabled = !playable;
  els.back10.disabled = !playable;
  els.fwd10.disabled = !playable;
  els.playPause.textContent = s === STATE.PLAYING ? '❚❚' : '▶︎';
  els.playPause.setAttribute('aria-label', s === STATE.PLAYING ? 'Pause' : 'Play');
  if (s !== STATE.ERROR) els.playerError.textContent = '';
});

// ---- File selection ----
function pickerError(msg) {
  els.pickerMsg.textContent = msg;
  els.pickerMsg.className = 'picker-msg err';
}
function pickerInfo(msg) {
  els.pickerMsg.textContent = msg;
  els.pickerMsg.className = 'picker-msg';
}

function handleFile(file) {
  // Cancelled selection: no file, no error, no crash (criterion 6).
  if (!file) { pickerInfo(''); return; }

  const v = validateFile(file);
  if (!v.ok) { pickerError(v.reason); return; }

  pickerInfo('');
  loadLecture(file);
}

function loadLecture(file) {
  // Revoke any previous URL to avoid leaks.
  if (currentObjectUrl) { URL.revokeObjectURL(currentObjectUrl); currentObjectUrl = null; }

  currentObjectUrl = URL.createObjectURL(file);
  els.lectureTitle.textContent = file.name || 'Lecture';
  els.playerError.textContent = '';
  els.picker.classList.add('hidden');
  els.playerWrap.classList.remove('hidden');

  player.markLoading();
  els.video.src = currentObjectUrl;
  els.video.load();

  // Automatically upload + start processing (no second manual action).
  autoProcess(file);
}

function closeLecture() {
  try { els.video.pause(); } catch {}
  els.video.removeAttribute('src');
  els.video.load();
  if (currentObjectUrl) { URL.revokeObjectURL(currentObjectUrl); currentObjectUrl = null; }
  player.reset();
  els.playerWrap.classList.add('hidden');
  els.picker.classList.remove('hidden');
  els.fileInput.value = '';
  els.timeLabel.textContent = '0:00 / 0:00';
  els.seek.value = '0';
  els.seek.max = '0';
}

// ---- Wire file input + drop zone ----
els.dropZone.addEventListener('click', () => els.fileInput.click());
els.dropZone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.fileInput.click(); }
});
els.fileInput.addEventListener('change', (e) => handleFile(e.target.files?.[0]));

els.dropZone.addEventListener('dragover', (e) => { e.preventDefault(); els.dropZone.classList.add('drag'); });
els.dropZone.addEventListener('dragleave', () => els.dropZone.classList.remove('drag'));
els.dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  els.dropZone.classList.remove('drag');
  handleFile(e.dataTransfer?.files?.[0]);
});

els.closeBtn.addEventListener('click', closeLecture);

// ---- Controls ----
els.playPause.addEventListener('click', () => player.togglePlay());
els.back10.addEventListener('click', () => player.seekBy(-10));
els.fwd10.addEventListener('click', () => player.seekBy(10));
els.rate.addEventListener('change', () => {
  const applied = player.setRate(els.rate.value);
  els.rate.value = String(applied);
});

els.seek.addEventListener('input', () => { seeking = true; });
els.seek.addEventListener('change', () => {
  player.seekTo(Number(els.seek.value));
  seeking = false;
});

// ---------------------------------------------------------------------------
// Player display settings (fit / aspect ratio / size), volume+mute, fullscreen.
// Display prefs are DISPLAY-CONTAINER only — they never touch the source video.
// Persisted locally (non-sensitive); fullscreen is transient and NOT persisted.
// ---------------------------------------------------------------------------
const videoShell = $('#videoShell');
const centerCol = $('#centerCol');
const PREF_KEY = 'learnloop.displayPrefs.v1';

function loadDisplayPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
    return {
      fit: ['contain', 'cover'].includes(p.fit) ? p.fit : 'contain',
      ratio: ['auto', '16/9', '4/3'].includes(p.ratio) ? p.ratio : 'auto',
      size: ['compact', 'comfortable', 'large'].includes(p.size) ? p.size : 'large',
    };
  } catch { return { fit: 'contain', ratio: 'auto', size: 'large' }; }
}
function saveDisplayPrefs(p) {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch {}
}
let displayPrefs = loadDisplayPrefs();

function applyDisplayPrefs() {
  // Shell data-attributes drive the CSS; source video is never distorted.
  videoShell.dataset.fit = displayPrefs.fit;
  videoShell.dataset.ratio = displayPrefs.ratio;
  centerCol.dataset.size = displayPrefs.size;
  // Reflect selection in the menu's radio buttons (state + a11y).
  document.querySelectorAll('#playerSettings .seg-btn').forEach((btn) => {
    const on = (btn.dataset.size === displayPrefs.size)
            || (btn.dataset.fit === displayPrefs.fit)
            || (btn.dataset.ratio === displayPrefs.ratio);
    btn.setAttribute('aria-checked', on ? 'true' : 'false');
    btn.classList.toggle('sel', on);
  });
}
applyDisplayPrefs();

// Segmented-control clicks update the matching pref dimension.
document.querySelectorAll('#playerSettings .seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.size) displayPrefs.size = btn.dataset.size;
    else if (btn.dataset.fit) displayPrefs.fit = btn.dataset.fit;
    else if (btn.dataset.ratio) displayPrefs.ratio = btn.dataset.ratio;
    saveDisplayPrefs(displayPrefs);
    applyDisplayPrefs();
  });
});

// Settings menu open/close (progressive disclosure). Closes on outside click + Esc.
const settingsBtn = $('#settingsBtn');
const settingsMenu = $('#playerSettings');
function setSettingsOpen(open) {
  settingsMenu.classList.toggle('hidden', !open);
  settingsBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
}
settingsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  setSettingsOpen(settingsMenu.classList.contains('hidden'));
});
document.addEventListener('click', (e) => {
  if (!settingsMenu.classList.contains('hidden') && !settingsMenu.contains(e.target) && e.target !== settingsBtn) {
    setSettingsOpen(false);
  }
});

// Volume + mute (playback audio controls; kept separate from display settings).
const volume = $('#volume');
const muteBtn = $('#muteBtn');
function reflectMute() {
  const muted = player.isMuted() || player.getVolume() === 0;
  muteBtn.textContent = muted ? '🔇' : '🔊';
  muteBtn.setAttribute('aria-pressed', muted ? 'true' : 'false');
  muteBtn.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
}
volume.addEventListener('input', () => {
  player.setVolume(Number(volume.value));
  if (Number(volume.value) > 0 && player.isMuted()) player.setMuted(false);
  reflectMute();
});
muteBtn.addEventListener('click', () => {
  const nowMuted = !player.isMuted();
  player.setMuted(nowMuted);
  reflectMute();
});
reflectMute();   // initial sync

// Fullscreen on the video shell (so controls/overlay come along where supported).
const fullscreenBtn = $('#fullscreenBtn');
async function toggleFullscreen() {
  try {
    if (!document.fullscreenElement) {
      if (videoShell.requestFullscreen) await videoShell.requestFullscreen();
      else els.video.webkitEnterFullscreen && els.video.webkitEnterFullscreen();  // iOS fallback
    } else {
      await document.exitFullscreen();
    }
  } catch (err) {
    els.playerError.textContent = 'Fullscreen is not available: ' + (err?.message || err);
  }
}
fullscreenBtn.addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', () => {
  const fs = !!document.fullscreenElement;
  fullscreenBtn.setAttribute('aria-pressed', fs ? 'true' : 'false');
  videoShell.classList.toggle('is-fullscreen', fs);
});

// Transcript-follow toggle (default OFF). Only affects whether the transcript's
// OWN container scrolls to the active segment — never the page or focus.
const followToggle = $('#followTranscript');
followToggle.addEventListener('change', () => { followTranscript = followToggle.checked; });

// Keyboard: Escape closes the settings menu; Space toggles play.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !settingsMenu.classList.contains('hidden')) {
    setSettingsOpen(false); settingsBtn.focus(); return;
  }
  if (els.playerWrap.classList.contains('hidden')) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
  if (e.code === 'Space') { e.preventDefault(); player.togglePlay(); }
});

// ---- Real <video> media events drive the controller + UI ----
els.video.addEventListener('loadstart', () => player.markLoading());
els.video.addEventListener('loadedmetadata', () => {
  els.seek.max = String(Number.isFinite(els.video.duration) ? els.video.duration : 0);
  updateTime();
});
els.video.addEventListener('canplay', () => player.markReady());
els.video.addEventListener('play', () => player.markPlaying());
els.video.addEventListener('pause', () => player.markPaused());
els.video.addEventListener('ended', () => player.markEnded());
els.video.addEventListener('timeupdate', updateTime);
els.video.addEventListener('durationchange', () => {
  els.seek.max = String(Number.isFinite(els.video.duration) ? els.video.duration : 0);
  updateTime();
});
els.video.addEventListener('error', () => {
  player.markError();
  els.playerError.textContent = describeMediaError(els.video.error);
});

function updateTime() {
  const t = player.times();
  els.timeLabel.textContent = t.label;
  if (!seeking) els.seek.value = String(t.current);
}

function describeMediaError(err) {
  if (!err) return 'The media could not be played.';
  switch (err.code) {
    case 1: return 'Media load was aborted.';
    case 2: return 'A network error interrupted the media download.';
    case 3: return 'The media is corrupt or uses an unsupported codec.';
    case 4: return 'This media format or codec is not supported by your browser.';
    default: return 'The media could not be played.';
  }
}

// ---------------------------------------------------------------------------
// Looper voice — G3.1: local wake-word detection only (no Realtime yet).
// Explicit enable/disable; local-only; on detection, show an unmistakable
// activated state and pause the video. Mic audio is NOT streamed anywhere.
// ---------------------------------------------------------------------------
const ww = {
  toggle: $('#wwToggle'),
  manual: $('#wwManual'),
  state: $('#wwState'),
  hint: $('#wwHint'),
  meter: $('#wwMeter'),
  score: $('#wwScore'),
  activated: $('#wwActivated'),
  convo: $('#looperConvo'),
  rtState: $('#rtState'),
  rtStop: $('#rtStop'),
  rtExport: $('#rtExport'),
  rtLog: $('#rtLog'),
};

// ---- Looper live conversation (G3.2) ----
const RT_LABEL = {
  idle: 'idle', connecting: 'connecting…', live: 'listening',
  speaking: 'Jarvis speaking', closed: 'stopped', error: 'error',
};
let rtActive = false;
let assistantBubble = null;
let userBubble = null;        // provisional/finalized user bubble for the current turn
let activeResponseId = null;  // id of the response currently streaming (stale-event guard)
let userStoppedExplicitly = false;  // user said/clicked Stop → do NOT auto-restart listening

// Does the user transcript contain an explicit "stop listening" control phrase?
// Handled as a COMMAND (end the conversation) rather than a question for Jarvis.
function isStopListeningCommand(text) {
  const s = (text || '').toLowerCase();
  return /\bstop listening\b/.test(s)
      || /\b(stop|quit|end|exit|close)\b.*\b(listening|conversation|talking|session|jarvis)\b/.test(s)
      || /\b(that'?s all|never mind|nevermind|go away|dismiss)\b/.test(s);
}

// ---- Conversation debug log (timestamped event timeline, exportable as JSON) ----
let convoLog = [];
let convoStartMs = 0;
function logEvent(type, data) {
  const now = Date.now();
  convoLog.push({
    t_iso: new Date(now).toISOString(),
    t_rel_ms: convoStartMs ? now - convoStartMs : 0,   // ms since session start
    type,
    ...(data || {}),
  });
}
function resetConvoLog() {
  convoLog = [];
  convoStartMs = Date.now();
  logEvent('session_start', {
    lecture_id: currentVideoId || null,
    lecture_title: els.lectureTitle.textContent || null,
    position_s: Number((els.video.currentTime || 0).toFixed(2)),
  });
}
function exportConvoLog() {
  if (!convoLog.length) { addConvo('system', 'No conversation to export yet.'); return; }
  const payload = {
    exported_at: new Date().toISOString(),
    lecture_id: currentVideoId || null,
    lecture_title: els.lectureTitle.textContent || null,
    event_count: convoLog.length,
    events: convoLog,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a', {
    href: url,
    download: `looper-chat-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// G4 race-free turn sequencer: on each user turn, fetch question-scoped context,
// inject it, THEN request the response. Stale lecture/turn results are dropped.
const turnSeq = createTurnSequencer({
  fetchContext: async ({ question, lectureId, position, turnId }) => {
    logEvent('context_fetch_start', { turnId, lectureId, position_s: Number(position.toFixed(2)), question });
    showCue('retrieving');   // B — lecture-context retrieval is actually running
    const qs = question ? `&q=${encodeURIComponent(question)}` : '';
    const res = await fetch(`/api/lectures/${lectureId}/context?t=${position.toFixed(2)}${qs}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || `${res.status}`);
    logEvent('context_fetch_done', {
      turnId, has_transcript: data.has_transcript,
      segment_count: (data.segments || []).length,
      segment_times: (data.segments || []).map((s) => ({ kind: s.kind, start: s.start })),
      message_chars: (data.message || '').length,
    });
    // B — show a clickable timestamp card for the most relevant passage found,
    // or an honest "nothing found" note. Never fabricate a passage.
    showRetrievalResult(data);
    return data;
  },
  inject: (ctx, { turnId } = {}) => {
    looper.sendContext(ctx.message);
    logEvent('context_injected', { turnId, message_preview: (ctx.message || '').slice(0, 300) });
  },
  requestResponse: async ({ grounded, turnId }) => {
    if (!grounded) {
      looper.sendContext('[LearnLoop] Transcript context is unavailable for this question; ' +
        'answer only from general knowledge and say you cannot confirm what the lecturer said.');
    }
    looper.requestResponse();
    logEvent('response_requested', { turnId, grounded });
  },
  onError: (kind) => { addConvo('system', 'Context delivery issue: ' + kind); logEvent('context_error', { kind }); flashCue('retrieving', "Couldn't reach the lecture transcript — answering from general knowledge."); },
});

// B — render retrieval outcome: a rich clickable card (thumbnail/play +
// timestamp + concept title + supporting text + chevron), or an honest message
// when none was found. Picks the 'position' segment (live passage) else first.
function showRetrievalResult(data) {
  const segs = (data && data.segments) || [];
  if (!data || !data.has_transcript || !segs.length) {
    flashCue('retrieving', 'No matching lecture moment found', { tone: 'ok', ms: 3000 });
    return;
  }
  const seg = segs.find((s) => s.kind === 'position') || segs[0];
  const t = Number(seg.start) || 0;
  const concept = conceptTitleFrom(seg.text);
  // Build the card: [thumb/play] [ time · concept / supporting ] [chevron]
  const card = el('button', { className: 'cue-reveal', type: 'button',
    title: 'Jump to ' + formatTime(t) });
  const thumb = el('span', { className: 'cue-thumb' });
  thumb.innerHTML = SVG.play;                       // play-icon tile (default / fallback)
  const body = el('span', { className: 'cue-reveal-body' });
  body.append(el('span', { className: 'cue-reveal-title',
    innerHTML: '<b>' + formatTime(t) + '</b> · ' + escapeText(concept) }));
  body.append(el('span', { className: 'cue-reveal-sub', textContent: 'Relevant lecture passage found' }));
  const chev = el('span', { className: 'cue-chevron' }); chev.innerHTML = SVG.chevron;
  card.append(thumb, body, chev);
  card.addEventListener('click', () => {
    seekPlayer(t);
    flashCue('action', 'Moved to ' + formatTime(t), { sub: 'Opened the relevant lecture moment' });
  });
  showCue('retrieving', { label: 'Found in your lecture', extraHtml: '' });
  cue.dots.classList.remove('on');
  cue.extra.append(card);
  // Try a REAL frame thumbnail off the main player; fall back silently to the
  // play tile if capture isn't possible (CORS/seek/unavailable frame).
  captureFrameThumb(t).then((url) => { if (url) { thumb.style.backgroundImage = `url(${url})`; thumb.classList.add('has-img'); } }).catch(() => {});
}

// Derive a short concept title from a transcript line (first clause, capped).
function conceptTitleFrom(text) {
  const s = (text || '').trim();
  if (!s) return 'lecture moment';
  const clause = s.split(/[.,;:]/)[0].trim();
  const words = clause.split(/\s+/).slice(0, 5).join(' ');
  return (words || clause).slice(0, 40);
}
function escapeText(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// Capture a single video frame at `t` WITHOUT touching the live player:
// an offscreen cloned <video> loads the same source, seeks, draws to a canvas.
// Returns a data URL, or null on any failure (CORS taint, no source, timeout).
// The main player's src/currentTime/paused are never read or modified.
let _thumbVideo = null;
function captureFrameThumb(t) {
  return new Promise((resolve) => {
    try {
      const mainSrc = els.video.currentSrc || els.video.src;
      if (!mainSrc) return resolve(null);
      const v = _thumbVideo || (_thumbVideo = document.createElement('video'));
      v.muted = true; v.preload = 'auto'; v.crossOrigin = 'anonymous';
      let done = false;
      const finish = (val) => { if (done) return; done = true; v.onseeked = v.onerror = v.onloadeddata = null; resolve(val); };
      const timer = setTimeout(() => finish(null), 2500);   // never hang
      v.onerror = () => { clearTimeout(timer); finish(null); };
      v.onseeked = () => {
        try {
          const w = 128, h = Math.max(1, Math.round(w * (v.videoHeight || 72) / (v.videoWidth || 128)));
          const c = document.createElement('canvas'); c.width = w; c.height = h;
          c.getContext('2d').drawImage(v, 0, 0, w, h);
          const url = c.toDataURL('image/jpeg', 0.6);       // throws if the canvas is tainted (CORS)
          clearTimeout(timer); finish(url);
        } catch { clearTimeout(timer); finish(null); }       // tainted → graceful fallback
      };
      if (v.src !== mainSrc) { v.src = mainSrc; v.onloadeddata = () => { try { v.currentTime = Math.max(0, t); } catch { finish(null); } }; }
      else { try { v.currentTime = Math.max(0, t); } catch { finish(null); } }
    } catch { resolve(null); }
  });
}

// Initial (no-question) lecture context injected at activation, before any turn.
async function injectInitialContext() {
  if (!currentVideoId) {
    looper.sendContext('[LearnLoop] No lecture is currently loaded; no transcript context. ' +
      'If asked what the lecturer said, say you have no transcript to confirm.');
    return;
  }
  const t = els.video.currentTime || 0;
  try {
    const res = await fetch(`/api/lectures/${currentVideoId}/context?t=${t.toFixed(2)}`);
    const data = await res.json();
    if (res.ok) {
      looper.sendContext(data.message);
      logEvent('initial_context_injected', {
        has_transcript: data.has_transcript,
        segment_count: (data.segments || []).length,
        position_s: Number(t.toFixed(2)),
      });
    }
  } catch (err) { addConvo('system', 'Initial context failed: ' + err.message); logEvent('initial_context_error', { error: String(err.message) }); }
}

// Proactive, throttled context refresh (server-VAD grounding fix). Because the
// server auto-responds on end-of-turn, we keep the lecture context CURRENT in
// the conversation ahead of time — at activation, when the user starts a turn,
// and after a seek — so grounding is already present when the answer begins.
// Throttled so rapid events don't spam context items.
let _lastCtxInjectMs = 0;
let _lastCtxPos = -1;
async function refreshContextProactively(reason) {
  if (!rtActive || !currentVideoId) return;
  const now = Date.now();
  const pos = els.video.currentTime || 0;
  // Skip if we injected very recently at nearly the same position.
  if (now - _lastCtxInjectMs < 1500 && Math.abs(pos - _lastCtxPos) < 5) return;
  _lastCtxInjectMs = now; _lastCtxPos = pos;
  try {
    const res = await fetch(`/api/lectures/${currentVideoId}/context?t=${pos.toFixed(2)}`);
    const data = await res.json();
    if (res.ok && data.message) {
      looper.sendContext(data.message);
      logEvent('proactive_context', { reason, position_s: Number(pos.toFixed(2)),
        has_transcript: data.has_transcript, segment_count: (data.segments || []).length });
    }
  } catch (err) { logEvent('proactive_context_error', { reason, error: String(err.message) }); }
}

// ---------------------------------------------------------------------------
// G5 agentic tool execution. The model proposes actions; the host VALIDATES
// against trusted app state (currentVideoId, real player) and EXECUTES, then
// returns a confirmed result. Success is only claimed after real confirmation.
// ---------------------------------------------------------------------------
const pendingBookmarks = new Map();   // proposalId -> {title, timestamp, note, lectureId}

function _dur() { return Number.isFinite(els.video.duration) ? els.video.duration : null; }

async function executeTool(name, args) {
  // Returns a plain object -> serialized as function_call_output. Always honest.
  switch (name) {
    case 'control_video': {
      const action = String(args.action || '').toLowerCase();
      const secs = Number.isFinite(args.seconds) ? Math.abs(args.seconds) : 10;
      if (!player.canControl()) return { ok: false, error: 'No lecture is loaded/ready.' };
      const pos = () => Number(player.position().toFixed(2));
      switch (action) {
        case 'pause':
          player.pause();
          return player.isPlaying() ? { ok: false, error: 'Could not pause the lecture.' }
                                    : { ok: true, action, paused: true, position: pos() };
        case 'play': case 'resume':
          player.play();
          // User wants to watch: let the lecture keep playing and suppress
          // Looper's spoken "playing now" so it doesn't re-pause the video.
          keepPlayingThroughNextSpeech = true;
          resumeLectureOnSpeechEnd = true;   // also restore on session end
          return player.isPlaying() ? { ok: true, action: 'play', paused: false, position: pos() }
                                    : { ok: false, error: 'Could not resume playback.' };
        case 'rewind': player.seekBy(-secs); return { ok: true, action, seconds: secs, position: pos() };
        case 'forward': player.seekBy(secs); return { ok: true, action, seconds: secs, position: pos() };
        case 'replay': {  // replay the last N seconds and play
          player.seekBy(-secs); player.play();
          keepPlayingThroughNextSpeech = true;   // user wants to watch the replay
          resumeLectureOnSpeechEnd = true;
          return { ok: true, action, seconds: secs, position: pos(), playing: player.isPlaying() };
        }
        case 'mute': return { ok: true, action, muted: player.setMuted(true) };
        case 'unmute': return { ok: true, action, muted: player.setMuted(false) };
        case 'volume_up': { const v = player.setVolume(player.getVolume() + 0.2); return { ok: true, action, volume: Number(v.toFixed(2)) }; }
        case 'volume_down': { const v = player.setVolume(player.getVolume() - 0.2); return { ok: true, action, volume: Number(v.toFixed(2)) }; }
        case 'set_volume': {
          if (!Number.isFinite(args.level)) return { ok: false, error: 'level (0.0–1.0) required.' };
          const v = player.setVolume(args.level); return { ok: true, action, volume: Number(v.toFixed(2)) };
        }
        case 'set_speed': case 'set_rate': {
          const r = Number(args.rate ?? args.speed);
          if (!Number.isFinite(r)) return { ok: false, error: 'rate required.' };
          const applied = player.setRate(r);   // normalizeRate clamps to allowed set
          return { ok: true, action, rate: applied };
        }
        default: return { ok: false, error: `Unknown action "${action}".` };
      }
    }
    case 'get_player_state': {
      if (!player.canControl()) return { ok: true, loaded: false };
      return { ok: true, loaded: true,
               position_seconds: Number(player.position().toFixed(2)),
               duration_seconds: _dur(),
               playing: player.isPlaying(),
               rate: player.rate(),
               volume: Number((player.getVolume() ?? 1).toFixed(2)),
               muted: player.isMuted() };
    }
    case 'seek_video': {
      // Resolve the target seconds. Accept an explicit timestamp_seconds, OR a
      // minutes/seconds pair (unambiguous path for "12 minutes 34 seconds" →
      // 754s), so the model isn't forced to pre-compute and can't confuse 12:34
      // with 1234. If both given, timestamp_seconds wins.
      let t = Number(args.timestamp_seconds);
      if (!Number.isFinite(t) && (args.minutes != null || args.seconds != null)) {
        t = (Number(args.minutes) || 0) * 60 + (Number(args.seconds) || 0);
      }
      if (!Number.isFinite(t) || t < 0) return { ok: false, error: 'Invalid timestamp.' };
      const dur = _dur();
      if (dur != null && t > dur + 0.5) return { ok: false, error: `Timestamp ${formatTime(t)} is past the end (${formatTime(dur)}).` };
      if (!player.canControl()) return { ok: false, error: 'No lecture is loaded/ready.' };
      // Seek and VERIFY asynchronously — the <video> reaches the target after a
      // 'seeked' event (mid-video seeks need buffering/Range), so reading
      // currentTime synchronously was reporting a stale/false position.
      const landed = await seekAndConfirm(t);
      if (!landed.ok) return { ok: false, error: landed.error || 'The video did not move to that position.' };
      refreshContextProactively('seek');   // ground follow-ups at the new position
      return { ok: true, requested: Number(t.toFixed(2)), position: Number(landed.position.toFixed(2)) };
    }
    case 'prepare_bookmark': {
      if (!currentVideoId) return { ok: false, error: 'No lecture loaded.' };
      const t = Number.isFinite(args.timestamp_seconds) ? args.timestamp_seconds : (els.video.currentTime || 0);
      const dur = _dur();
      if (t < 0 || (dur != null && t > dur + 0.5)) return { ok: false, error: 'Timestamp out of range.' };
      const title = String(args.title || '').trim();
      if (!title) return { ok: false, error: 'A title is required.' };
      const pid = 'prop_' + Math.random().toString(36).slice(2, 10);
      pendingBookmarks.set(pid, { title, timestamp: t, note: args.note || null,
                                  lectureId: currentVideoId, excerpt: nearestExcerpt(t) });
      renderPendingBookmark(pid);           // show preview; NOT persisted
      return { ok: true, prepared: true, bookmark_id: pid, title, timestamp_seconds: Number(t.toFixed(2)),
               needs_user_approval: true, message: 'Proposed — awaiting the user to approve/save.' };
    }
    case 'save_bookmark': {
      const pid = String(args.bookmark_id || '');
      const prop = pendingBookmarks.get(pid);
      if (!prop) return { ok: false, error: 'No such pending bookmark (stale or already saved).' };
      if (prop.lectureId !== currentVideoId) { pendingBookmarks.delete(pid); return { ok: false, error: 'Lecture changed; proposal void.' }; }
      try {
        const saved = await persistBookmark(prop);
        pendingBookmarks.delete(pid);       // consume: cannot be saved twice
        clearPendingBookmark(pid);
        justSavedBookmarkId = saved.id;     // confirmation flash after DB confirms
        loadBookmarks();
        return { ok: true, saved: true, id: saved.id, title: saved.title, timestamp_seconds: saved.timestamp_seconds };
      } catch (err) {
        return { ok: false, error: 'Save failed: ' + err.message };
      }
    }
    case 'list_bookmarks': {
      if (!currentVideoId) return { ok: false, error: 'No lecture loaded.' };
      try {
        const res = await fetch(`/api/lectures/${currentVideoId}/bookmarks`);
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error?.message || `${res.status}`);
        return { ok: true, count: data.count, bookmarks: data.bookmarks.map((b) => ({ id: b.id, title: b.title, timestamp_seconds: b.timestamp_seconds })) };
      } catch (err) { return { ok: false, error: err.message }; }
    }
    case 'open_bookmark': {
      const id = String(args.bookmark_id || '');
      try {
        const res = await fetch(`/api/lectures/${currentVideoId}/bookmarks`);
        const data = await res.json();
        const b = (data.bookmarks || []).find((x) => x.id === id);
        if (!b) return { ok: false, error: 'No saved bookmark with that id.' };
        seekPlayer(b.timestamp_seconds);
        return { ok: true, opened: id, title: b.title, position: Number((els.video.currentTime||0).toFixed(2)) };
      } catch (err) { return { ok: false, error: err.message }; }
    }
    case 'update_bookmark': {
      if (!currentVideoId) return { ok: false, error: 'No lecture loaded.' };
      const id = String(args.bookmark_id || '');
      if (!id) return { ok: false, error: 'bookmark_id is required.' };
      const patch = {};
      if (typeof args.title === 'string' && args.title.trim()) patch.title = args.title.trim();
      if (typeof args.note === 'string') patch.note = args.note;
      if (!('title' in patch) && !('note' in patch))
        return { ok: false, error: 'Provide a new title and/or note to update.' };
      try {
        const res = await fetch(`/api/lectures/${currentVideoId}/bookmarks/${id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        const data = await res.json();
        if (!res.ok) return { ok: false, error: data?.error?.message || `${res.status}` };
        loadBookmarks();   // refresh UI only AFTER the backend confirms
        return { ok: true, updated: true, id: data.id, title: data.title,
                 note: data.note, timestamp_seconds: data.timestamp_seconds };
      } catch (err) { return { ok: false, error: err.message }; }
    }
    case 'delete_bookmark': {
      if (!currentVideoId) return { ok: false, error: 'No lecture loaded.' };
      const id = String(args.bookmark_id || '');
      if (!id) return { ok: false, error: 'bookmark_id is required.' };
      try {
        const res = await fetch(`/api/lectures/${currentVideoId}/bookmarks/${id}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) return { ok: false, error: data?.error?.message || `${res.status}` };
        loadBookmarks();   // refresh UI only AFTER the backend confirms the delete
        return { ok: true, deleted: true, id };
      } catch (err) { return { ok: false, error: err.message }; }
    }
    default:
      return { ok: false, error: `Unknown tool "${name}".` };
  }
}

async function persistBookmark(prop) {
  const res = await fetch(`/api/lectures/${prop.lectureId}/bookmarks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ timestamp_seconds: prop.timestamp, title: prop.title,
                           transcript_excerpt: prop.excerpt, note: prop.note }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `${res.status}`);
  return data;
}

// Phase 3A audio policy: before Looper speaks, ensure the lecture is paused and
// VERIFY it. Return false if we can't guarantee no overlap (session suppresses audio).
//
// G5.3-FIX: the lecture must become playable again after Looper speaks. We
// remember whether it was playing when Looper took the floor, pause it for the
// utterance (no overlap), then RESUME it when the utterance ends / the session
// ends. Without this, the video stays paused forever and looks "broken".
let resumeLectureOnSpeechEnd = false;     // should we auto-resume when the session ends?

// When the user has just asked to PLAY/RESUME the lecture, pausing it so Looper
// can say "Playing now!" would immediately undo the request — the video would
// stutter and stop again (the reported loop). For that one response we instead
// let the lecture keep playing and SUPPRESS Looper's spoken confirmation (the
// text still appears in the transcript). This flag is set by the play-type
// control_video actions and consumed by the next beforeAgentAudio.
let keepPlayingThroughNextSpeech = false;

// Call AT ACTIVATION (before the activation pause): if the lecture is currently
// playing, record that we should resume it when the Looper session ends. The
// user handed control to Looper while watching, so the lecture should pick back
// up afterward rather than being left stuck paused.
function captureResumeIntent() {
  resumeLectureOnSpeechEnd = player.canControl() && player.isPlaying();
  logEvent('audio_policy', { action: 'capture_resume_intent', will_resume: resumeLectureOnSpeechEnd });
}

function ensureLecturePausedForSpeech() {
  if (!player.canControl()) return true;      // nothing loaded → no overlap possible
  // The user just asked to keep watching (play/resume): don't pause to speak —
  // let the lecture run and suppress this response's audio so there's no loop.
  if (keepPlayingThroughNextSpeech) {
    keepPlayingThroughNextSpeech = false;
    logEvent('audio_policy', { action: 'keep_playing_suppress_speech' });
    return false;                             // false → session suppresses Looper audio
  }
  if (!player.isPlaying()) return true;       // already paused → fine
  // If the model started playback mid-session (control_video play), remember to
  // restore it on session end too.
  resumeLectureOnSpeechEnd = true;
  player.pause();
  const paused = !player.isPlaying();         // verify against the real element
  logEvent('audio_policy', { action: 'pause_for_speech', verified_paused: paused });
  return paused;                              // false → session will suppress Looper audio
}

// Resume the lecture when the Looper session ends, but only if it was playing
// when Looper interrupted it. Keeps the no-overlap guarantee intact (the video
// stays paused for the whole conversation) while making it playable again
// afterward — so the lecture is never left stuck paused.
function resumeLectureAfterSpeech(reason) {
  if (!resumeLectureOnSpeechEnd) return;
  resumeLectureOnSpeechEnd = false;
  if (!player.canControl() || player.isPlaying()) return;
  player.play();
  logEvent('audio_policy', { action: 'resume_after_speech', reason, playing: player.isPlaying() });
}

const looper = createLooperSession({
  silenceCallbacks: 6,        // ~1.0s end-of-turn (was 12≈2.0s) — issue 3 latency
  // Latency instrumentation: each pipeline mark is timestamped in the chat log
  // so before/after latency is measurable from the exported JSON. Also drives
  // the voice activity cue transitions (real events only).
  onMark: (name, extra) => {
    // Diagnostics (toggle with window.__LL_VOICE_DIAG = false). Logs VAD/turn/
    // cancellation events + whether the lecture was paused at capture time. No
    // raw audio is ever recorded; transcript text is not added here.
    const diag = (window.__LL_VOICE_DIAG !== false);
    if (diag) {
      const playerPaused = player.canControl() ? !player.isPlaying() : null;
      logEvent('latency_mark', { mark: name, player_paused: playerPaused, ...extra });
    } else {
      logEvent('latency_mark', { mark: name, ...extra });
    }
    if (name === 'turn_commit') {
      // User turn ended; retrieval is about to run (cue set in fetchContext).
      hideCue('listening');
    } else if (name === 'response_created') {
      // Generating, but nothing streamed yet → "preparing" (C).
      showCue('preparing');
    } else if (name === 'first_text' || name === 'first_audio') {
      // Answer is now streaming/audible → drop the preparing cue (C removal).
      hideCue('preparing');
    } else if (name === 'barge_in') {
      // Interrupt: playback has been stopped in bargeInCancel() before this mark,
      // so it's truthful to show we're ready to listen. Show listening + "Ready".
      showCue('listening', { label: 'Listening to you', sub: 'Response interrupted', iconSvg: SVG.interrupt });
      if (cue.badge) { cue.badge.textContent = 'Ready'; cue.badge.classList.remove('hidden'); }
    }
  },
  beforeAgentAudio: ensureLecturePausedForSpeech,
  onAgentAudioStart: () => { logEvent('agent_audio_start'); setSpeakingIndicator(true); hideCue('preparing'); showCue('speaking'); },   // E
  // Do NOT resume between utterances: the user is still in a conversation and
  // may ask follow-ups. The lecture resumes when the whole session ends (below).
  onAgentAudioEnd: () => { logEvent('agent_audio_end'); setSpeakingIndicator(false); hideCue('speaking'); },
  onToolCall: async (call) => {
    let args = {};
    try { args = JSON.parse(call.arguments || '{}'); } catch {}
    logEvent('tool_call', { name: call.name, args });
    showActionCueStart(call.name, args);              // D — in-progress label
    const result = await executeTool(call.name, args);
    logEvent('tool_result', { name: call.name, ok: result.ok, result });
    showActionCueResult(call.name, args, result);     // D — confirmed outcome / error
    looper.returnToolResult(call.call_id, result);   // confirmed result back to model
  },
  onReady: () => { turnSeq.setLecture(currentVideoId); logEvent('session_ready', { lecture_id: currentVideoId }); injectInitialContext(); },
  onState: (s, detail) => {
    ww.rtState.dataset.s = s;
    ww.rtState.textContent = RT_LABEL[s] || s;
    if (detail) ww.rtState.title = detail;
    logEvent('state', { state: s, detail: detail || '' });
    // Discreet "thinking" indicator: the model is preparing a response but no
    // audio is playing yet (state 'speaking' before onAgentAudioStart, or the
    // "Thinking…" detail after the user's turn commits). Cleared once audio
    // starts (speaking dot takes over) or the turn ends.
    const thinking = (s === 'speaking') || (/thinking/i.test(detail || ''));
    setThinkingIndicator(thinking && s !== 'closed' && s !== 'error');
    if (s === 'closed' || s === 'error') {
      rtActive = false;
      setSpeakingIndicator(false);
      setThinkingIndicator(false);
      hideCue();   // clear any active voice cue when the session ends
      // A response still mid-stream when the session ended is interrupted, not
      // completed — mark it honestly and keep the partial text.
      if (assistantBubble) { assistantBubble.classList.remove('streaming'); assistantBubble.classList.add('interrupted'); assistantBubble = null; }
      // A provisional user bubble that never got a final transcript: drop the
      // "listening…" placeholder so we don't leave fabricated text behind.
      if (userBubble) { userBubble.remove(); userBubble = null; }
      if (s === 'error') addConvo('system', detail || 'error');
      // Resume the lecture if it was playing when Looper took over, so the video
      // is never left stuck paused after a conversation (the reported bug).
      resumeLectureAfterSpeech(s);
      // Return to passive wake-word listening after a conversation ends — UNLESS
      // the user explicitly stopped (Stop button or "stop listening"). Explicit
      // stop must stay stopped until the user deliberately re-activates.
      const explicitStop = userStoppedExplicitly;
      userStoppedExplicitly = false;
      setTimeout(() => {
        ww.convo.classList.add('hidden');
        if (wwDesired && !explicitStop) wakeword.enable();   // resume passive listening only if not an explicit stop
      }, 1500);
    }
  },
  // User finished/started speaking but the final STT transcript hasn't arrived.
  // Show ONE provisional bubble (distinct styling, no fabricated text) and keep
  // reusing it — never append a duplicate per event.
  onUserPending: () => {
    if (!userBubble) {
      userBubble = addConvo('you', 'listening…');
      userBubble.classList.add('provisional');
    }
    assistantBubble = null;   // a new user turn ends the previous assistant bubble
    showCue('listening');     // A — mic active + voice activity
    refreshContextProactively('turn_start');   // grounding present before server auto-responds
  },
  onUserText: (t) => {
    // Finalize the user turn: replace the provisional bubble's text in place
    // (no duplicate), or create a finalized bubble if none existed.
    if (userBubble) {
      userBubble.classList.remove('provisional');
      setConvoText(userBubble, t);
      maybeAutoScroll();
    } else {
      addConvo('you', t);
    }
    userBubble = null;
    assistantBubble = null;
    logEvent('user_transcript', { text: t, position_s: Number((els.video.currentTime || 0).toFixed(2)) });
    // CONTROL PHRASE: "stop listening" (and similar) ends the conversation
    // instead of being sent to Jarvis as a question. The user explicitly asked
    // to stop, so we release the mic and do NOT auto-restart wake-word listening.
    if (isStopListeningCommand(t)) {
      logEvent('stop_listening_command', { text: t });
      addConvo('system', 'Stopped listening.');
      userStoppedExplicitly = true;
      looper.stop();
      return;   // do not forward to the model
    }
    // Under server VAD the server auto-responds; we do NOT drive the response.
    // Grounding is kept current by proactive context injection (activation +
    // seek + turn start). We still fetch question-scoped context here as a
    // best-effort top-up so the freshest, most relevant passage is present —
    // requestResponse() is a no-op under server VAD, so this cannot double-respond.
    turnSeq.setLecture(currentVideoId);
    turnSeq.handleUserTurn(t, { lectureId: currentVideoId, position: els.video.currentTime || 0 });
  },
  // Server VAD ended the turn (a response will auto-follow). Nothing to drive;
  // context was injected proactively. Hook kept for future use/diagnostics.
  onTurnEnd: () => { logEvent('server_turn_end', { position_s: Number((els.video.currentTime || 0).toFixed(2)) }); },
  // A new response is starting: remember its id so deltas associate with THIS
  // message and late deltas from a superseded response are rejected. The bubble
  // is created LAZILY on the first text delta, so a tool-only response (no
  // spoken text) never leaves an empty bubble.
  onResponseStart: (responseId) => {
    activeResponseId = responseId || activeResponseId;
    assistantBubble = null;   // next delta for this id creates+keys the bubble
  },
  // Looper's response was interrupted (barge-in). Keep whatever text we received
  // and mark it clearly as interrupted rather than silently finalizing.
  onAssistantInterrupted: (responseId) => {
    const b = bubbleForResponse(responseId);
    if (b) {
      b.classList.remove('streaming');
      b.classList.add('interrupted');
      logEvent('assistant_interrupted', { text: b._raw || '' });
    }
    assistantBubble = null;
    setSpeakingIndicator(false);
    hideCue('speaking');          // E → will transition to listening via barge_in mark
  },
  onAssistantText: (delta, done, responseId, finalText) => {
    // Reject text events belonging to a superseded response (pure guard).
    const bubbleId = assistantBubble?.dataset.responseId;
    if (!shouldApplyResponseEvent(responseId, activeResponseId, bubbleId)) {
      logEvent('assistant_text_stale_ignored', { responseId, activeResponseId });
      return;
    }
    let b = bubbleForResponse(responseId) || assistantBubble;
    if (done) {
      if (b) {
        // Reconcile authoritative final text without double-appending.
        const reconciled = reconcileFinalText(b._raw, finalText);
        if (reconciled != null) { setConvoText(b, reconciled); maybeAutoScroll(); }
        b.classList.remove('streaming');
        logEvent('assistant_transcript', { text: b._raw || '' });
      }
      assistantBubble = null;
      setSpeakingIndicator(false);
      return;
    }
    // Delta. If no bubble exists yet (deltas can precede response.created in odd
    // orderings), create one and key it to the response id.
    if (!b) {
      b = addConvo('looper', '');
      b.dataset.responseId = responseId || activeResponseId || '';
      b.classList.add('streaming');
      assistantBubble = b;
    }
    appendConvoDelta(b, delta);
  },
});

// Find the assistant bubble that belongs to a given response id (falls back to
// the active streaming bubble when ids are unavailable from the provider).
function bubbleForResponse(responseId) {
  if (responseId) {
    const found = ww.rtLog.querySelector('.convo-row.looper[data-response-id="' + CSS.escape(responseId) + '"]');
    if (found) return found;
  }
  return assistantBubble;
}

// Subtle, non-animated "Looper is speaking" indicator on the conversation head.
function setSpeakingIndicator(on) {
  const head = document.querySelector('#looperConvo .convo-head');
  if (head) {
    head.dataset.speaking = on ? '1' : '0';
    if (on) head.dataset.thinking = '0';   // speaking supersedes thinking
  }
}
// Discreet "thinking" dots while Looper prepares a response (no audio yet).
function setThinkingIndicator(on) {
  const head = document.querySelector('#looperConvo .convo-head');
  if (head && head.dataset.speaking !== '1') head.dataset.thinking = on ? '1' : '0';
}

// ---------------------------------------------------------------------------
// Voice activity cue strip (Conversational Voice Activity Cues). One compact
// cue at a time INSIDE the chat panel — never a chat bubble, so status changes
// can't duplicate messages. Each cue is driven by a REAL event (see wiring
// below); nothing is shown speculatively.
// ---------------------------------------------------------------------------
const cue = {
  strip: $('#cueStrip'), icon: $('#cueIcon'), label: $('#cueLabel'),
  wave: $('#cueWave'), dots: $('#cueDots'), spin: $('#cueSpin'),
  badge: $('#cueBadge'), sub: $('#cueSub'), extra: $('#cueExtra'),
};
// Lightweight inline SVG line icons (consistent 20px box, 1.8 stroke).
const SVG = {
  mic: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  book: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6.5C10.5 5 8 4.5 4 4.8V18c4-.3 6.5.2 8 1.7 1.5-1.5 4-2 8-1.7V4.8c-4-.3-6.5.2-8 1.7zM12 6.5V19.7"/></svg>',
  sparkle: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6zM18 14l.8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8z"/></svg>',
  action: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l7 6-7 6zM13 6l7 6-7 6z"/></svg>',
  speaking: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2"/></svg>',
  interrupt: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3H5v4M15 21h4v-4M20 9a8 8 0 0 0-14-3L3 8M4 15a8 8 0 0 0 14 3l3-2"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg>',
  warn: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l9 16H3zM12 10v4M12 17v.5"/></svg>',
  play: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
};
// kind → { svg, label, wave?, dots? }. Accent via data-kind on the card.
const CUE_DEFS = {
  listening:  { svg: SVG.mic,      label: "I'm listening…",                wave: true },
  retrieving: { svg: SVG.book,     label: 'Looking back at your lecture…', dots: true },
  preparing:  { svg: SVG.sparkle,  label: 'Let me put that together…',     dots: true },
  speaking:   { svg: SVG.speaking, label: 'Jarvis is explaining…',         wave: true },
  action:     { svg: SVG.action,   label: 'Working…',                      spin: true },
};
let cueKind = null;
function showCue(kind, { label, extraHtml, sub, iconSvg } = {}) {
  const def = CUE_DEFS[kind]; if (!def || !cue.strip) return;
  cueKind = kind;
  cue.strip.dataset.kind = kind;
  cue.icon.innerHTML = iconSvg || def.svg;
  cue.sub.textContent = sub || '';
  cue.badge.classList.add('hidden');
  cue.spin.classList.toggle('on', !!def.spin);
  cue.label.textContent = label || def.label;
  cue.wave.classList.toggle('on', !!def.wave);
  cue.dots.classList.toggle('on', !!def.dots);
  cue.extra.innerHTML = extraHtml || '';
  cue.strip.classList.remove('hidden');
}
function hideCue(onlyIf) {
  if (onlyIf && cueKind !== onlyIf) return;   // don't clear a cue that already advanced
  cueKind = null;
  if (cue.strip) { cue.strip.classList.add('hidden'); cue.extra.innerHTML = ''; }
}
// A transient, self-clearing confirmation/error line in the cue strip (e.g.
// "Moved to 12:34"). Does NOT persist in chat. ms=0 keeps it until replaced.
let cueClearTimer = null;
// Transient confirmation/error. `tone`: 'ok' (green check) | 'err' (warn). Keeps
// the action accent; swaps the disc icon to a check/warn and shows a sub line.
function flashCue(kind, label, { sub, tone = 'ok', ms = 2800 } = {}) {
  showCue(kind, { label, sub, iconSvg: tone === 'err' ? SVG.warn : SVG.check });
  cue.wave.classList.remove('on'); cue.dots.classList.remove('on'); cue.spin.classList.remove('on');
  cue.strip.dataset.tone = tone;
  if (cueClearTimer) clearTimeout(cueClearTimer);
  if (ms > 0) cueClearTimer = setTimeout(() => { cue.strip.removeAttribute('data-tone'); hideCue(kind); }, ms);
}

// D — "Taking an action": in-progress label + green spinner per tool.
function showActionCueStart(name, args) {
  const t = Number(args?.timestamp_seconds);
  let label = 'Working…';
  if (name === 'seek_video' && Number.isFinite(t)) label = 'Jumping to ' + formatTime(t) + '…';
  else if (name === 'control_video') label = 'Adjusting playback…';
  else if (name === 'open_bookmark') label = 'Opening bookmark…';
  else if (name === 'prepare_bookmark') label = 'Preparing a bookmark…';
  else if (name === 'save_bookmark') label = 'Saving bookmark…';
  else if (name === 'update_bookmark') label = 'Updating bookmark…';
  else if (name === 'delete_bookmark') label = 'Deleting bookmark…';
  else if (name === 'list_bookmarks') label = 'Looking up your bookmarks…';
  else if (name === 'get_player_state') return;   // silent read, no cue
  cue.strip.removeAttribute('data-tone');
  showCue('action', { label });   // CUE_DEFS.action.spin → green spinner on
}
// D — confirmed outcome: green check on success (ONLY from real result.ok), or
// an honest warn on failure. Shows a contextual sub line.
function showActionCueResult(name, args, result) {
  if (name === 'get_player_state') return;
  if (!result || result.ok === false) {
    flashCue('action', 'That action could not be completed', { sub: result?.error || '', tone: 'err', ms: 4500 });
    return;
  }
  let label = 'Done', sub = '';
  if (name === 'seek_video' || name === 'open_bookmark') {
    const pos = Number(result.position);
    const at = formatTime(Number.isFinite(pos) ? pos : (args?.timestamp_seconds || 0));
    label = 'Moved to ' + at;
    sub = name === 'open_bookmark' ? 'Opened the saved bookmark' : 'Opened the relevant lecture moment';
  } else if (name === 'control_video') {
    label = 'Playback updated'; sub = result.action || '';
  } else if (name === 'prepare_bookmark') {
    label = 'Ready to save this moment'; sub = 'Use Save in the bookmarks panel';
  } else if (name === 'save_bookmark') {
    label = 'Bookmark saved'; sub = result.title ? ('Saved · ' + result.title) : '';   // result.ok = DB confirmed
  } else if (name === 'update_bookmark') { label = 'Bookmark updated';
  } else if (name === 'delete_bookmark') { label = 'Bookmark deleted';
  } else if (name === 'list_bookmarks') { label = (result.count || 0) + ' bookmark(s)'; }
  flashCue('action', label, { sub, tone: 'ok' });
}

// ---- Chat auto-scroll (bottom-sentinel based) ---------------------------------
// The scroll container is .convo-scroll (holds the log + a bottom sentinel +
// the floating "Jump to latest" button). An IntersectionObserver on the
// sentinel tells us whether the user is "following" the bottom. We only
// auto-scroll while following; if the user scrolls up, we stop and reveal the
// Jump-to-latest button. This replaces unconditional scrollIntoView() and
// stays entirely within the chat panel (never the page).
const convoScroll = document.querySelector('#looperConvo .convo-scroll');
const jumpLatestBtn = $('#rtJumpLatest');
let followingBottom = true;     // is the user pinned to the latest message?

function convoNearBottom() {
  const n = convoScroll;
  if (!n) return true;
  return (n.scrollHeight - n.scrollTop - n.clientHeight) < 48;
}
function convoScrollToBottom() {
  if (!convoScroll) return;
  convoScroll.scrollTop = convoScroll.scrollHeight;
  followingBottom = true;
  jumpLatestBtn?.classList.add('hidden');
}

// Observe the sentinel: visible ⇒ user is at the bottom (following).
if (convoScroll && jumpLatestBtn) {
  const sentinel = $('#rtSentinel');
  if (sentinel && 'IntersectionObserver' in window) {
    new IntersectionObserver((entries) => {
      followingBottom = entries[0].isIntersecting;
      if (followingBottom) jumpLatestBtn.classList.add('hidden');
    }, { root: convoScroll, threshold: 0.1 }).observe(sentinel);
  }
  // Manual scroll up ⇒ stop following (observer also updates this).
  convoScroll.addEventListener('scroll', () => {
    if (!convoNearBottom()) followingBottom = false;
  }, { passive: true });
  jumpLatestBtn.addEventListener('click', () => convoScrollToBottom());
}

// Reveal the jump button when new content arrives while the user is reading up.
// We follow if the user is pinned at the bottom (followingBottom) OR the content
// isn't overflowing yet (convoNearBottom true). The IntersectionObserver can lag
// on short/empty logs, so the synchronous near-bottom check is the safety net.
function maybeAutoScroll() {
  const follow = followingBottom || convoNearBottom();
  const d = autoScrollDecision(follow);
  if (d.scroll) convoScrollToBottom();
  if (d.showJump) jumpLatestBtn?.classList.remove('hidden');
}

// Build a chat bubble with a role label + a dedicated content node. The content
// node is updated in place during streaming (no full-row rebuild). `_raw` holds
// the accumulated text so deltas append cleanly and whitespace is preserved
// (CSS white-space: pre-wrap renders punctuation/line breaks faithfully).
const WHO_LABEL = { you: 'You', looper: 'Jarvis', system: '' };
function addConvo(role, text) {
  const row = el('div', { className: 'convo-row ' + role });
  const label = WHO_LABEL[role];
  if (label) row.append(el('span', { className: 'who', textContent: label + ': ' }));
  const content = el('span', { className: 'content', textContent: text || '' });
  row.append(content);
  row._content = content;
  row._raw = text || '';
  ww.rtLog.append(row);
  maybeAutoScroll();   // follow bottom if the user is there; else reveal Jump-to-latest
  return row;
}

// Set/append bubble text via the content node only (incremental, no rebuild).
function setConvoText(row, fullText) {
  if (!row) return;
  row._raw = fullText;
  row._content.textContent = fullText;   // plain text (finalized / reconciled)
}
// Append a streamed delta and highlight the LEADING EDGE (newest text) as it
// arrives. This is NOT word-to-audio alignment (the provider gives no
// timestamps) — it is a reading aid that tracks the transcript's arrival, which
// roughly follows speech. Settled text renders plain; the newest chunk is
// wrapped in .live-token until the next delta settles it.
function appendConvoDelta(row, delta) {
  if (!row || !delta) return;
  const settled = (row._raw || '');
  row._raw = settled + delta;
  // Rebuild content as: settled text node + highlighted trailing token.
  row._content.textContent = settled;
  const tok = row._liveTok || (row._liveTok = document.createElement('span'));
  tok.className = 'live-token';
  tok.textContent = delta;
  row._content.appendChild(tok);
  // Settle the previous token shortly after (fades to normal via CSS class swap).
  if (row._settleTimer) clearTimeout(row._settleTimer);
  row._settleTimer = setTimeout(() => {
    if (row._content) { row._content.textContent = row._raw; row._liveTok = null; }
  }, 260);
  maybeAutoScroll();   // keep the streaming message visible if following the bottom
}

function startConversation() {
  if (rtActive) return;              // ignore duplicate activations
  rtActive = true;
  ww.rtLog.innerHTML = '';
  assistantBubble = null;
  userBubble = null;
  activeResponseId = null;
  followingBottom = true;            // start pinned to the latest
  jumpLatestBtn?.classList.add('hidden');
  hideCue();
  setSpeakingIndicator(false);
  resetConvoLog();                   // begin a fresh timestamped debug timeline
  ww.convo.classList.remove('hidden');
  looper.start();
}

ww.rtStop.addEventListener('click', () => { logEvent('user_stop'); userStoppedExplicitly = true; looper.stop(); rtActive = false; });
ww.rtExport.addEventListener('click', exportConvoLog);
const WW_LABEL = {
  off: 'Wake word off', starting: 'Starting…',
  listening: 'Listening locally', activated: 'Activated!', error: 'Error',
};
let wwOn = false;

const wakeword = createWakeWordListener({
  onState: (s, detail) => {
    ww.state.dataset.s = s;
    ww.state.textContent = WW_LABEL[s] || s;
    if (detail) ww.hint.textContent = detail;
    ww.toggle.textContent = (s === 'off' || s === 'error') ? 'Wake word' : 'Wake word: on';
    wwOn = !(s === 'off' || s === 'error');
    if (s !== 'activated') ww.activated?.classList.add('hidden');   // banner removed in the rail layout → null-safe
  },
  onLevel: (rms) => { ww.meter.style.width = Math.min(100, Math.round(rms * 400)) + '%'; },
  onScore: (s) => {
    // Live wake-word model score (0..1). Lets you see sensitivity without DevTools.
    ww.score.textContent = 'score ' + s.toFixed(2);
    ww.meter.style.width = Math.min(100, Math.round(s * 100)) + '%';
    ww.meter.style.background = s > 0.3 ? '#7ee0a2' : '#6ea8fe';
  },
  onDetect: () => {
    // G3.2: on activation, pause the lecture, release the wake-word mic, and
    // hand the single microphone to a Higgs Realtime conversation.
    ww.activated?.classList.remove('hidden');   // null-safe: banner removed in rail layout
    captureResumeIntent();   // remember to resume the lecture when the session ends
    player.pause();   // explicit, idempotent — pauses the real video before the conversation
    // Release the detector's mic BEFORE opening the Realtime mic (one capture at a time).
    wakeword.disable().finally(() => {
      ww.activated?.classList.add('hidden');
      startConversation();
    });
  },
});

let wwDesired = false;   // user's intent to have wake word on (survives activation handoff)
ww.toggle.addEventListener('click', () => {
  if (wwOn) { wwDesired = false; wakeword.disable(); }
  else { wwDesired = true; wakeword.enable(); }
});
// Manual activation — guaranteed demo path, independent of the wake-word model.
// Works whether or not wake-word listening is enabled.
ww.manual.addEventListener('click', () => {
  if (rtActive) return;
  captureResumeIntent();   // remember to resume the lecture when the session ends
  player.pause();   // pause the lecture before the conversation starts
  wakeword.disable().finally(startConversation);
});
// Ensure the mic is released if the user closes the lecture or leaves the page.
els.closeBtn.addEventListener('click', () => { try { wakeword.disable(); } catch {} });
window.addEventListener('beforeunload', () => { try { wakeword.disable(); } catch {} });

// ---------------------------------------------------------------------------
// Bookmarks (G5 "Remember"): save current moment + reopen to seek. Persisted
// server-side, associated with the current lecture; survives refresh/reattach.
// ---------------------------------------------------------------------------
const bm = {
  title: $('#bmTitle'), save: $('#bmSave'), msg: $('#bmMsg'), list: $('#bmList'),
};

function nearestExcerpt(t) {
  // Reuse already-loaded transcript segments to attach a readable excerpt.
  let best = null;
  for (const s of allSegments) {
    if (t >= s.start && t < s.end) { best = s; break; }
    if (!best || Math.abs(s.start - t) < Math.abs((best.start ?? 1e9) - t)) best = s;
  }
  return best ? best.text : null;
}

async function saveBookmark() {
  if (!currentVideoId) { bm.msg.textContent = 'Load a lecture first.'; bm.msg.className = 'bm-msg err'; return; }
  const t = els.video.currentTime || 0;
  const title = (bm.title.value || '').trim() || `Moment at ${formatTime(t)}`;
  bm.save.disabled = true; bm.msg.textContent = 'Saving…'; bm.msg.className = 'bm-msg';
  try {
    const res = await fetch(`/api/lectures/${currentVideoId}/bookmarks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timestamp_seconds: t, title, transcript_excerpt: nearestExcerpt(t) }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || `${res.status}`);
    bm.title.value = '';
    bm.msg.textContent = `Saved "${data.title}" at ${formatTime(data.timestamp_seconds)}.`;
    bm.msg.className = 'bm-msg ok';           // success only AFTER the DB confirms
    justSavedBookmarkId = data.id;            // flag for the confirmation flash on render
    loadBookmarks();
  } catch (err) {
    bm.msg.textContent = 'Save failed: ' + err.message; bm.msg.className = 'bm-msg err';
  } finally { bm.save.disabled = false; }
}

// Id of a bookmark saved in the last confirmed write → gets a one-time, brief
// confirmation flash when the list re-renders. Confirmation is NEVER shown
// before the backend 2xx (the flag is only set after a successful response).
let justSavedBookmarkId = null;

async function loadBookmarks() {
  bm.list.innerHTML = '';
  if (!currentVideoId) return;
  try {
    const res = await fetch(`/api/lectures/${currentVideoId}/bookmarks`);
    const data = await res.json();
    if (!res.ok) return;
    if (!data.count) { bm.list.append(el('div', { className: 'muted', textContent: 'No saved concepts yet.' })); return; }
    for (const b of data.bookmarks) {
      const row = el('div', { className: 'bm-item', id: 'bm-' + b.id });
      if (b.id === justSavedBookmarkId) { row.classList.add('just-saved'); justSavedBookmarkId = null; }
      const open = el('button', { className: 'bm-open', type: 'button',
        title: 'Reopen at ' + formatTime(b.timestamp_seconds) });
      open.append(el('span', { className: 'bm-time', textContent: formatTime(b.timestamp_seconds) }));
      const txt = el('span', { className: 'bm-text' });
      txt.append(el('strong', { className: 'bm-title', textContent: b.title }));
      if (b.transcript_excerpt) txt.append(el('span', { className: 'bm-ex', textContent: ' — ' + b.transcript_excerpt }));
      open.append(txt);
      open.addEventListener('click', () => seekPlayer(b.timestamp_seconds));   // reopen → seek

      const actions = el('span', { className: 'bm-actions' });
      const renameBtn = el('button', { className: 'ctl small', type: 'button',
        textContent: 'Rename', title: 'Rename this bookmark' });
      renameBtn.addEventListener('click', () => renameBookmark(b));
      const delBtn = el('button', { className: 'ctl small danger', type: 'button',
        textContent: 'Delete', title: 'Delete this bookmark' });
      delBtn.addEventListener('click', () => deleteBookmark(b));
      actions.append(renameBtn, delBtn);

      row.append(open, actions);
      bm.list.append(row);
    }
  } catch { /* non-critical */ }
}

bm.save.addEventListener('click', saveBookmark);

// --- Bookmark rename / delete (G5.3 CRUD): UI refreshes only AFTER the backend
// confirms. Never claim success optimistically. ---
async function renameBookmark(b) {
  const next = window.prompt('Rename bookmark', b.title);
  if (next == null) return;                 // cancelled
  const title = next.trim();
  if (!title) { bm.msg.textContent = 'Title cannot be empty.'; bm.msg.className = 'bm-msg err'; return; }
  if (title === b.title) return;            // no change
  try {
    const res = await fetch(`/api/lectures/${currentVideoId}/bookmarks/${b.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || `${res.status}`);
    bm.msg.textContent = `Renamed to "${data.title}".`; bm.msg.className = 'bm-msg ok';
    loadBookmarks();                        // reflect the confirmed change
  } catch (err) {
    bm.msg.textContent = 'Rename failed: ' + err.message; bm.msg.className = 'bm-msg err';
  }
}

async function deleteBookmark(b) {
  if (!window.confirm(`Delete bookmark "${b.title}"? This cannot be undone.`)) return;
  try {
    const res = await fetch(`/api/lectures/${currentVideoId}/bookmarks/${b.id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || `${res.status}`);
    bm.msg.textContent = `Deleted "${b.title}".`; bm.msg.className = 'bm-msg ok';
    loadBookmarks();                        // reflect the confirmed delete
  } catch (err) {
    bm.msg.textContent = 'Delete failed: ' + err.message; bm.msg.className = 'bm-msg err';
  }
}

// --- Pending (voice-proposed) bookmarks: shown distinctly; require explicit Save ---
function renderPendingBookmark(pid) {
  const prop = pendingBookmarks.get(pid);
  if (!prop) return;
  let host = document.querySelector('#bmPending');
  if (!host) { host = el('div', { id: 'bmPending', className: 'bm-pending' }); bm.list.before(host); }
  const row = el('div', { className: 'bm-prop', id: 'prop-' + pid });
  const info = el('span', {});
  info.append(el('strong', { textContent: `Proposed: ${prop.title}` }));
  info.append(el('span', { className: 'bm-time', textContent: ' @ ' + formatTime(prop.timestamp) }));
  if (prop.note) info.append(el('span', { className: 'bm-ex', textContent: ' — ' + prop.note }));
  const approve = el('button', { className: 'ctl small', type: 'button', textContent: 'Save bookmark' });
  approve.addEventListener('click', async () => {
    const p = pendingBookmarks.get(pid);
    if (!p) return;
    try {
      const saved = await persistBookmark(p);
      pendingBookmarks.delete(pid); clearPendingBookmark(pid);
      justSavedBookmarkId = saved.id;      // confirmation flash after DB confirms
      loadBookmarks();
      logEvent('bookmark_saved_manual', { id: saved.id, title: saved.title });
    } catch (err) { bm.msg.textContent = 'Save failed: ' + err.message; bm.msg.className = 'bm-msg err'; }
  });
  const dismiss = el('button', { className: 'ctl small', type: 'button', textContent: 'Dismiss' });
  dismiss.addEventListener('click', () => { pendingBookmarks.delete(pid); clearPendingBookmark(pid); });
  row.append(info, approve, dismiss);
  host.append(row);
}
function clearPendingBookmark(pid) {
  const row = document.querySelector('#prop-' + pid);
  if (row) row.remove();
}

// ---------------------------------------------------------------------------
// Workspace layout controls (Phase 2): collapsible left/right rails + a button
// to return to the picker. Pure UI state via data-attributes on #playerWrap;
// no effect on playback, transcript, Looper, or bookmark logic.
// ---------------------------------------------------------------------------
const workspace = $('#playerWrap');
function toggleRail(side) {
  const attr = side === 'left' ? 'data-left' : 'data-right';
  const open = workspace.getAttribute(attr) !== 'closed';
  workspace.setAttribute(attr, open ? 'closed' : 'open');
}
$('#leftRailToggle')?.addEventListener('click', () => toggleRail('left'));
$('#rightRailToggle')?.addEventListener('click', () => toggleRail('right'));
// "Open another lecture" → reveal the picker again without closing the current
// lecture's media (closeLecture fully tears down; this is a lighter path).
$('#newLectureBtn')?.addEventListener('click', () => {
  els.picker.classList.remove('hidden');
  els.picker.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// ---- Boot ----
checkHealth();
loadRecentLectures();
els.mediaState.dataset.state = STATE.IDLE;
els.mediaState.textContent = STATE_LABEL[STATE.IDLE];

// ---------------------------------------------------------------------------
// Transcript search panel (G2.3) — process a server-side lecture, then
// search persisted segments and seek the player to a result's timestamp.
// Uses the same tested player controller for seeking.
// ---------------------------------------------------------------------------
const tp = {
  status: $('#tpStatus'),
  bar: $('#tpBar'),
  barWrap: $('#tpBarWrap'),
  query: $('#tpQuery'),
  search: $('#tpSearch'),
  prev: $('#tpPrev'),
  next: $('#tpNext'),
  auto: $('#tpAuto'),
  counter: $('#tpCounter'),
  results: $('#tpResults'),
  list: $('#tpList'),
};

const searchNav = createSearchNav();
let resultRows = [];          // rendered result buttons, index-aligned with matches
let lastSearchQuery = null;   // detect query changes to reset selection

// --- Auto-scan state (single timer, no overlap) ---
const AUTOSCAN_INTERVAL_MS = 3000;
let autoScanTimer = null;
function isScanning() { return autoScanTimer !== null; }
function stopAutoScan() {
  if (autoScanTimer !== null) { clearInterval(autoScanTimer); autoScanTimer = null; }
  if (tp.auto) { tp.auto.textContent = '▶ Auto-scan'; tp.auto.classList.remove('scanning'); }
}
function startAutoScan() {
  if (isScanning()) return;              // guard against overlapping timers
  if (!searchNav.canNavigate()) return;
  tp.auto.textContent = '⏸ Stop';
  tp.auto.classList.add('scanning');
  autoScanTimer = setInterval(() => {
    if (!searchNav.canNavigate()) { stopAutoScan(); return; }
    searchNav.next();
    selectOccurrence(searchNav.index);
  }, AUTOSCAN_INTERVAL_MS);
}
function toggleAutoScan() { if (isScanning()) stopAutoScan(); else startAutoScan(); }
let currentVideoId = null;
let pollTimer = null;
let allSegments = [];        // progressively accumulated, ordered by seq
let lastSegmentCount = 0;
const seenKeys = new Map();  // client-side dedup: fileKey -> video_id (session)

function tpSetStatus(msg, isErr = false) {
  tp.status.textContent = msg;
  tp.status.className = isErr ? 'err' : 'muted';
}

const STAGE_LABEL = {
  queued: 'Queued', uploading: 'Uploading', extracting: 'Extracting audio…',
  transcribing: 'Transcribing', ready: 'Ready', failed: 'Failed', processing: 'Processing',
};

function fileKey(file) {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

async function autoProcess(file) {
  // Client-side dedup (optimization only): same name+size+mtime this session.
  const key = fileKey(file);
  resetTranscriptUI();
  if (seenKeys.has(key)) {
    currentVideoId = seenKeys.get(key);
    tpSetStatus('Reusing previous transcription for this file.');
    startPolling();
    return;
  }

  tp.barWrap.classList.remove('hidden');
  setBar('uploading', 0);
  tpSetStatus('Uploading…');

  try {
    const fd = new FormData();
    fd.append('file', file, file.name);
    fd.append('client_key', key);

    const id = await uploadWithProgress('/api/lectures', fd, (pct) => setBar('uploading', pct));
    currentVideoId = id;
    seenKeys.set(key, id);
    tpSetStatus('Processing…');
    startPolling();
    loadRecentLectures();  // reflect the new lecture in the recents list
  } catch (err) {
    tpSetStatus('Upload failed: ' + err.message, true);
  }
}

// XHR gives real upload-progress bytes; fetch does not.
function uploadWithProgress(url, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300 && data.id) resolve(data.id);
      else reject(new Error(data?.error?.message || `HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('network error'));
    xhr.send(formData);
  });
}

function setBar(stage, pct) {
  tp.bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  tp.bar.dataset.stage = stage;
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(pollStatus, 1200);
  pollStatus();
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function pollStatus() {
  if (!currentVideoId) return;
  try {
    const res = await fetch(`/api/lectures/${currentVideoId}/status`);
    const s = await res.json();
    if (!res.ok) throw new Error(s?.error?.message || `${res.status}`);

    const stageLabel = STAGE_LABEL[s.stage] || s.stage;
    if (s.stage === 'transcribing') {
      // Honest numeric %: processed-audio fraction. Also show chunk count.
      const pct = Math.round((s.progress || 0) * 100);
      setBar('transcribing', pct);
      tpSetStatus(`${stageLabel} — ${pct}% (${s.segment_count} segments so far)`);
    } else if (s.stage === 'extracting') {
      setBar('extracting', 100); // indeterminate: no honest %, show full-width pulse
      tpSetStatus(stageLabel);
    } else if (s.stage === 'ready') {
      setBar('ready', 100);
      tpSetStatus(`Ready — ${s.segment_count} segments. Search or click a line to jump.`);
      loadBookmarks();
    } else if (s.stage === 'failed') {
      setBar('failed', 100);
      tpSetStatus('Failed: ' + (s.error || 'unknown error'), true);
      stopPolling();
      return;
    } else {
      tpSetStatus(stageLabel);
    }

    // Fetch any newly available segments (progressive) once some exist.
    if (s.segment_count !== lastSegmentCount) {
      await refreshTranscript();
      lastSegmentCount = s.segment_count;
    }
    if (s.segment_count > 0) { tp.query.disabled = false; tp.search.disabled = false; }

    if (s.stage === 'ready') stopPolling();
  } catch (err) {
    tpSetStatus('Status error: ' + err.message, true);
    stopPolling();
  }
}

async function refreshTranscript() {
  const res = await fetch(`/api/lectures/${currentVideoId}/transcript`);
  const data = await res.json();
  if (!res.ok) return;
  allSegments = data.segments || [];
  renderTranscriptList();
}

function renderTranscriptList() {
  tp.list.innerHTML = '';
  for (const seg of allSegments) {
    const row = el('button', { className: 'tp-seg', type: 'button' });
    row.dataset.start = String(seg.start);
    row.dataset.end = String(seg.end);
    row.append(el('span', { className: 'tp-time', textContent: formatTime(seg.start) }));
    row.append(el('span', { className: 'tp-text', textContent: seg.text }));
    row.addEventListener('click', () => seekPlayer(seg.start));
    tp.list.append(row);
  }
}

// Highlight the segment matching current playback time (criterion 5).
// Robust seek: works even if the user clicks a transcript line before the
// reattached video has finished loading. If the player can't control yet,
// defer the seek until the <video> is ready.
let pendingSeek = null;
function seekPlayer(t) {
  if (player.canControl()) {
    player.seekTo(t);
    els.video.play().catch(() => {});  // play toward the moment (user gesture)
  } else {
    pendingSeek = t;
  }
  // If a voice session is active, keep grounding aligned with the new position.
  refreshContextProactively('seek');
}

// Seek and CONFIRM the player actually landed near the target. Resolves after
// the 'seeked' event (or a timeout) and reports the real position — so a
// tool-call can honestly say whether the middle-of-video seek succeeded instead
// of reading a stale currentTime immediately after requesting the seek.
function seekAndConfirm(t, tolerance = 1.5, timeoutMs = 4000) {
  return new Promise((resolve) => {
    if (!player.canControl()) { pendingSeek = t; return resolve({ ok: false, error: 'Player not ready.' }); }
    const v = els.video;
    let done = false;
    const cleanup = () => { v.removeEventListener('seeked', onSeeked); clearTimeout(timer); };
    const onSeeked = () => {
      if (done) return;
      const pos = v.currentTime || 0;
      if (Math.abs(pos - t) <= tolerance) { done = true; cleanup(); resolve({ ok: true, position: pos }); }
      // else: an intermediate seeked event; keep waiting for the real target.
    };
    const timer = setTimeout(() => {
      if (done) return; done = true; cleanup();
      const pos = v.currentTime || 0;
      // Honest result: did we get close even without a clean 'seeked'?
      if (Math.abs(pos - t) <= Math.max(tolerance, 3)) resolve({ ok: true, position: pos });
      else resolve({ ok: false, position: pos, error: `Seek did not reach ${formatTime(t)} (stopped at ${formatTime(pos)}).` });
    }, timeoutMs);
    v.addEventListener('seeked', onSeeked);
    player.seekTo(t);
    v.play().catch(() => {});
  });
}
els.video.addEventListener('canplay', () => {
  if (pendingSeek != null) {
    player.seekTo(pendingSeek);
    els.video.play().catch(() => {});
    pendingSeek = null;
  }
});

// Scroll ONLY within a scrollable container to reveal a child — never the page.
// This replaces element.scrollIntoView(), which climbs to the nearest scrollable
// ancestor (often the window) and was yanking the video out of view on every
// timeupdate. Honors reduced-motion.
function revealInContainer(container, child) {
  if (!container || !child) return;
  const cRect = container.getBoundingClientRect();
  const kRect = child.getBoundingClientRect();
  const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (kRect.top < cRect.top) {
    container.scrollBy({ top: kRect.top - cRect.top - 8, behavior: smooth ? 'smooth' : 'auto' });
  } else if (kRect.bottom > cRect.bottom) {
    container.scrollBy({ top: kRect.bottom - cRect.bottom + 8, behavior: smooth ? 'smooth' : 'auto' });
  }
}

// Transcript-follow mode: OFF by default (passive playback must NOT move the
// page or the transcript). When ON, only the transcript's own container scrolls
// to keep the active segment visible — never the page, never focus.
let followTranscript = false;

function highlightCurrent(time) {
  const rows = tp.list.children;
  let activeRow = null;
  for (const row of rows) {
    const start = Number(row.dataset.start), end = Number(row.dataset.end);
    const isActive = time >= start && time < end;
    row.classList.toggle('active', isActive);
    if (isActive) activeRow = row;
  }
  // Passive playback: highlight only. Scroll the transcript container ONLY when
  // the learner opted into follow mode — and only that container, not the page.
  if (activeRow && followTranscript) revealInContainer(tp.list, activeRow);
}

function resetTranscriptUI() {
  stopPolling();
  currentVideoId = null;
  allSegments = [];
  lastSegmentCount = 0;
  tp.list.innerHTML = '';
  stopAutoScan();                 // stop cycling on lecture change / reset
  tp.results.innerHTML = '';
  tp.query.value = '';
  tp.query.disabled = true;
  tp.search.disabled = true;
  tp.prev.disabled = true;
  tp.next.disabled = true;
  tp.auto.disabled = true;
  tp.counter.textContent = '';
  resultRows = [];
  lastSearchQuery = null;
  searchNav.clear();
  tp.bar.style.width = '0%';
}

function setNavButtons() {
  const can = searchNav.canNavigate();
  tp.prev.disabled = !can;
  tp.next.disabled = !can;
  tp.auto.disabled = !can;
}

function clearSearchResults() {
  stopAutoScan();
  tp.results.innerHTML = '';
  resultRows = [];
  searchNav.clear();
  tp.counter.textContent = '';
  setNavButtons();
}

function renderCounterAndHighlight() {
  tp.counter.textContent = searchNav.counterText();
  const active = searchNav.index;
  // Three visual states: plain row (.tp-hit), unselected match (always .tp-hit),
  // selected occurrence (.selected). Non-color cue: outline + marker via CSS.
  resultRows.forEach((row, i) => {
    row.classList.toggle('selected', i === active);
    if (i === active) row.setAttribute('aria-current', 'true');
    else row.removeAttribute('aria-current');
  });
  // Explicit navigation: reveal the selection inside the results container only.
  const row = resultRows[active];
  if (row) revealInContainer(tp.results, row);
}

/** Reflect current nav selection to the UI + seek the player. */
function selectOccurrence(i) {
  const match = searchNav.current;
  if (!match) return;
  renderCounterAndHighlight();
  seekPlayer(match.seek);   // existing validated seek path (seconds, original timeline)
}

function nextOccurrence() {
  if (!searchNav.canNavigate()) return;
  stopAutoScan();            // manual navigation stops scanning (predictable)
  searchNav.next();
  selectOccurrence(searchNav.index);
}

function prevOccurrence() {
  if (!searchNav.canNavigate()) return;
  stopAutoScan();
  searchNav.previous();
  selectOccurrence(searchNav.index);
}

async function searchTranscript() {
  if (!currentVideoId) return;
  const q = tp.query.value.trim();
  clearSearchResults();
  lastSearchQuery = q;
  if (!q) return;  // empty query -> empty state, button disabled (already cleared)
  try {
    const res = await fetch(`/api/lectures/${currentVideoId}/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || `${res.status}`);
    if (!data.count) {
      tp.results.append(el('div', { className: 'muted', textContent: 'No matches.' }));
      return;  // zero matches -> counter cleared, Next disabled (from clearSearchResults)
    }

    // Results arrive in ascending timestamp order from the backend.
    data.results.forEach((r, i) => {
      const row = el('button', { className: 'tp-hit', type: 'button',
        title: 'Jump to ' + formatTime(r.seek) });
      row.append(el('span', { className: 'tp-time', textContent: formatTime(r.seek) }));
      row.append(el('span', { className: 'tp-text', textContent: r.text }));
      row.addEventListener('click', () => {
        // Clicking a specific row selects that occurrence via the nav, keeping
        // the counter/highlight consistent (single source of truth).
        selectByIndex(i);
      });
      tp.results.append(row);
      resultRows.push(row);
    });

    // Feed matches into the nav; selection resets to the FIRST match.
    searchNav.setResults(q, data.results);
    setNavButtons();
    renderCounterAndHighlight();
    // New query with results selects the first match (no auto-seek until the
    // user acts). Counter shows "1 of N".
  } catch (err) {
    tp.results.append(el('div', { className: 'err', textContent: err.message }));
  }
}

/** Jump selection to a specific index (used when a result row is clicked). */
function selectByIndex(i) {
  stopAutoScan();            // explicit row click stops scanning
  if (searchNav.select(i) === null) return;
  selectOccurrence(i);
}

tp.search.addEventListener('click', searchTranscript);
tp.prev.addEventListener('click', prevOccurrence);
tp.next.addEventListener('click', nextOccurrence);
tp.auto.addEventListener('click', toggleAutoScan);
tp.query.addEventListener('keydown', (e) => { if (e.key === 'Enter') searchTranscript(); });
// Changing the query text stops any active scan (results will be recomputed).
tp.query.addEventListener('input', () => { if (isScanning()) stopAutoScan(); });

// Drive the current-segment highlight from real playback time.
els.video.addEventListener('timeupdate', () => highlightCurrent(els.video.currentTime || 0));

// ---------------------------------------------------------------------------
// D-refresh: recent lectures list + reattach a persisted lecture.
// Reattaching restores the stored video + transcript WITHOUT creating a job.
// ---------------------------------------------------------------------------
async function loadRecentLectures() {
  // Two lists share the same data: the pre-lecture picker list and the
  // workspace left-rail switcher. Populate whichever exist.
  const wraps = ['#recentList', '#recentListPicker']
    .map((sel) => document.querySelector(sel)).filter(Boolean);
  if (!wraps.length) return;
  try {
    const res = await fetch('/api/lectures?limit=15');
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || `${res.status}`);
    for (const wrap of wraps) {
      wrap.innerHTML = '';
      if (!data.count) { wrap.append(el('span', { className: 'muted', textContent: 'None yet.' })); continue; }
      for (const lec of data.lectures) {
        const row = el('button', { className: 'recent-item', type: 'button' });
        if (lec.id === currentVideoId) row.classList.add('active');   // mark the active lecture
        row.append(el('span', { className: 'recent-title', textContent: lec.title }));
        row.append(el('span', { className: 'recent-stage', textContent: lec.stage }));
        row.addEventListener('click', () => reattachLecture(lec));
        wrap.append(row);
      }
    }
  } catch (err) {
    for (const wrap of wraps) {
      wrap.innerHTML = '';
      wrap.append(el('span', { className: 'err', textContent: 'Could not load recents: ' + err.message }));
    }
  }
}

async function reattachLecture(lec) {
  // Reopen the stored video from the server (honest recovery) and restore
  // its transcript. No upload, no new job.
  resetTranscriptUI();
  if (currentObjectUrl) { URL.revokeObjectURL(currentObjectUrl); currentObjectUrl = null; }

  els.lectureTitle.textContent = lec.title || 'Lecture';
  els.playerError.textContent = '';
  els.picker.classList.add('hidden');
  els.playerWrap.classList.remove('hidden');

  player.markLoading();
  // Source the retained media by id; if absent, the <video> error handler reports it.
  els.video.src = `/api/lectures/${lec.id}/media`;
  els.video.load();

  currentVideoId = lec.id;
  loadRecentLectures();   // refresh rail so the newly-active lecture is highlighted
  if (lec.stage === 'failed') {
    tpSetStatus('This lecture failed: ' + (lec.error || 'unknown error'), true);
    await refreshTranscript();            // show any partial segments honestly
  } else if (lec.stage === 'ready') {
    await refreshTranscript();
    tp.query.disabled = allSegments.length === 0;
    tp.search.disabled = allSegments.length === 0;
    tpSetStatus(`Reopened — ${allSegments.length} segments. Search or click a line to jump.`);
    loadBookmarks();   // bookmarks persist across refresh/reattach
  } else {
    // still processing -> resume polling
    tp.barWrap.classList.remove('hidden');
    tpSetStatus('Resuming processing…');
    startPolling();
  }
}

// Expose a tiny hook for diagnostics (not required by the app).
window.__learnloop = { player, formatTime, seek: (t) => player.seekTo(t), highlightCurrent };

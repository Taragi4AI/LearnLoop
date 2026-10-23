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

// Keyboard: space toggles play when the player is focused-ish.
document.addEventListener('keydown', (e) => {
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

// ---- Boot ----
checkHealth();
els.mediaState.dataset.state = STATE.IDLE;
els.mediaState.textContent = STATE_LABEL[STATE.IDLE];

// Expose a tiny hook for diagnostics (not required by the app).
window.__learnloop = { player, formatTime };

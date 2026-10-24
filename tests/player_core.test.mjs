// Unit tests for the pure player logic (public/player-core.js).
// Run with Node's built-in test runner — no third-party deps:
//   node --test tests/player_core.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateFile, formatTime, clampSeek, normalizeRate,
  createPlayerController, STATE, ALLOWED_RATES,
} from '../public/player-core.js';

test('validateFile accepts supported MIME types', () => {
  assert.equal(validateFile({ name: 'a.mp4', type: 'video/mp4' }).ok, true);
  assert.equal(validateFile({ name: 'b.webm', type: 'video/webm' }).ok, true);
});

test('validateFile accepts by extension when MIME is empty', () => {
  assert.equal(validateFile({ name: 'lecture.mp4', type: '' }).ok, true);
  assert.equal(validateFile({ name: 'lecture.WEBM', type: '' }).ok, true);
});

test('validateFile rejects unsupported types', () => {
  const r = validateFile({ name: 'c.mkv', type: 'video/x-matroska' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /Unsupported/);
});

test('validateFile rejects missing file (cancelled selection)', () => {
  assert.equal(validateFile(null).ok, false);
  assert.equal(validateFile(undefined).ok, false);
});

test('formatTime handles minutes, hours, and bad input', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(5), '0:05');
  assert.equal(formatTime(65), '1:05');
  assert.equal(formatTime(3661), '1:01:01');
  assert.equal(formatTime(NaN), '0:00');
  assert.equal(formatTime(Infinity), '0:00');
  assert.equal(formatTime(-10), '0:00');
});

test('clampSeek stays within [0, duration]', () => {
  assert.equal(clampSeek(50, 100), 50);
  assert.equal(clampSeek(-5, 100), 0);
  assert.equal(clampSeek(150, 100), 100);
  assert.equal(clampSeek(NaN, 100), 0);
  // Unknown duration -> no upper clamp but not negative.
  assert.equal(clampSeek(999, NaN), 999);
  assert.equal(clampSeek(-1, NaN), 0);
});

test('normalizeRate snaps to allowed rates', () => {
  for (const r of ALLOWED_RATES) assert.equal(normalizeRate(r), r);
  assert.equal(normalizeRate(1.3), 1.25);
  assert.equal(normalizeRate(3), 2);
  assert.equal(normalizeRate('1.5'), 1.5);
  assert.equal(normalizeRate('bad'), 1);
});

// ---- Controller behavior with a fake media element ----
function fakeMedia() {
  return {
    currentTime: 0,
    duration: 100,
    playbackRate: 1,
    _paused: true,
    get paused() { return this._paused; },
    play() { this._paused = false; },
    pause() { this._paused = true; },
  };
}

test('controller gates controls until ready', () => {
  const media = fakeMedia();
  const p = createPlayerController(media);
  assert.equal(p.state, STATE.IDLE);
  assert.equal(p.canControl(), false);

  // Controls are no-ops before ready.
  p.togglePlay();
  assert.equal(media.paused, true);
  p.seekTo(50);
  assert.equal(media.currentTime, 0);

  p.markLoading();
  p.markReady();
  assert.equal(p.state, STATE.READY);
  assert.equal(p.canControl(), true);
});

test('controller play/pause toggles media', () => {
  const media = fakeMedia();
  const p = createPlayerController(media);
  p.markLoading(); p.markReady();
  p.togglePlay();
  assert.equal(media.paused, false);
  p.togglePlay();
  assert.equal(media.paused, true);
});

test('controller seekTo and seekBy clamp to duration', () => {
  const media = fakeMedia();
  const p = createPlayerController(media);
  p.markLoading(); p.markReady();
  p.seekTo(200);
  assert.equal(media.currentTime, 100);
  p.seekTo(10);
  assert.equal(media.currentTime, 10);
  p.seekBy(-50);
  assert.equal(media.currentTime, 0);
  p.seekBy(9999);
  assert.equal(media.currentTime, 100);
});

test('controller setRate normalizes and applies', () => {
  const media = fakeMedia();
  const p = createPlayerController(media);
  assert.equal(p.setRate(1.3), 1.25);
  assert.equal(media.playbackRate, 1.25);
  assert.equal(p.setRate(5), 2);
  assert.equal(media.playbackRate, 2);
});

test('controller emits state changes and reports times', () => {
  const media = fakeMedia();
  const p = createPlayerController(media);
  const seen = [];
  p.onStateChange((s) => seen.push(s));
  p.markLoading(); p.markReady(); p.markPlaying(); p.markPaused(); p.markEnded();
  assert.deepEqual(seen, [STATE.LOADING, STATE.READY, STATE.PLAYING, STATE.PAUSED, STATE.ENDED]);

  media.currentTime = 65; media.duration = 3661;
  const t = p.times();
  assert.equal(t.label, '1:05 / 1:01:01');
});

test('error state blocks control and persists over pause', () => {
  const media = fakeMedia();
  const p = createPlayerController(media);
  p.markLoading(); p.markError();
  assert.equal(p.state, STATE.ERROR);
  assert.equal(p.canControl(), false);
  p.markPaused(); // must not override an error
  assert.equal(p.state, STATE.ERROR);
});

// --- G3.2 LL-G3.2-004: explicit pause() for Looper activation ---
test('pause() pauses a playing media element (idempotent)', () => {
  const media = fakeMedia();
  const p = createPlayerController(media);
  p.markLoading(); p.markReady();
  media.play();
  assert.equal(media.paused, false);
  assert.equal(p.isPlaying(), true);
  p.pause();
  assert.equal(media.paused, true);
  // idempotent: calling again keeps it paused, does not toggle to play
  p.pause();
  assert.equal(media.paused, true);
  assert.equal(p.isPlaying(), false);
});

test('pause() is a no-op when media is not controllable (no video loaded)', () => {
  const media = fakeMedia();
  const p = createPlayerController(media);   // state IDLE, canControl() false
  // Should not throw and should not attempt to touch an unready element.
  p.pause();
  assert.equal(p.isPlaying(), false);
});

test('pause() leaves an already-paused lecture paused', () => {
  const media = fakeMedia();
  const p = createPlayerController(media);
  p.markLoading(); p.markReady();            // ready but paused
  assert.equal(media.paused, true);
  p.pause();
  assert.equal(media.paused, true);          // stays paused, never plays
});

// --- G5.3: play(), volume/mute/rate/position read+write surface ---
function fakeMediaFull() {
  const m = fakeMedia();
  m.volume = 1; m.muted = false;
  return m;
}

test('play() starts a paused, controllable lecture (idempotent)', () => {
  const media = fakeMediaFull();
  const p = createPlayerController(media);
  p.markLoading(); p.markReady();
  p.play();
  assert.equal(media.paused, false);
  assert.equal(p.isPlaying(), true);
  p.play();                                   // idempotent — stays playing
  assert.equal(media.paused, false);
});

test('play() is a no-op when not controllable', () => {
  const media = fakeMediaFull();
  const p = createPlayerController(media);    // IDLE
  p.play();
  assert.equal(media.paused, true);
});

test('setVolume clamps to [0,1] and getVolume reflects it', () => {
  const media = fakeMediaFull();
  const p = createPlayerController(media);
  assert.equal(p.setVolume(0.5), 0.5);
  assert.equal(media.volume, 0.5);
  assert.equal(p.setVolume(5), 1);            // clamp high
  assert.equal(p.setVolume(-1), 0);           // clamp low
  assert.equal(p.getVolume(), 0);
});

test('setMuted / isMuted toggle the media mute flag', () => {
  const media = fakeMediaFull();
  const p = createPlayerController(media);
  assert.equal(p.setMuted(true), true);
  assert.equal(media.muted, true);
  assert.equal(p.isMuted(), true);
  assert.equal(p.setMuted(false), false);
  assert.equal(p.isMuted(), false);
});

test('position() and rate() read the live element', () => {
  const media = fakeMediaFull();
  const p = createPlayerController(media);
  media.currentTime = 12.5; media.playbackRate = 1.5;
  assert.equal(p.position(), 12.5);
  assert.equal(p.rate(), 1.5);
});

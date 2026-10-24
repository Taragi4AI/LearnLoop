// Unit tests for pure live-chat helpers (public/chat-stream.js).
// Run with: node --test tests/chat_stream.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldApplyResponseEvent, reconcileFinalText, autoScrollDecision }
  from '../public/chat-stream.js';

// --- stale-response guard (spec test 5) ---
test('applies events for the active/current response', () => {
  assert.equal(shouldApplyResponseEvent('r1', 'r1', 'r1'), true);
});
test('applies when ids are unavailable (best-effort)', () => {
  assert.equal(shouldApplyResponseEvent(undefined, 'r1', 'r1'), true);
  assert.equal(shouldApplyResponseEvent('r1', null, null), true);
});
test('rejects a stale event targeting a different, newer bubble', () => {
  // event is for r1, but the active/current bubble is r2 → stale, reject.
  assert.equal(shouldApplyResponseEvent('r1', 'r2', 'r2'), false);
});

// --- final-vs-streamed reconciliation (spec tests 2 & 4) ---
test('identical final text does not duplicate', () => {
  assert.equal(reconcileFinalText('hello world', 'hello world'), null);
});
test('final that extends streamed replaces it (no double-append)', () => {
  assert.equal(reconcileFinalText('hello', 'hello world'), 'hello world');
});
test('final shorter than streamed keeps the fuller streamed text (interrupt-safe)', () => {
  assert.equal(reconcileFinalText('hello world so far', 'hello'), null);
});
test('no final text keeps streamed', () => {
  assert.equal(reconcileFinalText('partial', null), null);
  assert.equal(reconcileFinalText('partial', ''), null);
});

// --- auto-scroll follow decision (spec tests 6 & 7) ---
test('follows bottom when the user is pinned there', () => {
  assert.deepEqual(autoScrollDecision(true), { scroll: true, showJump: false });
});
test('does not drag the user up; shows jump control instead', () => {
  assert.deepEqual(autoScrollDecision(false), { scroll: false, showJump: true });
});

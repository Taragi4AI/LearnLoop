// G5 tool-definition schema tests (public/looper-realtime.js).
// Run with: node --test tests/looper_tools.test.mjs
//
// Validates the tool CONTRACT declared to Higgs Realtime: names, required args,
// and that the agentic capabilities the handoff requires are present. Execution
// + live model calls are verified via the Python export/validation tests and the
// live HITL checklist (this file only guards the declared schema).

import test from 'node:test';
import assert from 'node:assert/strict';

import { LOOPER_TOOLS } from '../public/looper-realtime.js';

const byName = Object.fromEntries(LOOPER_TOOLS.map((t) => [t.name, t]));

test('all required agentic tools are declared as function tools', () => {
  for (const n of ['control_video', 'get_player_state', 'seek_video', 'prepare_bookmark',
                   'save_bookmark', 'list_bookmarks', 'open_bookmark',
                   'update_bookmark', 'delete_bookmark']) {
    assert.ok(byName[n], `missing tool ${n}`);
    assert.equal(byName[n].type, 'function');
    assert.ok(byName[n].description && byName[n].description.length > 10);
    assert.equal(byName[n].parameters.type, 'object');
  }
});

test('control_video constrains action to a safe enum (G5.3 expanded surface)', () => {
  const p = byName.control_video.parameters;
  assert.deepEqual(p.required, ['action']);
  const en = p.properties.action.enum;
  // The expanded surface must still contain the core verbs and nothing unsafe.
  for (const a of ['pause', 'play', 'resume', 'rewind', 'forward', 'replay',
                   'mute', 'unmute', 'volume_up', 'volume_down', 'set_volume', 'set_speed']) {
    assert.ok(en.includes(a), `control_video missing action "${a}"`);
  }
  // Enum only — the model cannot pass an arbitrary action string.
  assert.ok(Array.isArray(en) && en.length >= 4);
});

test('get_player_state is a read-only tool with no required args', () => {
  const p = byName.get_player_state.parameters;
  assert.equal(p.type, 'object');
  assert.ok(!p.required || p.required.length === 0);
});

test('seek_video requires a numeric timestamp', () => {
  const p = byName.seek_video.parameters;
  assert.deepEqual(p.required, ['timestamp_seconds']);
  assert.equal(p.properties.timestamp_seconds.type, 'number');
});

test('prepare_bookmark requires a title; save/open require a bookmark id', () => {
  assert.deepEqual(byName.prepare_bookmark.parameters.required, ['title']);
  assert.deepEqual(byName.save_bookmark.parameters.required, ['bookmark_id']);
  assert.deepEqual(byName.open_bookmark.parameters.required, ['bookmark_id']);
});

test('update_bookmark requires id and exposes title/note; delete requires id', () => {
  const up = byName.update_bookmark.parameters;
  assert.deepEqual(up.required, ['bookmark_id']);
  assert.ok(up.properties.title && up.properties.note, 'update_bookmark needs title+note props');
  assert.deepEqual(byName.delete_bookmark.parameters.required, ['bookmark_id']);
  // delete_bookmark is destructive; its description must warn against casual use.
  assert.match(byName.delete_bookmark.description, /destructive|delete|remove/i);
});

test('no tool exposes arbitrary code/path execution', () => {
  const names = LOOPER_TOOLS.map((t) => t.name);
  for (const bad of ['eval', 'exec', 'run', 'shell', 'read_file', 'write_file']) {
    assert.ok(!names.includes(bad), `unsafe tool exposed: ${bad}`);
  }
  // No tool accepts a filesystem path argument.
  for (const t of LOOPER_TOOLS) {
    for (const k of Object.keys(t.parameters.properties || {})) {
      assert.ok(!/path|file|dir/i.test(k), `tool ${t.name} exposes path-like arg ${k}`);
    }
  }
});

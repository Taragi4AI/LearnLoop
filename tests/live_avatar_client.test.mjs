import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLiveAvatarClient } from '../public/live-avatar-client.js';

test('avatar voice and video share one player and audio unsubscribe keeps the face visible', async () => {
  const old = { window: globalThis.window, fetch: globalThis.fetch, WebSocket: globalThis.WebSocket, location: globalThis.location };
  const rooms = [];
  const sockets = [];
  class FakeRoom {
    constructor() { this.handlers = {}; rooms.push(this); }
    on(event, callback) { this.handlers[event] = callback; }
    connect() { return Promise.resolve(); }
    startAudio() { return Promise.resolve(); }
    disconnect() { this.handlers.disconnected?.(); return Promise.resolve(); }
    emit(name, ...args) { this.handlers[name]?.(...args); }
  }
  class FakeSocket {
    static OPEN = 1;
    static CLOSING = 2;
    constructor() { this.readyState = 1; this.sent = []; sockets.push(this); queueMicrotask(() => this.onopen?.()); }
    send(raw) {
      const message = JSON.parse(raw); this.sent.push(message);
      if (message.type === 'auth') queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: 'ready' }) }));
    }
    close() { this.readyState = 3; }
  }
  const video = {
    classList: { hidden: true, toggle(_name, hidden) { this.hidden = hidden; } },
    muted: false, paused: false, srcObject: null,
    play() { this.paused = false; return Promise.resolve(); },
    pause() { this.paused = true; },
  };
  const frame = { dataset: {} };
  const track = (kind) => ({ kind, attached: [], detached: [],
    attach(element) { this.attached.push(element); },
    detach(element) { this.detached.push(element); },
  });
  const audio = track('audio');
  const picture = track('video');
  try {
    globalThis.window = { LivekitClient: { Room: FakeRoom, RoomEvent: {
      TrackSubscribed: 'subscribed', TrackUnsubscribed: 'unsubscribed', Disconnected: 'disconnected',
    } } };
    globalThis.WebSocket = FakeSocket;
    globalThis.location = { href: 'http://localhost:3000/learn.html', protocol: 'http:' };
    globalThis.fetch = async (_url, options) => options?.method === 'DELETE'
      ? { ok: true } : { ok: true, json: async () => ({
        session_id: 'session-1', avatar_identity: 'boson-avatar', livekit_url: 'wss://example.test',
        viewer_token: 'viewer', relay_token: 'relay',
      }) };
    const client = createLiveAvatarClient({ video, frame });
    await client.start('builtin_emma_v1');
    const participant = { identity: 'boson-avatar' };
    rooms[0].emit('subscribed', audio, null, participant);
    rooms[0].emit('subscribed', picture, null, participant);
    assert.deepEqual(audio.attached, [video]);
    assert.deepEqual(picture.attached, [video]);
    assert.equal(frame.dataset.liveVideo, 'true');
    client.clear();
    assert.equal(video.muted, true);
    assert.equal(video.paused, false, 'interruption must not freeze the face');
    client.audio('AAAA');
    assert.equal(video.muted, false);
    assert.equal(sockets[0].sent.at(-1).type, 'audio');
    rooms[0].emit('unsubscribed', audio, null, participant);
    assert.equal(frame.dataset.liveVideo, 'true', 'audio loss must not hide the video track');
    await client.stop();
    assert.equal(frame.dataset.liveVideo, 'false');
    assert.equal(video.classList.hidden, true);
  } finally {
    Object.assign(globalThis, old);
  }
});

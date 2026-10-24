import test from 'node:test';
import assert from 'node:assert/strict';

import { createLooperSession } from '../public/avatar-realtime.js';

test('interrupts avatar playout without cancelling a completed model response', async () => {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  let socket;

  class FakeWebSocket {
    static OPEN = 1;
    constructor() {
      this.readyState = FakeWebSocket.OPEN;
      this.listeners = new Map();
      this.sent = [];
      socket = this;
    }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; this.listeners.get('close')?.(); }
    emit(type, payload = {}) {
      this.listeners.get(type)?.(type === 'message' ? { data: JSON.stringify(payload) } : payload);
    }
  }

  globalThis.fetch = async () => ({ ok: true, json: async () => ({ value: 'test-secret' }) });
  globalThis.WebSocket = FakeWebSocket;
  try {
    const session = createLooperSession({ textOnly: true, remotePlayback: true, tools: [] });
    await session.start();
    socket.emit('open');

    socket.emit('message', { type: 'response.created', response: { id: 'r1' } });
    socket.emit('message', { type: 'response.output_audio.delta', delta: 'AAAA' });
    socket.emit('message', { type: 'response.done', response: { id: 'r1', output: [] } });
    assert.equal(session.state, 'speaking'); // avatar audio is still playing
    session.interrupt();
    assert.equal(socket.sent.filter((event) => event.type === 'response.cancel').length, 0);
    assert.equal(session.state, 'live');

    socket.emit('message', { type: 'response.created', response: { id: 'r2' } });
    session.interrupt();
    assert.equal(socket.sent.filter((event) => event.type === 'response.cancel').length, 1);
    socket.emit('message', { type: 'error', error: {
      type: 'invalid_request_error', message: 'No active response to cancel.',
    } });
    assert.equal(session.state, 'live'); // late cancel error must not break the conversation

    socket.emit('message', { type: 'error', error: {
      type: 'invalid_request_error', message: 'A different request error.',
    } });
    assert.equal(session.state, 'error');
    session.stop();
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
  }
});

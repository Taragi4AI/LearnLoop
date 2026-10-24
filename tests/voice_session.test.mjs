import test from 'node:test';
import assert from 'node:assert/strict';
import { isStopListeningCommand, createDisabledMultiSpeakerDetector } from '../public/voice-session.js';

test('direct stop-listening phrases are application commands', () => {
  for (const phrase of [
    'stop listening', 'stop', 'stop talking', 'be quiet', 'go to sleep',
    'end the conversation', 'stop the session', 'Could you please stop?',
    'Jarvis, please stop listening now', 'Looper, stop listening now',
    'please stop listening', 'please, stop Jarvis',
  ]) assert.equal(isStopListeningCommand(phrase), true, phrase);
});

test('narrative mentions of stopping remain ordinary conversation', () => {
  for (const phrase of [
    'I stopped listening earlier', 'why did you stop talking?',
    'the lecture says stop listening to distractions', 'please explain stop signs',
  ]) assert.equal(isStopListeningCommand(phrase), false, phrase);
});

test('multi-speaker fallback is explicitly disabled instead of guessing from VAD', async () => {
  const statuses = [];
  const detector = createDisabledMultiSpeakerDetector({ onStatus: (status) => statuses.push(status) });
  assert.equal(detector.enabled, false);
  await detector.start({ stream: {}, onMultipleSpeakers: () => assert.fail('disabled detector must not report') });
  assert.equal(detector.running, true);
  assert.equal(statuses[0].enabled, false);
  detector.stop();
  assert.equal(detector.running, false);
});

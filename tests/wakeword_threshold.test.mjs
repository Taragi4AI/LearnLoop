import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Hey Jarvis listener uses the calibrated local detection threshold', async () => {
  const source = await readFile(new URL('../public/wakeword.js', import.meta.url), 'utf8');
  assert.match(source, /detectionThreshold\s*=\s*0\.1/);
});

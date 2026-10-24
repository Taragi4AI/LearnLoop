import test from 'node:test';
import assert from 'node:assert/strict';

import { isStudyQuestion } from '../public/session-csp.js';

const citations = [
  { text: 'Linear regression models the relationship between an output variable and input variables.' },
  { text: 'The slope and intercept define the fitted line.' },
];

test('Study Package admits a grounded lecture-concept question', () => {
  assert.equal(isStudyQuestion('Can you explain the output variable?', citations), true);
});

test('Study Package excludes player navigation and conversation filler', () => {
  assert.equal(isStudyQuestion('Can you skip to the middle of the video?', citations), false);
  assert.equal(isStudyQuestion('Can you skip to the middle of the video? Code break okay? Yeah.', citations), false);
  assert.equal(isStudyQuestion('What are you gonna teach me today?', citations), false);
});

test('Study Package excludes questions without lecture evidence', () => {
  assert.equal(isStudyQuestion('Can you explain quantum entanglement?', citations), false);
});

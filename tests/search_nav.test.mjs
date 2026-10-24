// Unit tests for the pure search-occurrence navigation (public/search-nav.js).
// Run with Node's built-in runner (no deps):  node --test tests/search_nav.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import { createSearchNav } from '../public/search-nav.js';

const M = (starts) => starts.map((s, i) => ({ seek: s, start: s, text: `seg ${i}` }));

test('setResults selects first match and reports total', () => {
  const nav = createSearchNav();
  nav.setResults('x', M([0, 5, 10]));
  assert.equal(nav.index, 0);
  assert.equal(nav.total, 3);
  assert.equal(nav.counterText(), '1 of 3');
  assert.equal(nav.canNavigate(), true);
});

test('next advances and wraps', () => {
  const nav = createSearchNav();
  nav.setResults('x', M([0, 5, 10]));
  nav.next(); assert.equal(nav.index, 1);
  nav.next(); assert.equal(nav.index, 2);
  nav.next(); assert.equal(nav.index, 0);   // wrap forward
});

test('previous moves back and wraps', () => {
  const nav = createSearchNav();
  nav.setResults('x', M([0, 5, 10]));
  nav.previous(); assert.equal(nav.index, 2);  // wrap backward from first
  nav.previous(); assert.equal(nav.index, 1);
  nav.previous(); assert.equal(nav.index, 0);
});

test('select picks a specific index; out-of-range is a no-op', () => {
  const nav = createSearchNav();
  nav.setResults('x', M([0, 5, 10]));
  assert.ok(nav.select(2));
  assert.equal(nav.index, 2);
  assert.equal(nav.select(99), null);
  assert.equal(nav.index, 2);               // unchanged
  assert.equal(nav.select(-1), null);
  assert.equal(nav.index, 2);
});

test('query change resets selection to first', () => {
  const nav = createSearchNav();
  nav.setResults('a', M([0, 5, 10]));
  nav.next();
  nav.setResults('b', M([2, 7]));
  assert.equal(nav.index, 0);
  assert.equal(nav.counterText(), '1 of 2');
});

test('empty / zero matches disables navigation', () => {
  const nav = createSearchNav();
  nav.setResults('', []);
  assert.equal(nav.total, 0);
  assert.equal(nav.index, -1);
  assert.equal(nav.counterText(), '');
  assert.equal(nav.canNavigate(), false);
  assert.equal(nav.next(), null);
  assert.equal(nav.previous(), null);
});

test('single-result state', () => {
  const nav = createSearchNav();
  nav.setResults('x', M([4]));
  assert.equal(nav.counterText(), '1 of 1');
  assert.equal(nav.canNavigate(), true);
  nav.next(); assert.equal(nav.index, 0);     // wraps to itself
  nav.previous(); assert.equal(nav.index, 0);
});

test('identical timestamps advance independently', () => {
  const nav = createSearchNav();
  nav.setResults('x', [
    { seek: 12, start: 12, text: 'a' },
    { seek: 12, start: 12, text: 'b' },
    { seek: 12, start: 12, text: 'c' },
  ]);
  nav.next(); assert.equal(nav.current.text, 'b');
  nav.next(); assert.equal(nav.current.text, 'c');
  nav.next(); assert.equal(nav.current.text, 'a'); // wrap, 3 distinct steps
});

test('counter stays synchronized through next/previous/clear', () => {
  const nav = createSearchNav();
  nav.setResults('x', M([0, 5, 10, 15]));
  assert.equal(nav.counterText(), '1 of 4');
  nav.next(); assert.equal(nav.counterText(), '2 of 4');
  nav.previous(); assert.equal(nav.counterText(), '1 of 4');
  nav.clear();
  assert.equal(nav.counterText(), '');
  assert.equal(nav.canNavigate(), false);
});

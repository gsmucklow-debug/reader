'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { applyPronunciations } = require('../../src/main/pronounce');

test('substitutes a mapped word', () => {
  assert.strictEqual(applyPronunciations('I love reading.', { reading: 'reeding' }), 'I love reeding.');
});

test('case-insensitive match, all occurrences, respelling inserted verbatim (no case-copy)', () => {
  assert.strictEqual(
    applyPronunciations('Reading is fun. READING rocks.', { reading: 'reeding' }),
    'reeding is fun. reeding rocks.'
  );
});

test('whole-word only — never inside another word', () => {
  assert.strictEqual(
    applyPronunciations('already bread readings', { read: 'reed' }),
    'already bread readings'
  );
  assert.strictEqual(applyPronunciations('I read it', { read: 'red' }), 'I red it');
});

test('punctuation and spacing are preserved', () => {
  assert.strictEqual(applyPronunciations('GIF, really?', { gif: 'jiff' }), 'jiff, really?');
});

test('single pass — a substituted respelling is never re-matched by another key', () => {
  assert.strictEqual(applyPronunciations('a', { a: 'b', b: 'c' }), 'b');
});

test('apostrophe words are one token', () => {
  assert.strictEqual(applyPronunciations("don't stop", { don: 'x' }), "don't stop");
});

test('empty respelling is a no-op (never emits an empty string)', () => {
  assert.strictEqual(applyPronunciations('reading', { reading: '' }), 'reading');
  assert.strictEqual(applyPronunciations('reading', { reading: '   ' }), 'reading');
});

test('empty/absent map and empty text pass through', () => {
  assert.strictEqual(applyPronunciations('reading', {}), 'reading');
  assert.strictEqual(applyPronunciations('reading', null), 'reading');
  assert.strictEqual(applyPronunciations('', { reading: 'reeding' }), '');
});

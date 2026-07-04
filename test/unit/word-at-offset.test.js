'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { wordAtOffset } = require('../../src/renderer/word-at-offset');

test('finds the word at a mid-word offset', () => {
  assert.deepStrictEqual(wordAtOffset('the reading room', 6), { word: 'reading', start: 4, end: 11 });
});

test('finds the word at its start and end offsets', () => {
  assert.strictEqual(wordAtOffset('the reading room', 4).word, 'reading'); // start
  assert.strictEqual(wordAtOffset('the reading room', 11).word, 'reading'); // caret just after 'g'
});

test('returns null in a wordless gap (both neighbours non-word)', () => {
  // A single space right after a word resolves to that word via look-behind (the "caret just
  // after a word" case). A truly wordless spot needs non-word chars on BOTH sides.
  assert.strictEqual(wordAtOffset('hi  there', 3), null); // between the two spaces
});

test('caret just after a word, before punctuation, still returns the word', () => {
  assert.strictEqual(wordAtOffset('GIF, ok', 3).word, 'GIF'); // index 3 is the comma; falls back to F
});

test('apostrophe words are one token', () => {
  assert.strictEqual(wordAtOffset("don't stop", 2).word, "don't");
});

test('typographic apostrophe words are one token', () => {
  assert.strictEqual(wordAtOffset('it’s fine', 2).word, 'it’s');
});

test('out-of-range / empty returns null', () => {
  assert.strictEqual(wordAtOffset('', 0), null);
  assert.strictEqual(wordAtOffset('hi', -1), null);
  assert.strictEqual(wordAtOffset('hi', 5), null);
});

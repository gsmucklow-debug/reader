'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTTS } = require('../../src/main/tts-normalize');

test('#N -> "number N"', () => {
  assert.equal(normalizeTTS('Veil #4'), 'Veil number 4');
  assert.equal(normalizeTTS('issue #12'), 'issue number 12');
});

test('ALL-CAPS words are lowercased', () => {
  assert.equal(normalizeTTS("YOU'RE THROUGH IT NOW"), "you're through it now");
  assert.equal(normalizeTTS("DON'T STOP"), "don't stop");
});

test('single-letter capitals (I, A) are left alone', () => {
  assert.equal(normalizeTTS('I saw A bird'), 'I saw A bird');
});

test('dotted acronyms (F.B.I.) are left alone', () => {
  assert.equal(normalizeTTS('Call the F.B.I.'), 'Call the F.B.I.');
});

test('mixed: normalizes both in one pass', () => {
  assert.equal(normalizeTTS('LOAD: 71. Issue #3.'), 'load: 71. Issue number 3.');
});

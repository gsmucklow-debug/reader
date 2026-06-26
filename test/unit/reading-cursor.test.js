'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('../../src/renderer/reading-cursor');

// 2 chapters; ch0: 2 paragraphs (2 + 1 sentences); ch1: 1 paragraph (2 sentences).
const doc = {
  chapters: [
    { paragraphs: [{ sentences: ['a0', 'a1'] }, { sentences: ['b0'] }] },
    { paragraphs: [{ sentences: ['c0', 'c1'] }] },
  ],
};
const A = (ci, pi, si) => ({ ci, pi, si });

test('firstAddress is the very first sentence', () => {
  assert.deepStrictEqual(C.firstAddress(doc), A(0, 0, 0));
});

test('nextAddress walks within a paragraph, across paragraphs, across chapters', () => {
  assert.deepStrictEqual(C.nextAddress(doc, A(0, 0, 0)), A(0, 0, 1));
  assert.deepStrictEqual(C.nextAddress(doc, A(0, 0, 1)), A(0, 1, 0)); // next paragraph
  assert.deepStrictEqual(C.nextAddress(doc, A(0, 1, 0)), A(1, 0, 0)); // next chapter
  assert.strictEqual(C.nextAddress(doc, A(1, 0, 1)), null);           // end of book
});

test('prevAddress is the exact inverse', () => {
  assert.deepStrictEqual(C.prevAddress(doc, A(1, 0, 0)), A(0, 1, 0));
  assert.deepStrictEqual(C.prevAddress(doc, A(0, 1, 0)), A(0, 0, 1));
  assert.strictEqual(C.prevAddress(doc, A(0, 0, 0)), null);           // start of book
});

test('backParagraph: mid-paragraph jumps to its own start', () => {
  assert.deepStrictEqual(C.backParagraph(doc, A(0, 0, 1)), A(0, 0, 0));
});

test('backParagraph: at a paragraph start jumps to the previous paragraph start', () => {
  assert.deepStrictEqual(C.backParagraph(doc, A(0, 1, 0)), A(0, 0, 0));
  assert.deepStrictEqual(C.backParagraph(doc, A(1, 0, 0)), A(0, 1, 0)); // across chapters
});

test('backParagraph at the very first sentence stays put', () => {
  assert.deepStrictEqual(C.backParagraph(doc, A(0, 0, 0)), A(0, 0, 0));
});

test('aheadFrom returns up to N upcoming addresses (for prefetch)', () => {
  assert.deepStrictEqual(C.aheadFrom(doc, A(0, 0, 1), 2), [A(0, 1, 0), A(1, 0, 0)]);
  assert.deepStrictEqual(C.aheadFrom(doc, A(1, 0, 0), 5), [A(1, 0, 1)]); // clamps at book end
});

test('key/eq round-trip', () => {
  assert.strictEqual(C.key(A(1, 0, 1)), '1.0.1');
  assert.ok(C.eq(A(1, 0, 1), A(1, 0, 1)));
  assert.ok(!C.eq(A(1, 0, 1), A(1, 0, 0)));
});

test('textAt returns the sentence at an address', () => {
  assert.strictEqual(C.textAt(doc, A(0, 0, 1)), 'a1');
});

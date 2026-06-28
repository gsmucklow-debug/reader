'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { splitSentences } = require('../../src/parse/split-sentences');

test('splits simple sentences on . ! ?', () => {
  assert.deepStrictEqual(
    splitSentences('Hello world. How are you? I am fine!'),
    ['Hello world.', 'How are you?', 'I am fine!']
  );
});

test('does not split on common titles (Mr. Mrs. Dr.)', () => {
  assert.deepStrictEqual(
    splitSentences('Mr. Darcy greeted Mrs. Bennet and Dr. Jones. They sat down.'),
    ['Mr. Darcy greeted Mrs. Bennet and Dr. Jones.', 'They sat down.']
  );
});

test('does not split on e.g. and i.e.', () => {
  assert.deepStrictEqual(
    splitSentences('Bring fruit, e.g. apples and pears. That is enough.'),
    ['Bring fruit, e.g. apples and pears.', 'That is enough.']
  );
});

test('does not split on initials like J. R. R. Tolkien', () => {
  assert.deepStrictEqual(
    splitSentences('It was written by J. R. R. Tolkien. It sold well.'),
    ['It was written by J. R. R. Tolkien.', 'It sold well.']
  );
});

test('does not split inside decimal numbers', () => {
  assert.deepStrictEqual(
    splitSentences('It cost $3.50 yesterday. Quite cheap.'),
    ['It cost $3.50 yesterday.', 'Quite cheap.']
  );
});

test('does not split on St. and vs.', () => {
  assert.deepStrictEqual(
    splitSentences('We met on St. Paul Street. It was Cats vs. Dogs again. Fun.'),
    ['We met on St. Paul Street.', 'It was Cats vs. Dogs again.', 'Fun.']
  );
});

test('keeps multiple terminators together (?! and !!)', () => {
  assert.deepStrictEqual(
    splitSentences('Really?! Yes!! Go.'),
    ['Really?!', 'Yes!!', 'Go.']
  );
});

test('treats ellipsis as part of the sentence, not a boundary', () => {
  assert.deepStrictEqual(
    splitSentences('Wait... what just happened? Nothing at all.'),
    ['Wait... what just happened?', 'Nothing at all.']
  );
});

test('treats a SPACED ellipsis (. . .) as part of the sentence, not tiny "." clips', () => {
  // A space before a period never ends a real sentence; it's a typeset ellipsis.
  // The bug split this into ["Then I remembered .", ".", ".", "this life too."],
  // and each lone "." synthesized as an audible click/glitch.
  assert.deepStrictEqual(
    splitSentences('Then I remembered . . . this life too.'),
    ['Then I remembered . . . this life too.']
  );
});

test('a spaced ellipsis before a quote/em-dash stays in one sentence', () => {
  assert.deepStrictEqual(
    splitSentences('But I have . . .”—she braced herself—“memories of Vermont.'),
    ['But I have . . .”—she braced herself—“memories of Vermont.']
  );
});

test('a spaced ellipsis still lets the following real terminator split', () => {
  assert.deepStrictEqual(
    splitSentences('Wait . . . what happened? Nothing.'),
    ['Wait . . . what happened?', 'Nothing.']
  );
});

test('includes a trailing closing quote with the sentence', () => {
  assert.deepStrictEqual(
    splitSentences('She said, "Hello." Then she left.'),
    ['She said, "Hello."', 'Then she left.']
  );
});

test('returns the whole string when there is no terminator', () => {
  assert.deepStrictEqual(
    splitSentences('Just a fragment with no end'),
    ['Just a fragment with no end']
  );
});

test('returns an empty array for blank input', () => {
  assert.deepStrictEqual(splitSentences('   '), []);
  assert.deepStrictEqual(splitSentences(''), []);
});

test('collapses internal whitespace/newlines within a sentence', () => {
  assert.deepStrictEqual(
    splitSentences('A line\n   broken over\nrows. Next one.'),
    ['A line broken over rows.', 'Next one.']
  );
});


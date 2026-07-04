'use strict';
// Given a text string and a caret character offset (from the caret-at-point API), return the
// word token covering that offset as { word, start, end }, or null if the caret is on
// whitespace/punctuation with no adjacent word. Pure + DOM-free so it's unit-testable; the DOM
// caret plumbing lives in app.js. Boundary rule matches src/main/pronounce.js (Unicode letters/
// digits + in-word apostrophes).

const WORD_CHAR = /[\p{L}\p{N}'’]/u;

function wordAtOffset(text, index) {
  if (!text || index == null || index < 0 || index > text.length) return null;
  const isWord = (ch) => ch != null && WORD_CHAR.test(ch);
  // Anchor on the char at the caret; if that's not a word char (caret sits just past a word or on
  // a gap), fall back to the char before the caret.
  let at = index;
  if (!isWord(text[at])) at = index - 1;
  if (!isWord(text[at])) return null;
  let start = at;
  let end = at + 1;
  while (start > 0 && isWord(text[start - 1])) start--;
  while (end < text.length && isWord(text[end])) end++;
  return { word: text.slice(start, end), start, end };
}

// Dual-mode export: CommonJS for node:test, browser global for the renderer.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { wordAtOffset };
} else {
  globalThis.WordAtOffset = { wordAtOffset };
}

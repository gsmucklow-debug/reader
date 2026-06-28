'use strict';

/**
 * Abbreviation-aware sentence splitter.
 *
 * This is a Phase-1 contract: the array it returns is exactly what Phase 2 will
 * turn into one audio clip per sentence. Splitting must NOT break mid-sentence on
 * common abbreviations, initials, or decimals — a clip that cuts off at "Mr." would
 * sound broken. A naive split on "." is deliberately not used.
 *
 * Approach: scan for a run of terminators [.!?], then decide whether it's a real
 * sentence boundary by looking at the word immediately before it (abbreviation?
 * single-letter initial? number?) and what follows (whitespace + a capital/quote).
 */

// Words that end in "." but almost never end a sentence. Lower-cased, no dot.
const ABBREVIATIONS = new Set([
  // titles
  'mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'sr', 'jr', 'rev', 'hon', 'pres',
  'gen', 'col', 'capt', 'lt', 'sgt', 'gov', 'sen', 'rep', 'supt',
  // latin / common
  'e.g', 'i.e', 'etc', 'vs', 'al', 'cf', 'viz', 'ca', 'approx',
  // months / time / units (occasionally abbreviated mid-sentence)
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'no', 'vol', 'pp', 'fig', 'inc', 'ltd', 'co', 'corp', 'dept', 'univ', 'est',
]);

const TERMINATORS = new Set(['.', '!', '?']);
// Characters that may trail a terminator and still belong to the same sentence.
const TRAILING = new Set(['"', "'", '”', '’', ')', ']', '»']);

function normalizeWhitespace(s) {
  return s.replace(/\s+/g, ' ').trim();
}

// Look at the token ending just before index `dotPos` (the position of a "."),
// and decide whether that "." is an abbreviation/initial/decimal dot.
function isNonBoundaryDot(text, dotPos) {
  // Grab the alphanumeric/inner-dot run immediately preceding the dot.
  let i = dotPos - 1;
  let word = '';
  while (i >= 0 && /[A-Za-z0-9.]/.test(text[i])) {
    word = text[i] + word;
    i--;
  }

  // A space (or start-of-text) right before the dot => a free-standing "." — a
  // typeset spaced ellipsis ". . ." or stray dot, never the end of a real sentence.
  // Without this each dot became its own tiny "." sentence -> an audible click.
  if (word === '') return true;

  // Single capital letter => an initial (e.g. "J." in "J. R. R. Tolkien").
  if (/^[A-Za-z]$/.test(word)) return true;

  // Decimal / numbered token: digit right before the dot and a digit right after.
  if (/[0-9]$/.test(word) && /[0-9]/.test(text[dotPos + 1] || '')) return true;

  // Known abbreviation (strip a leading inner-dot form like "e.g").
  const key = word.replace(/\.+$/, '').toLowerCase();
  if (ABBREVIATIONS.has(key)) return true;

  return false;
}

/**
 * Split a paragraph of text into sentences.
 * @param {string} text
 * @returns {string[]} sentences with internal whitespace collapsed; [] if blank.
 */
function splitSentences(text) {
  if (!text || !text.trim()) return [];
  // Normalize symbols that TTS reads wrong: #4 -> "number 4"
  text = text.replace(/#(\d)/g, 'number $1');

  const sentences = [];
  let start = 0;
  const n = text.length;

  for (let i = 0; i < n; i++) {
    const ch = text[i];
    if (!TERMINATORS.has(ch)) continue;

    // Consume a run of consecutive terminators ("?!", "!!", "...").
    let end = i;
    while (end + 1 < n && TERMINATORS.has(text[end + 1])) end++;

    const isEllipsis = ch === '.' && end > i; // "..." (run of dots)

    // A lone "." that is part of an abbreviation/initial/decimal is not a boundary.
    if (!isEllipsis && ch === '.' && end === i && isNonBoundaryDot(text, i)) {
      continue;
    }
    // An ellipsis is generally not a boundary on its own; let the real
    // terminator (e.g. the "?" later) close the sentence.
    if (isEllipsis) {
      i = end;
      continue;
    }

    // Absorb trailing quotes/brackets that belong to this sentence.
    let j = end;
    while (j + 1 < n && TRAILING.has(text[j + 1])) j++;

    // Decide if this is a real boundary: end of text, or whitespace then the
    // start of a new chunk (any non-space char — capital, quote, dash, digit).
    const after = text[j + 1];
    const isBoundary =
      after === undefined ||
      (/\s/.test(after) && /\S/.test(text.slice(j + 1)));

    if (isBoundary) {
      const piece = normalizeWhitespace(text.slice(start, j + 1));
      if (piece) sentences.push(piece);
      start = j + 1;
      i = j;
    }
  }

  // Trailing text with no terminator.
  if (start < n) {
    const piece = normalizeWhitespace(text.slice(start));
    if (piece) sentences.push(piece);
  }

  return sentences;
}

module.exports = { splitSentences };

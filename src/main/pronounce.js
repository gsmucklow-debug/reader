'use strict';
// Apply the user's "sounds-like" pronunciation overrides to a sentence BEFORE it reaches the TTS
// engine. Runs ONLY on the synth-text path (main's synthesize handler, right before normalizeTTS),
// so the on-screen sentence stays pristine and the clip cache keys on the respelled result
// (a changed map => cold miss => correct re-synth). `map` is a flat { lowercasedWord: respelling }.
// Matching is case-insensitive, whole-word, all-occurrences, single-pass; the respelling is
// inserted verbatim (no case-copying). This layer is for words with ONE correct pronunciation the
// engine always gets wrong (reading->reeding, GIF->jiff, names) — NOT context-dependent heteronyms
// (read reed/red), which need the later LLM phase.

// Word-char for boundary purposes: Unicode letters/digits + the apostrophes that occur inside
// words (don't, it's, incl. the typographic ’). Everything else is a boundary.
const WORD_CHAR = /[\p{L}\p{N}'’]/u;

function applyPronunciations(text, map) {
  if (!text || !map) return text;
  if (Object.keys(map).length === 0) return text;

  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    if (WORD_CHAR.test(text[i])) {
      let j = i + 1;
      while (j < n && WORD_CHAR.test(text[j])) j++;
      const word = text.slice(i, j);
      const respelling = map[word.toLowerCase()];
      out += (respelling && respelling.trim()) ? respelling : word;
      i = j; // single pass: never re-scan a substituted respelling
    } else {
      out += text[i];
      i++;
    }
  }
  return out;
}

module.exports = { applyPronunciations };

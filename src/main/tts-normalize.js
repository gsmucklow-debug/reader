'use strict';
// Text normalization applied before TTS synthesis AND cache lookup.
// Keeps the displayed sentence unchanged; only affects what Kokoro hears.
//   #4        -> "number 4"   (hash-digit reads as "hash")
//   ALL-CAPS  -> lowercase    (Kokoro spells out all-caps words letter-by-letter)
//     Leaves single letters (I, A) and dotted forms (F.B.I.) unchanged.
function normalizeTTS(text) {
  return text
    .replace(/#(\d)/g, 'number $1')
    .replace(/\b[A-Z][A-Z']*[A-Z]\b/g, w => w.toLowerCase());
}

module.exports = { normalizeTTS };

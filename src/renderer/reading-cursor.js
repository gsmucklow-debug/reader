'use strict';
// Pure, DOM-free, audio-free navigation over a parsed Document. An "address" is
// { ci, pi, si } into doc.chapters[ci].paragraphs[pi].sentences[si]. Mirrors the
// paginate.js pattern: pure functions, dual-mode export, unit-tested in node.

function firstAddress(doc) {
  if (!doc || !doc.chapters || doc.chapters.length === 0) return null;
  return { ci: 0, pi: 0, si: 0 };
}

function nextAddress(doc, a) {
  if (!a) return null;
  const ch = doc.chapters[a.ci];
  const para = ch.paragraphs[a.pi];
  if (a.si + 1 < para.sentences.length) return { ci: a.ci, pi: a.pi, si: a.si + 1 };
  if (a.pi + 1 < ch.paragraphs.length) return { ci: a.ci, pi: a.pi + 1, si: 0 };
  if (a.ci + 1 < doc.chapters.length) return { ci: a.ci + 1, pi: 0, si: 0 };
  return null;
}

function prevAddress(doc, a) {
  if (!a) return null;
  if (a.si > 0) return { ci: a.ci, pi: a.pi, si: a.si - 1 };
  if (a.pi > 0) {
    const p = doc.chapters[a.ci].paragraphs[a.pi - 1];
    return { ci: a.ci, pi: a.pi - 1, si: p.sentences.length - 1 };
  }
  if (a.ci > 0) {
    const ch = doc.chapters[a.ci - 1];
    const pi = ch.paragraphs.length - 1;
    return { ci: a.ci - 1, pi, si: ch.paragraphs[pi].sentences.length - 1 };
  }
  return null;
}

// "Back one paragraph": mid-paragraph → this paragraph's first sentence; already at
// a paragraph start → the previous paragraph's first sentence; book start → stay.
function backParagraph(doc, a) {
  if (!a) return null;
  if (a.si > 0) return { ci: a.ci, pi: a.pi, si: 0 };
  const prev = prevAddress(doc, a);            // first sentence of the previous paragraph
  return prev ? { ci: prev.ci, pi: prev.pi, si: 0 } : { ...a };
}

// The next up-to-n addresses after `a` (for clip prefetch). Excludes `a` itself.
function aheadFrom(doc, a, n) {
  const out = [];
  let cur = a;
  for (let i = 0; i < n; i++) {
    cur = nextAddress(doc, cur);
    if (!cur) break;
    out.push(cur);
  }
  return out;
}

const key = (a) => `${a.ci}.${a.pi}.${a.si}`;
const eq = (a, b) => !!a && !!b && a.ci === b.ci && a.pi === b.pi && a.si === b.si;
const textAt = (doc, a) => doc.chapters[a.ci].paragraphs[a.pi].sentences[a.si];

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { firstAddress, nextAddress, prevAddress, backParagraph, aheadFrom, key, eq, textAt };
} else {
  globalThis.ReaderCursor = { firstAddress, nextAddress, prevAddress, backParagraph, aheadFrom, key, eq, textAt };
}

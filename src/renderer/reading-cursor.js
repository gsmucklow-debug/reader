'use strict';

/**
 * Pure, DOM-free, audio-free navigation over a parsed Document.
 *
 * An "address" is `{ ci, pi, si }` into
 * `doc.chapters[ci].paragraphs[pi].sentences[si]`. The Phase 2 player walks
 * sentences in reading order with these helpers and answers its rewind/prefetch
 * questions. Mirrors the paginate.js pattern: pure functions, dual-mode export,
 * unit-tested in node.
 *
 * Precondition: every function except `firstAddress` assumes `a` is a VALID
 * address into a non-empty parsed Document — i.e.
 * `doc.chapters[a.ci].paragraphs[a.pi].sentences[a.si]` exists. `src/parse/epub.js`
 * guarantees this shape: it pushes a paragraph only when it has >=1 sentence and a
 * chapter only when it has >=1 paragraph (epub.js:236/238), so there are no empty
 * arrays to defend against. Don't add runtime guards here — addresses are produced
 * by these same functions.
 */

/**
 * The first sentence of the book.
 * @param {{chapters:Array}} doc  a parsed Document
 * @returns {?{ci:number,pi:number,si:number}} the start address, or null if empty.
 */
function firstAddress(doc) {
  if (!doc || !doc.chapters || doc.chapters.length === 0) return null;
  return { ci: 0, pi: 0, si: 0 };
}

/**
 * The next sentence in reading order — within the paragraph, then across
 * paragraphs, then across chapters.
 * @param {{chapters:Array}} doc
 * @param {?{ci:number,pi:number,si:number}} a  the current address
 * @returns {?{ci:number,pi:number,si:number}} the next address, or null at book end.
 */
function nextAddress(doc, a) {
  if (!a) return null;
  const ch = doc.chapters[a.ci];
  const para = ch.paragraphs[a.pi];
  if (a.si + 1 < para.sentences.length) return { ci: a.ci, pi: a.pi, si: a.si + 1 };
  if (a.pi + 1 < ch.paragraphs.length) return { ci: a.ci, pi: a.pi + 1, si: 0 };
  if (a.ci + 1 < doc.chapters.length) return { ci: a.ci + 1, pi: 0, si: 0 };
  return null;
}

/**
 * The previous sentence in reading order — the exact inverse of nextAddress.
 * @param {{chapters:Array}} doc
 * @param {?{ci:number,pi:number,si:number}} a  the current address
 * @returns {?{ci:number,pi:number,si:number}} the previous address, or null at book start.
 */
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

/**
 * "Back one paragraph": mid-paragraph → this paragraph's first sentence; already
 * at a paragraph start → the previous paragraph's first sentence; book start → stay.
 * @param {{chapters:Array}} doc
 * @param {?{ci:number,pi:number,si:number}} a  the current address
 * @returns {?{ci:number,pi:number,si:number}} the target paragraph-start address.
 */
function backParagraph(doc, a) {
  if (!a) return null;
  if (a.si > 0) return { ci: a.ci, pi: a.pi, si: 0 };
  const prev = prevAddress(doc, a);            // first sentence of the previous paragraph
  return prev ? { ci: prev.ci, pi: prev.pi, si: 0 } : { ...a };
}

/**
 * The next up-to-`n` addresses after `a`, in reading order (for clip prefetch).
 * Excludes `a` itself and clamps at the end of the book.
 * @param {{chapters:Array}} doc
 * @param {?{ci:number,pi:number,si:number}} a  the address to look ahead from
 * @param {number} n  the maximum number of upcoming addresses to return
 * @returns {Array<{ci:number,pi:number,si:number}>} up to `n` upcoming addresses.
 */
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

/**
 * A stable string key for an address (e.g. cache/prefetch maps).
 * @param {{ci:number,pi:number,si:number}} a
 * @returns {string} `"ci.pi.si"`.
 */
const key = (a) => `${a.ci}.${a.pi}.${a.si}`;

/**
 * Whether two addresses point at the same sentence.
 * @param {?{ci:number,pi:number,si:number}} a
 * @param {?{ci:number,pi:number,si:number}} b
 * @returns {boolean}
 */
const eq = (a, b) => !!a && !!b && a.ci === b.ci && a.pi === b.pi && a.si === b.si;

/**
 * The sentence text at an address.
 * @param {{chapters:Array}} doc
 * @param {{ci:number,pi:number,si:number}} a
 * @returns {string} the sentence string.
 */
const textAt = (doc, a) => doc.chapters[a.ci].paragraphs[a.pi].sentences[a.si];

/**
 * The last sentence of the book (final sentence, final paragraph, final chapter).
 * @param {{chapters:Array}} doc
 * @returns {?{ci:number,pi:number,si:number}} the end address, or null if empty.
 */
function lastAddress(doc) {
  if (!doc || !doc.chapters || doc.chapters.length === 0) return null;
  const ci = doc.chapters.length - 1;
  const paras = doc.chapters[ci].paragraphs;
  const pi = paras.length - 1;
  const si = paras[pi].sentences.length - 1;
  return { ci, pi, si };
}

// Dual-mode export: CommonJS for node:test, browser global for the renderer.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { firstAddress, nextAddress, prevAddress, backParagraph, aheadFrom, key, eq, textAt, lastAddress };
} else {
  globalThis.ReaderCursor = { firstAddress, nextAddress, prevAddress, backParagraph, aheadFrom, key, eq, textAt, lastAddress };
}

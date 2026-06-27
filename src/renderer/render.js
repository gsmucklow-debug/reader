'use strict';

/**
 * Pure Document -> HTML renderer.
 *
 * Kept free of any DOM / Electron dependency so it can be unit-tested in node and
 * reused unchanged in the renderer. The contract that Phase 2 depends on:
 *
 *   every sentence is its own <span class="sentence"> carrying
 *   data-chapter / data-paragraph / data-sentence indices.
 *
 * Phase 2 will look a sentence up by those three indices and toggle a
 * `.is-reading` class on it while the matching audio clip plays. Do not collapse
 * sentences back into plain paragraph text — the per-sentence elements ARE the
 * highlight/seek surface.
 */

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Render a single chapter's `<section>` markup.
 *
 * `ci` is the chapter's index in the WHOLE document, not a local index — the
 * data-chapter attributes must keep matching doc.chapters[ci] so the Phase 2
 * highlight seam (and pagination's sentence lookup) stay addressable even when
 * only this one chapter is mounted in the reading view at a time.
 *
 * @param {{title:?string, paragraphs:Array}} chapter
 * @param {number} ci  index of this chapter within doc.chapters
 * @returns {string} the `<section class="chapter">…</section>` HTML.
 */
function renderChapterHTML(chapter, ci) {
  const out = [];
  out.push(`<section class="chapter" data-chapter="${ci}">`);
  // chapter.title is metadata ONLY (Chapters panel + "Chapter X of Y" strip) — it is
  // never injected here. Headings the book carries are real paragraphs (see below),
  // so they render and narrate in reading order instead of as a separate, unread title.
  chapter.paragraphs.forEach((para, pi) => {
    // A heading paragraph renders as <hN class="chapter-heading"> (level clamped
    // 1..6); a normal paragraph as <p class="para">. Both hold the SAME sentence
    // spans, so the cursor/highlight/pagination address them identically.
    const lvl = Math.min(6, Math.max(1, para.heading || 0));
    const tag = para.heading ? `h${lvl}` : 'p';
    const cls = para.heading ? 'chapter-heading' : 'para';
    out.push(`<${tag} class="${cls}" data-chapter="${ci}" data-paragraph="${pi}">`);
    para.sentences.forEach((sentence, si) => {
      out.push(
        `<span class="sentence" data-chapter="${ci}" data-paragraph="${pi}"` +
          ` data-sentence="${si}">${escapeHtml(sentence)}</span>`
      );
      // a space between sentences so they don't run together visually
      out.push(' ');
    });
    out.push(`</${tag}>`);
  });
  out.push('</section>');
  return out.join('');
}

/**
 * @param {{title:string, chapters:Array}} doc
 * @returns {string} HTML for the reading surface (no <html>/<body> wrapper).
 */
function renderDocumentHTML(doc) {
  return doc.chapters.map((chapter, ci) => renderChapterHTML(chapter, ci)).join('');
}

// Dual-mode export: CommonJS for node:test, browser global for the renderer
// (which runs with contextIsolation and cannot use require()).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { renderDocumentHTML, renderChapterHTML, escapeHtml };
} else {
  globalThis.ReaderRender = { renderDocumentHTML, renderChapterHTML, escapeHtml };
}

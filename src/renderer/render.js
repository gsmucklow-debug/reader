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
  if (chapter.title) {
    out.push(`<h2 class="chapter-title">${escapeHtml(chapter.title)}</h2>`);
  }
  chapter.paragraphs.forEach((para, pi) => {
    out.push(`<p class="para" data-chapter="${ci}" data-paragraph="${pi}">`);
    para.sentences.forEach((sentence, si) => {
      out.push(
        `<span class="sentence" data-chapter="${ci}" data-paragraph="${pi}"` +
          ` data-sentence="${si}">${escapeHtml(sentence)}</span>`
      );
      // a space between sentences so they don't run together visually
      out.push(' ');
    });
    out.push('</p>');
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

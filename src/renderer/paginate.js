'use strict';

/**
 * Pure pagination math for the CSS multi-column reading engine.
 *
 * The reading view lays a single chapter out as a tall, fixed-height multi-column
 * flow that overflows horizontally: column 0 is the first page, column 1 the next,
 * and so on. "Flipping" a page is a `translateX` of the column flow — the DOM is
 * never restructured, so the per-sentence spans stay addressable (the sacred
 * contract). These helpers turn raw measurements (scrollWidth, a span's offsetLeft)
 * into page indices, and are kept DOM-free so they can be unit-tested in node.
 *
 * Geometry (all in CSS px):
 *   - `colWidth`     width of one column == one page's text width.
 *   - `gap`          the column-gap between adjacent columns.
 *   - `colsPerPage`  1 for single-page / scroll, 2 for the two-page spread.
 *   - pitch          = colWidth + gap   (distance from one column to the next).
 *   - stride         = colsPerPage * pitch  (distance from one page/spread to the next).
 *
 * A multi-column element's scrollWidth holds N columns with no trailing gap:
 *   scrollWidth = N*colWidth + (N-1)*gap = N*pitch - gap
 * so the column count inverts cleanly as round((scrollWidth + gap) / pitch).
 */

/** Number of laid-out columns implied by a measured scrollWidth. */
function columnCount(scrollWidth, colWidth, gap) {
  const pitch = colWidth + gap;
  if (!(colWidth > 0) || !(pitch > 0) || !(scrollWidth > 0)) return 1;
  return Math.max(1, Math.round((scrollWidth + gap) / pitch));
}

/**
 * Number of pages (single mode) or spreads (two-page mode) for a chapter.
 * @returns {number} always >= 1.
 */
function pageCount(scrollWidth, colWidth, gap, colsPerPage) {
  const per = colsPerPage > 0 ? colsPerPage : 1;
  return Math.max(1, Math.ceil(columnCount(scrollWidth, colWidth, gap) / per));
}

/**
 * Which page/spread contains a column at horizontal offset `offsetLeft`
 * (e.g. a sentence span's offsetLeft within the column flow). Used by the
 * Phase 2 `goToPageContaining` seam.
 * @returns {number} a 0-based page index.
 */
function pageForOffset(offsetLeft, colWidth, gap, colsPerPage) {
  const pitch = colWidth + gap;
  const per = colsPerPage > 0 ? colsPerPage : 1;
  if (!(pitch > 0) || !(offsetLeft > 0)) return 0;
  // floor, not round: a span at offsetLeft sits in column floor(offsetLeft/pitch).
  // Its offset spans [col*pitch, col*pitch+colWidth); since colWidth < pitch the
  // fraction is < 1, so floor lands on the right column. round pushed spans in the
  // back half of a column onto the next page (a skip flipped forward then snapped back).
  const col = Math.floor(offsetLeft / pitch);
  return Math.floor(col / per);
}

/** Clamp a desired page index into [0, pageCount-1]. */
function clampPage(page, total) {
  const last = Math.max(0, (total || 1) - 1);
  if (!(page > 0)) return 0;
  return Math.min(page, last);
}

/** The translateX (in px, negative) that brings page `page` into view. */
function pageOffset(page, colWidth, gap, colsPerPage) {
  const per = colsPerPage > 0 ? colsPerPage : 1;
  if (!(page > 0)) return 0; // also normalises -0 -> 0 for page 0
  const stride = per * (colWidth + gap);
  return -(page * stride);
}

// Dual-mode export: CommonJS for node:test, browser global for the renderer.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { columnCount, pageCount, pageForOffset, clampPage, pageOffset };
} else {
  globalThis.ReaderPaginate = { columnCount, pageCount, pageForOffset, clampPage, pageOffset };
}

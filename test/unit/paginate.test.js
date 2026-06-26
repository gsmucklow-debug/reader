'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  columnCount,
  pageCount,
  pageForOffset,
  clampPage,
  pageOffset,
} = require('../../src/renderer/paginate');

// A clean geometry to reason about: each column is 600px wide with a 40px gap,
// so the column pitch is 640px. A multi-column element reports
//   scrollWidth = N*colWidth + (N-1)*gap.
const COL = 600;
const GAP = 40;
const sw = (cols) => cols * COL + (cols - 1) * GAP; // exact scrollWidth for N columns

test('columnCount inverts scrollWidth back to the column total', () => {
  assert.strictEqual(columnCount(sw(1), COL, GAP), 1);
  assert.strictEqual(columnCount(sw(2), COL, GAP), 2);
  assert.strictEqual(columnCount(sw(3), COL, GAP), 3);
  assert.strictEqual(columnCount(sw(12), COL, GAP), 12);
});

test('columnCount never returns less than 1, even for empty/degenerate input', () => {
  assert.strictEqual(columnCount(0, COL, GAP), 1);
  assert.strictEqual(columnCount(-50, COL, GAP), 1);
  assert.strictEqual(columnCount(sw(4), 0, GAP), 1); // no real column width
});

test('pageCount in single mode equals the column count', () => {
  assert.strictEqual(pageCount(sw(1), COL, GAP, 1), 1);
  assert.strictEqual(pageCount(sw(7), COL, GAP, 1), 7);
});

test('pageCount in two-page mode is ceil(columns / 2)', () => {
  assert.strictEqual(pageCount(sw(1), COL, GAP, 2), 1); // 1 col  -> 1 spread
  assert.strictEqual(pageCount(sw(2), COL, GAP, 2), 1); // 2 cols -> 1 spread
  assert.strictEqual(pageCount(sw(3), COL, GAP, 2), 2); // 3 cols -> 2 spreads (one half-empty)
  assert.strictEqual(pageCount(sw(4), COL, GAP, 2), 2);
  assert.strictEqual(pageCount(sw(5), COL, GAP, 2), 3);
});

test('pageForOffset maps a column offset to its page (single mode)', () => {
  const pitch = COL + GAP;
  assert.strictEqual(pageForOffset(0, COL, GAP, 1), 0);
  assert.strictEqual(pageForOffset(pitch, COL, GAP, 1), 1);
  assert.strictEqual(pageForOffset(3 * pitch, COL, GAP, 1), 3);
});

test('pageForOffset groups two columns per spread (two-page mode)', () => {
  const pitch = COL + GAP;
  assert.strictEqual(pageForOffset(0, COL, GAP, 2), 0);
  assert.strictEqual(pageForOffset(pitch, COL, GAP, 2), 0); // col 1 shares spread 0
  assert.strictEqual(pageForOffset(2 * pitch, COL, GAP, 2), 1); // col 2 starts spread 1
  assert.strictEqual(pageForOffset(3 * pitch, COL, GAP, 2), 1);
});

test('clampPage keeps the page index within [0, total-1]', () => {
  assert.strictEqual(clampPage(-3, 5), 0);
  assert.strictEqual(clampPage(0, 5), 0);
  assert.strictEqual(clampPage(4, 5), 4);
  assert.strictEqual(clampPage(9, 5), 4);
  assert.strictEqual(clampPage(2, 1), 0); // single-page chapter
});

test('pageOffset is the negative translateX that reveals a page', () => {
  const stride1 = COL + GAP; // single: one column per page
  assert.strictEqual(pageOffset(0, COL, GAP, 1), 0);
  assert.strictEqual(pageOffset(1, COL, GAP, 1), -stride1);
  assert.strictEqual(pageOffset(3, COL, GAP, 1), -3 * stride1);

  const stride2 = 2 * (COL + GAP); // two-page: skip two columns at a time
  assert.strictEqual(pageOffset(1, COL, GAP, 2), -stride2);
  assert.strictEqual(pageOffset(2, COL, GAP, 2), -2 * stride2);
});

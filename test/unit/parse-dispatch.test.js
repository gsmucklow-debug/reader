'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseDocument, extractCover } = require('../../src/parse');

test('parseDocument dispatches .epub to the EPUB parser', async () => {
  const buf = fs.readFileSync(path.join(__dirname, '../fixtures/alice.epub'));
  const doc = await parseDocument(buf, 'alice.epub');
  assert.ok(doc.title && doc.chapters.length > 0);
});

test('parseDocument dispatches .md to the markdown parser', async () => {
  const doc = await parseDocument(Buffer.from('# Hi\n\nYo.'), 'note.md');
  assert.equal(doc.chapters[0].title, 'Hi');
});

test('parseDocument dispatches .markdown too', async () => {
  const doc = await parseDocument(Buffer.from('# Hey\n\nThere.'), 'n.markdown');
  assert.equal(doc.chapters[0].title, 'Hey');
});

test('parseDocument throws a clear error on an unsupported type', async () => {
  await assert.rejects(() => parseDocument(Buffer.from('x'), 'a.pdf'), /Unsupported/);
});

test('extractCover returns null for markdown, never throws', async () => {
  assert.equal(await extractCover(Buffer.from('# x'), 'x.md'), null);
});

test('parseDocument dispatches .docx to the DOCX parser', async () => {
  const buf = fs.readFileSync(path.join(__dirname, '../fixtures/sample.docx'));
  const doc = await parseDocument(buf, 'sample.docx');
  assert.equal(doc.chapters[0].title, 'Sample Word Document');
});

test('extractCover returns null for docx, never throws', async () => {
  assert.equal(await extractCover(Buffer.from('x'), 'x.docx'), null);
});

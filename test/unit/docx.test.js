'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseDocx } = require('../../src/parse/docx');

const FIXTURE = path.join(__dirname, '../fixtures/sample.docx');

test('parseDocx: Heading-1 styles split chapters; title from the first heading', async () => {
  const buf = fs.readFileSync(FIXTURE);
  const doc = await parseDocx(buf, 'sample.docx');
  assert.equal(doc.chapters.length, 2);
  assert.equal(doc.title, 'Sample Word Document');
  assert.equal(doc.chapters[0].title, 'Sample Word Document');
  assert.equal(doc.chapters[0].paragraphs[0].heading, 1);                 // heading spoken
  assert.deepEqual(doc.chapters[0].paragraphs[0].sentences, ['Sample Word Document']);
  assert.equal(doc.chapters[0].paragraphs[1].sentences.length, 2);        // body: two sentences
  assert.equal(doc.chapters[1].title, 'Second Chapter');
});

test('parseDocx accepts a string fileName for the title fallback path without throwing', async () => {
  const buf = fs.readFileSync(FIXTURE);
  const doc = await parseDocx(buf, 'renamed.docx');
  assert.ok(doc.title && doc.chapters.length === 2);   // title still from heading, not filename
});

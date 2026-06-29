'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { blocksToChapters } = require('../../src/parse/blocks-to-chapters');

test('splits chapters at the top-most heading level; heading is the chapter first paragraph', () => {
  const blocks = [
    { tag: 'h1', text: 'One' }, { tag: 'p', text: 'Alpha.' },
    { tag: 'h1', text: 'Two' }, { tag: 'p', text: 'Bravo. Charlie.' },
  ];
  const doc = blocksToChapters(blocks, { fileName: 'x.docx' });
  assert.equal(doc.chapters.length, 2);
  assert.equal(doc.chapters[0].title, 'One');
  assert.equal(doc.chapters[0].paragraphs[0].heading, 1);
  assert.deepEqual(doc.chapters[0].paragraphs[0].sentences, ['One']);
  assert.equal(doc.chapters[1].title, 'Two');
  assert.equal(doc.chapters[1].paragraphs[1].sentences.length, 2); // "Bravo. Charlie."
});

test('uses the SMALLEST heading level present (h2 splits when there is no h1)', () => {
  const blocks = [
    { tag: 'h2', text: 'A' }, { tag: 'p', text: 'x.' },
    { tag: 'h3', text: 'sub' }, { tag: 'p', text: 'y.' },
    { tag: 'h2', text: 'B' }, { tag: 'p', text: 'z.' },
  ];
  const doc = blocksToChapters(blocks, { fileName: 'x.docx' });
  assert.equal(doc.chapters.length, 2);                                  // split on h2, NOT h3
  assert.equal(doc.chapters[0].title, 'A');
  assert.ok(doc.chapters[0].paragraphs.some((p) => p.heading === 3));    // h3 stays in-chapter
});

test('no headings -> exactly one chapter (title from filename)', () => {
  const doc = blocksToChapters([{ tag: 'p', text: 'Just a draft. Two sentences here.' }], { fileName: 'draft.docx' });
  assert.equal(doc.chapters.length, 1);
  assert.equal(doc.chapters[0].title, null);
  assert.equal(doc.title, 'draft');
  assert.equal(doc.chapters[0].paragraphs[0].sentences.length, 2);
});

test('leading content before the first heading forms one untitled chapter', () => {
  const blocks = [
    { tag: 'p', text: 'Intro line.' },
    { tag: 'h1', text: 'Chapter One' }, { tag: 'p', text: 'Body.' },
  ];
  const doc = blocksToChapters(blocks, { fileName: 'x.docx' });
  assert.equal(doc.chapters.length, 2);
  assert.equal(doc.chapters[0].title, null);          // the intro
  assert.equal(doc.chapters[1].title, 'Chapter One');
});

test('title: first top-level heading wins; else filename-without-ext; else Untitled', () => {
  assert.equal(blocksToChapters([{ tag: 'h1', text: 'Real' }, { tag: 'p', text: 'b.' }], { fileName: 'f.docx' }).title, 'Real');
  assert.equal(blocksToChapters([{ tag: 'p', text: 'no heading.' }], { fileName: 'My-Draft.docx' }).title, 'My-Draft');
  assert.equal(blocksToChapters([{ tag: 'p', text: 'x.' }], {}).title, 'Untitled');
});

test('drops empty blocks and chapters that end up with no narratable paragraphs', () => {
  const doc = blocksToChapters([{ tag: 'p', text: '   ' }, { tag: 'p', text: 'Hi.' }], { fileName: 'x.docx' });
  assert.equal(doc.chapters.length, 1);
  assert.equal(doc.chapters[0].paragraphs.length, 1);
});

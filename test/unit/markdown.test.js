'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseMarkdown } = require('../../src/parse/markdown');

test('splits chapters at the top-most heading level; heading is the chapter first paragraph', () => {
  const md = `# One\n\nAlpha.\n\n# Two\n\nBravo. Charlie.`;
  const doc = parseMarkdown(Buffer.from(md), 'x.md');
  assert.equal(doc.chapters.length, 2);
  assert.equal(doc.chapters[0].title, 'One');
  assert.equal(doc.chapters[0].paragraphs[0].heading, 1);
  assert.deepEqual(doc.chapters[0].paragraphs[0].sentences, ['One']);
  assert.equal(doc.chapters[1].title, 'Two');
  // "Bravo. Charlie." -> two sentences in the body paragraph (after the heading paragraph)
  assert.equal(doc.chapters[1].paragraphs[1].sentences.length, 2);
});

test('uses the SMALLEST heading level present (## splits when there is no #)', () => {
  const md = `## A\n\nx.\n\n### sub\n\ny.\n\n## B\n\nz.`;
  const doc = parseMarkdown(Buffer.from(md), 'x.md');
  assert.equal(doc.chapters.length, 2);                 // split on ##, NOT ###
  assert.equal(doc.chapters[0].title, 'A');
  assert.ok(doc.chapters[0].paragraphs.some((p) => p.heading === 3)); // ### stays in-chapter
});

test('a file with no headings is exactly one chapter (title null)', () => {
  const doc = parseMarkdown(Buffer.from('Just a draft. Two sentences here.'), 'draft.md');
  assert.equal(doc.chapters.length, 1);
  assert.equal(doc.chapters[0].title, null);
  assert.equal(doc.chapters[0].paragraphs[0].sentences.length, 2);
});

test('strips a leading YAML frontmatter block (never narrated)', () => {
  const md = `---\ntitle: Secret\ntags: [a,b]\n---\n\n# Real\n\nBody.`;
  const doc = parseMarkdown(Buffer.from(md), 'x.md');
  assert.equal(doc.chapters[0].title, 'Real');
  assert.ok(!JSON.stringify(doc).includes('Secret')); // frontmatter gone
});

test('cleans emphasis + links; fenced code is not narrated', () => {
  const md = '# H\n\nThis is **bold** and a [link](http://x.test).\n\n```\ncode_here()\n```';
  const doc = parseMarkdown(Buffer.from(md), 'x.md');
  const text = doc.chapters[0].paragraphs.flatMap((p) => p.sentences).join(' ');
  assert.ok(text.includes('bold'));
  assert.ok(text.includes('link'));
  assert.ok(!text.includes('x.test'));     // link URL dropped
  assert.ok(!text.includes('code_here'));  // <pre> ignored by htmlToBlocks
});

test('title falls back to filename-without-ext, then Untitled', () => {
  assert.equal(parseMarkdown(Buffer.from('no heading here.'), 'My-Draft.md').title, 'My-Draft');
  assert.equal(parseMarkdown(Buffer.from('x.'), null).title, 'Untitled');
});

test('leading paragraphs before the first heading form one untitled chapter', () => {
  const md = `Intro line.\n\n# Chapter One\n\nBody.`;
  const doc = parseMarkdown(Buffer.from(md), 'x.md');
  assert.equal(doc.chapters.length, 2);
  assert.equal(doc.chapters[0].title, null);              // the intro
  assert.equal(doc.chapters[1].title, 'Chapter One');
});

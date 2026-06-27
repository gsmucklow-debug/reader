'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const cheerio = require('cheerio');
const { renderDocumentHTML } = require('../../src/renderer/render');

// A heading is an ordinary paragraph carrying a `heading` level. The chapter shape
// stays paragraphs[pi].sentences[si], so the cursor/player/pagination are unchanged
// — a heading just renders as <hN> instead of <p> and is read like any sentence.
const DOC = {
  title: 'Demo',
  chapters: [
    {
      title: 'Chapter One',
      paragraphs: [
        { heading: 2, sentences: ['Chapter One'] },
        { sentences: ['First sentence.', 'Second sentence.'] },
        { sentences: ['Lone sentence in paragraph two.'] },
      ],
    },
    {
      title: null,
      paragraphs: [{ sentences: ['He said <b>nope</b> & left.'] }],
    },
  ],
};

test('wraps every sentence in an addressable span keyed by chapter/paragraph/sentence', () => {
  const $ = cheerio.load(renderDocumentHTML(DOC));
  const spans = $('span.sentence');
  // total sentences across the doc = 1 (heading) + 2 + 1 + 1
  assert.strictEqual(spans.length, 5);

  // the heading's sentence is itself addressable + narratable at 0/0/0
  const head = $('span.sentence[data-chapter="0"][data-paragraph="0"][data-sentence="0"]');
  assert.strictEqual(head.length, 1);
  assert.strictEqual(head.text(), 'Chapter One');

  // the first body sentence now lives at ch0/p1/s0 (the heading is paragraph 0)
  const firstBody = $('span.sentence[data-chapter="0"][data-paragraph="1"][data-sentence="0"]');
  assert.strictEqual(firstBody.text(), 'First sentence.');

  // indices stay addressable: ch0/p2/s0 is the lone sentence of paragraph three
  const lone = $('span.sentence[data-chapter="0"][data-paragraph="2"][data-sentence="0"]');
  assert.strictEqual(lone.length, 1);
  assert.strictEqual(lone.text(), 'Lone sentence in paragraph two.');
});

test('renders a heading paragraph as <hN class="chapter-heading"> containing its sentence span', () => {
  const $ = cheerio.load(renderDocumentHTML(DOC));
  const h = $('h2.chapter-heading');
  assert.strictEqual(h.length, 1, 'the level-2 heading paragraph renders as an <h2>');
  // it CONTAINS an addressable span (not plain text) so it highlights + narrates
  const span = h.find('span.sentence');
  assert.strictEqual(span.length, 1);
  assert.strictEqual(span.attr('data-chapter'), '0');
  assert.strictEqual(span.attr('data-paragraph'), '0');
  assert.strictEqual(span.attr('data-sentence'), '0');
  assert.strictEqual(span.text(), 'Chapter One');
});

test('a heading level is clamped 1..6 and chooses the <hN> tag', () => {
  const doc = { title: 'T', chapters: [{ title: 'T', paragraphs: [
    { heading: 1, sentences: ['Top'] },
    { heading: 9, sentences: ['Too deep'] },
  ] }] };
  const $ = cheerio.load(renderDocumentHTML(doc));
  assert.strictEqual($('h1.chapter-heading').length, 1);
  assert.strictEqual($('h6.chapter-heading').length, 1, 'level 9 clamps to h6');
});

test('emits one section per chapter and never injects a chapter-title heading', () => {
  const $ = cheerio.load(renderDocumentHTML(DOC));
  assert.strictEqual($('section.chapter').length, 2);
  assert.strictEqual($('section.chapter').eq(0).attr('data-chapter'), '0');
  assert.strictEqual($('section.chapter').eq(1).attr('data-chapter'), '1');
  // the old injected, never-read title heading is gone for good
  assert.strictEqual($('h2.chapter-title').length, 0);
});

test('normal paragraphs still render as <p class="para"> with their indices', () => {
  const $ = cheerio.load(renderDocumentHTML(DOC));
  const p = $('p.para[data-chapter="0"][data-paragraph="1"]');
  assert.strictEqual(p.length, 1);
  assert.strictEqual(p.find('span.sentence').length, 2);
});

test('escapes HTML in sentence text so book content cannot inject markup', () => {
  const html = renderDocumentHTML(DOC);
  assert.ok(!html.includes('<b>nope</b>'), 'raw tags must be escaped');
  const $ = cheerio.load(html);
  // the literal characters survive as text
  const injected = $('span.sentence[data-chapter="1"]');
  assert.strictEqual(injected.text(), 'He said <b>nope</b> & left.');
});

test('sentence index resets per paragraph, paragraph index resets per chapter', () => {
  const $ = cheerio.load(renderDocumentHTML(DOC));
  const p1 = $('span.sentence[data-chapter="0"][data-paragraph="1"]');
  assert.deepStrictEqual(
    p1.map((_, el) => $(el).attr('data-sentence')).get(),
    ['0', '1']
  );
});

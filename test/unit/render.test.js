'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const cheerio = require('cheerio');
const { renderDocumentHTML } = require('../../src/renderer/render');

const DOC = {
  title: 'Demo',
  chapters: [
    {
      title: 'Chapter One',
      paragraphs: [
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
  // total sentences across the doc = 2 + 1 + 1
  assert.strictEqual(spans.length, 4);

  const first = spans.eq(0);
  assert.strictEqual(first.attr('data-chapter'), '0');
  assert.strictEqual(first.attr('data-paragraph'), '0');
  assert.strictEqual(first.attr('data-sentence'), '0');
  assert.strictEqual(first.text(), 'First sentence.');

  // indices are addressable: ch0/p1/s0 is the lone sentence of paragraph two
  const lone = $('span.sentence[data-chapter="0"][data-paragraph="1"][data-sentence="0"]');
  assert.strictEqual(lone.length, 1);
  assert.strictEqual(lone.text(), 'Lone sentence in paragraph two.');
});

test('emits one section per chapter with the chapter title when present', () => {
  const $ = cheerio.load(renderDocumentHTML(DOC));
  assert.strictEqual($('section.chapter').length, 2);
  assert.strictEqual($('section.chapter').eq(0).attr('data-chapter'), '0');
  assert.strictEqual($('h2.chapter-title').first().text(), 'Chapter One');
  // chapter two has no title => no heading in that section
  assert.strictEqual($('section.chapter').eq(1).find('h2.chapter-title').length, 0);
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
  const p0 = $('span.sentence[data-chapter="0"][data-paragraph="0"]');
  assert.deepStrictEqual(
    p0.map((_, el) => $(el).attr('data-sentence')).get(),
    ['0', '1']
  );
});

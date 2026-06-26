'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  findOpfPath,
  parseOpf,
  readingOrder,
  htmlToBlocks,
  parseEpub,
} = require('../../src/parse/epub');

const FIX = path.join(__dirname, '..', 'fixtures');

// ---------------------------------------------------------------------------
// Pure unit tests (synthetic input → exact assertions)
// ---------------------------------------------------------------------------

test('findOpfPath reads the rootfile from container.xml', () => {
  const container = `<?xml version="1.0"?>
    <container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
      <rootfiles>
        <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
      </rootfiles>
    </container>`;
  assert.strictEqual(findOpfPath(container), 'OEBPS/content.opf');
});

const SAMPLE_OPF = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>The Test Book</dc:title>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>
    <item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
  </manifest>
  <spine>
    <itemref idref="cover"/>
    <itemref idref="nav"/>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
  </spine>
</package>`;

test('parseOpf extracts title and spine items with resolved zip paths', () => {
  const parsed = parseOpf(SAMPLE_OPF, 'OEBPS/content.opf');
  assert.strictEqual(parsed.title, 'The Test Book');
  assert.deepStrictEqual(
    parsed.spine.map((s) => s.href),
    ['OEBPS/cover.xhtml', 'OEBPS/nav.xhtml', 'OEBPS/text/ch1.xhtml', 'OEBPS/text/ch2.xhtml']
  );
  // the nav item carries its property through
  const nav = parsed.spine.find((s) => s.href.endsWith('nav.xhtml'));
  assert.ok(nav.properties.includes('nav'));
});

test('readingOrder follows spine order and skips the nav document', () => {
  const parsed = parseOpf(SAMPLE_OPF, 'OEBPS/content.opf');
  assert.deepStrictEqual(readingOrder(parsed), [
    'OEBPS/cover.xhtml',
    'OEBPS/text/ch1.xhtml',
    'OEBPS/text/ch2.xhtml',
  ]);
});

test('htmlToBlocks returns block text in order and skips nav/header/footer/script', () => {
  const html = `<html><body>
    <header>RUNNING HEADER</header>
    <nav epub:type="toc"><ol><li>Contents</li></ol></nav>
    <h1>Chapter One</h1>
    <p>First paragraph.</p>
    <p>Second   paragraph
       across lines.</p>
    <script>ignore()</script>
    <footer>page 12</footer>
  </body></html>`;
  assert.deepStrictEqual(htmlToBlocks(html), [
    { tag: 'h1', text: 'Chapter One' },
    { tag: 'p', text: 'First paragraph.' },
    { tag: 'p', text: 'Second paragraph across lines.' },
  ]);
});

// ---------------------------------------------------------------------------
// Integration tests against the three real Gutenberg EPUB fixtures
// ---------------------------------------------------------------------------

const FIXTURES = [
  { file: 'pride-and-prejudice.epub', titleIncludes: 'Pride and Prejudice',
    openingPhrase: 'a truth universally acknowledged' },
  { file: 'alice.epub', titleIncludes: 'Alice',
    openingPhrase: 'beginning to get very tired' },
  { file: 'frankenstein.epub', titleIncludes: 'Frankenstein',
    openingPhrase: null },
];

for (const fx of FIXTURES) {
  test(`parseEpub(${fx.file}) yields ordered chapters with sentences`, async () => {
    const buf = fs.readFileSync(path.join(FIX, fx.file));
    const doc = await parseEpub(buf);

    assert.ok(doc.title.includes(fx.titleIncludes),
      `title "${doc.title}" should include "${fx.titleIncludes}"`);
    assert.ok(doc.chapters.length > 1, 'should have multiple chapters');

    // every paragraph carries a non-empty sentence array
    let sentenceCount = 0;
    for (const ch of doc.chapters) {
      for (const p of ch.paragraphs) {
        assert.ok(Array.isArray(p.sentences) && p.sentences.length > 0);
        sentenceCount += p.sentences.length;
      }
    }
    assert.ok(sentenceCount > 200, `expected lots of sentences, got ${sentenceCount}`);

    // the nav/toc document must not leak in as readable content: no chapter
    // should be just a table-of-contents list of every other chapter.
    const allText = doc.chapters
      .flatMap((c) => c.paragraphs.flatMap((p) => p.sentences))
      .join(' ');
    if (fx.openingPhrase) {
      assert.ok(allText.includes(fx.openingPhrase),
        `opening phrase "${fx.openingPhrase}" should appear in body text`);
    }
  });
}

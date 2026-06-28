'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const JSZip = require('jszip');

const {
  findOpfPath,
  parseOpf,
  readingOrder,
  htmlToBlocks,
  parseEpub,
  coverImage,
} = require('../../src/parse/epub');

const FIX = path.join(__dirname, '..', 'fixtures');

// Build a minimal in-memory EPUB from a list of chapters so the heading behavior
// can be unit-tested end-to-end through the real parseEpub (TOC resolution + block
// extraction + chapter assembly), without committing binary fixtures.
//   chapters: [{ href, html, navTitle? }]  — navTitle adds a TOC <a> for that href.
async function buildEpub({ title = 'Synthetic Book', chapters }) {
  const zip = new JSZip();
  zip.file('META-INF/container.xml',
    `<?xml version="1.0"?>
     <container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
       <rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles>
     </container>`);

  const manifest = ['<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'];
  const spine = [];
  const navLinks = [];
  chapters.forEach((ch, i) => {
    const id = `c${i}`;
    manifest.push(`<item id="${id}" href="${ch.href}" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="${id}"/>`);
    if (ch.navTitle) navLinks.push(`<li><a href="${ch.href}">${ch.navTitle}</a></li>`);
    zip.file(ch.href,
      `<?xml version="1.0" encoding="utf-8"?>
       <html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head>
       <body>${ch.html}</body></html>`);
  });

  zip.file('content.opf',
    `<?xml version="1.0" encoding="utf-8"?>
     <package xmlns="http://www.idpf.org/2007/opf" version="3.0">
       <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title></metadata>
       <manifest>${manifest.join('')}</manifest>
       <spine>${spine.join('')}</spine>
     </package>`);

  zip.file('nav.xhtml',
    `<?xml version="1.0" encoding="utf-8"?>
     <html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
     <body><nav epub:type="toc"><ol>${navLinks.join('')}</ol></nav></body></html>`);

  return zip.generateAsync({ type: 'nodebuffer' });
}

// ---------------------------------------------------------------------------
// Heading behavior (Phase 2.6): headings are kept as readable paragraphs.
// ---------------------------------------------------------------------------

test('keeps a leading in-doc heading as the first (readable) paragraph', async () => {
  const buf = await buildEpub({ chapters: [
    { href: 'ch1.xhtml', html: '<h1>BARRY</h1><p>He woke at noon.</p>' },
  ] });
  const doc = await parseEpub(buf);
  const ch = doc.chapters[0];
  assert.strictEqual(ch.paragraphs[0].heading, 1, 'first paragraph carries its heading level');
  assert.deepStrictEqual(ch.paragraphs[0].sentences, ['BARRY'], 'the heading text is kept and read');
  assert.strictEqual(ch.paragraphs[1].heading, undefined, 'the body paragraph is a normal paragraph');
  assert.deepStrictEqual(ch.paragraphs[1].sentences, ['He woke at noon.']);
  assert.strictEqual(ch.title, 'BARRY', 'metadata title falls back to the first heading');
});

test('keeps BOTH headings when a chapter has two (no silent drop)', async () => {
  const buf = await buildEpub({ chapters: [
    { href: 'ch1.xhtml', html: '<h2>Chapter Two</h2><h2>Chapter Two</h2><p>Body text here.</p>' },
  ] });
  const doc = await parseEpub(buf);
  const headings = doc.chapters[0].paragraphs.filter((p) => p.heading);
  assert.strictEqual(headings.length, 2, 'both heading paragraphs are preserved');
  assert.deepStrictEqual(headings.map((h) => h.sentences[0]), ['Chapter Two', 'Chapter Two']);
  assert.strictEqual(doc.chapters[0].title, 'Chapter Two', 'title still derived from the first heading');
});

test('synthesizes a heading from the TOC title when a chapter has none of its own', async () => {
  const buf = await buildEpub({ chapters: [
    { href: 'ch1.xhtml', html: '<p>Just body text, no heading.</p>', navTitle: 'A Real Chapter' },
  ] });
  const doc = await parseEpub(buf);
  const ch = doc.chapters[0];
  assert.strictEqual(ch.paragraphs[0].heading, 2, 'a level-2 heading is synthesized');
  assert.deepStrictEqual(ch.paragraphs[0].sentences, ['A Real Chapter'], 'synthesized from the TOC title');
  assert.deepStrictEqual(ch.paragraphs[1].sentences, ['Just body text, no heading.']);
  assert.strictEqual(ch.title, 'A Real Chapter');
});

test('does NOT synthesize a heading when a chapter has neither heading nor title', async () => {
  const buf = await buildEpub({ chapters: [
    { href: 'ch1.xhtml', html: '<p>Front matter with no heading and no TOC title.</p>' },
  ] });
  const doc = await parseEpub(buf);
  const ch = doc.chapters[0];
  assert.strictEqual(ch.paragraphs[0].heading, undefined, 'no synthesized heading');
  assert.strictEqual(ch.title, null, 'no metadata title either');
});

test('TOC title wins over an in-doc heading for the chapter title metadata', async () => {
  const buf = await buildEpub({ chapters: [
    { href: 'ch1.xhtml', html: '<h2>In-Body Heading</h2><p>Body.</p>', navTitle: 'TOC Name' },
  ] });
  const doc = await parseEpub(buf);
  const ch = doc.chapters[0];
  // title = navTitles.get(href) || firstHeadingText || null
  assert.strictEqual(ch.title, 'TOC Name');
  // the chapter's own heading is still kept and read (not replaced by the TOC title)
  assert.strictEqual(ch.paragraphs[0].heading, 2);
  assert.deepStrictEqual(ch.paragraphs[0].sentences, ['In-Body Heading']);
});

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
// Cover extraction (Phase 3): parseOpf coverId + coverImage()
// ---------------------------------------------------------------------------

test('parseOpf finds the EPUB3 cover-image item id', () => {
  const opf = `<?xml version="1.0"?><package><metadata><dc:title>T</dc:title></metadata>
    <manifest>
      <item id="cov" href="img/cover.jpg" media-type="image/jpeg" properties="cover-image"/>
      <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
    </manifest><spine><itemref idref="c1"/></spine></package>`;
  const r = parseOpf(opf, 'OEBPS/content.opf');
  assert.strictEqual(r.coverId, 'cov');
});

test('parseOpf finds the EPUB2 meta-name=cover item id', () => {
  const opf = `<?xml version="1.0"?><package><metadata><dc:title>T</dc:title>
      <meta name="cover" content="theCover"/></metadata>
    <manifest>
      <item id="theCover" href="cover.png" media-type="image/png"/>
      <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
    </manifest><spine><itemref idref="c1"/></spine></package>`;
  const r = parseOpf(opf, 'content.opf');
  assert.strictEqual(r.coverId, 'theCover');
});

test('coverImage returns {bytes,ext} or null for a real EPUB, never throws', async () => {
  const buf = fs.readFileSync(path.join(FIX, 'alice.epub'));
  const cov = await coverImage(buf);
  if (cov !== null) {
    assert.ok(cov.bytes && cov.bytes.length > 0);
    assert.match(cov.ext, /^(jpg|jpeg|png|gif|webp|svg)$/);
  }
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

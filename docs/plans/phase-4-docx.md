# Phase 4 (part 2) — DOCX Reading Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan
> task-by-task. Also use superpowers:test-driven-development (tests fail first) and
> superpowers:verification-before-completion (run commands, show output, before any "done").
>
> **STRICT — separation of duties:** You are a *builder*. Do **NOT** edit any planning doc
> (`HANDOFF.md`, `design.md`, anything in `docs/plans/`). When finished, deliver a written report
> in chat; the planning session records it. Make small, frequent commits on a branch.
>
> **Recommended model:** Sonnet 4.6, medium.

**Goal:** Let the user add a Word `.docx` draft to the library and listen to it — sentence
highlighting, chapters-from-headings, headings read aloud, auto-resume, and the shelf — exactly
like an EPUB or Markdown file, by emitting the same `Document` the reader already consumes.

**Architecture:** A new pure-ish `parseDocx(buffer, fileName)` renders `.docx` → HTML with
`mammoth` (pure-JS; Word "Heading 1–6" styles → `<h1>–<h6>`), then **reuses the EPUB
`htmlToBlocks()`** and a **new shared `blocksToChapters()` helper extracted from `markdown.js`**.
The format dispatcher (`src/parse/index.js`) gains a `.docx` route. No reader, IPC, library, or
`document.json` schema changes — `.docx` books are the same `Document` shape as EPUB/Markdown, so
resume/finished/remove/persist work with zero new code.

**Tech Stack:** `mammoth` (new, pure-JS), existing `cheerio` (via `htmlToBlocks`) and `jszip`
(used by the fixture generator), `node:test` unit tests, Playwright-`_electron` smoke.

**Read before starting:**
- [`2026-06-28-docx-reading-design.md`](./2026-06-28-docx-reading-design.md) — the validated design
  + locked scope (DOCX only, not legacy `.doc`; no new cover code; no reader/IPC/library changes;
  defer `core.xml` title).
- [`phase-4-markdown.md`](./phase-4-markdown.md) — the part-1 plan you are mirroring. DOCX is the
  same trick with mammoth instead of marked, **plus** a refactor that pulls the chapter-split logic
  out of `markdown.js` into a shared helper both parsers call.
- `src/parse/markdown.js` — you are **extracting** its chapter-split (the `topLevel` scan + the
  chapter loop + `blockToParagraph` + `baseName` + the title fallback) into a new shared module,
  then making `markdown.js` call it. The existing `markdown.test.js` is your regression net.
- `src/parse/epub.js` — `htmlToBlocks` (lines 183–198) and `HEADING_LEVEL` (200). You reuse
  `htmlToBlocks` verbatim.
- `src/parse/index.js` — the dispatcher (already routes epub + md/markdown; you add docx).
- `src/main/library.js` — **confirm** it already calls `parseDocument(buffer, fileName)` /
  `extractCover(buffer, fileName)` (Markdown wired this; you should need **no** library change). If it
  somehow doesn't, that's a surprise — report it before proceeding.
- `src/parse/split-sentences.js` (`splitSentences`).
- `test/smoke/launch.smoke.js` — note the **already-generalized** `dropFile(win, fixturePath,
  fileName, mime)` helper (~line 30) and the existing Markdown section (~line 555). You mirror it.

**Conventions that are NON-NEGOTIABLE (from the codebase):**
- The `Document` contract is **`{ title, chapters: [ { title, paragraphs: [ { heading?, sentences:[] } ] } ] }`**.
  A heading paragraph carries `heading: <1-6>`; a normal paragraph has only `sentences`. Don't invent
  a new shape.
- **Reuse `htmlToBlocks` — do not write a second HTML/text extractor.** It strips chrome, de-dupes
  nested blocks, ignores `<pre>`, and collects element `.text()` (so an `<img>`'s data-URI and an
  `<a href>` URL never reach the narrator).
- **Extract, don't copy-paste.** The chapter-split logic must live in ONE place
  (`src/parse/blocks-to-chapters.js`) called by both `markdown.js` and `docx.js`. The Markdown tests
  must stay green after the extract — that is the proof the refactor preserved behavior.
- Pure-JS only — no native modules (`mammoth` qualifies; verify in Task 1).
- **Only `.docx` (OOXML).** Not the old binary `.doc`. An unsupported drop must throw
  `Unsupported file type` (existing dispatcher behavior → friendly "Couldn't open that file" card).

---

## Task 0: Branch + baseline

**Step 1:** Branch off `master`.

```bash
git checkout master && git pull --ff-only 2>/dev/null; git checkout -b phase-4-docx
```

**Step 2:** Confirm a clean baseline.

Run: `npm test`
Expected: **103 pass, 0 fail** (the current count on master — note it; never regress it).

---

## Task 1: Add the `mammoth` dependency

**Files:**
- Modify: `package.json` (dependencies)

**Step 1:** Install `mammoth` as a runtime dependency (it must ship in the package — it's pulled
into the parser at runtime, and electron-builder bundles production deps).

```bash
npm install mammoth@^1
```

**Step 2:** Confirm it loads, is pure-JS (no native build step ran), and maps a Heading-1 style to
`<h1>`. Run this one-liner (builds a minimal `.docx` in memory via the already-present `jszip` and
feeds it to mammoth):

```bash
node -e '
const JSZip = require("jszip");
const mammoth = require("mammoth");
const ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Hi</w:t></w:r></w:p></w:body></w:document>`;
const z = new JSZip();
z.file("[Content_Types].xml", ct); z.folder("_rels").file(".rels", rels); z.folder("word").file("document.xml", doc);
z.generateAsync({type:"nodebuffer"}).then(b => mammoth.convertToHtml({buffer:b})).then(r => console.log(JSON.stringify(r.value)));
'
```

Expected: `"<h1>Hi</h1>"` (mammoth's default style map maps style-id `Heading1` → `h1`).
**If you instead see `<p>Hi</p>`**, mammoth needs the style declared: the fixture generator in
Task 3 must add a `word/styles.xml` naming `Heading1` as "heading 1". (Note it; the generator below
has a self-check that catches this.) **If you add `styles.xml`, you must ALSO wire it in three
places** or mammoth won't read it: an `<Override>`/`<Default Extension="xml">` already covers it in
`[Content_Types].xml`, **add a relationship** in a new `word/_rels/document.xml.rels`
(`Type=".../styles" Target="styles.xml"`), and keep the styles part at `word/styles.xml`. Easiest is
to avoid this entirely — the default `Heading1` style-id mapping above should just work.

**Step 3:** Confirm `npm test` still green (103).

**Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "build(deps): add mammoth (pure-JS .docx -> HTML) for Phase 4 part 2"
```

---

## Task 2: Extract `blocksToChapters` — shared helper + refactor `markdown.js` (TDD)

This is the structural heart. Today the chapter-split lives inline in `markdown.js`. Pull it into a
format-agnostic module so `docx.js` reuses it. The Markdown tests are the regression net.

**Files:**
- Create: `src/parse/blocks-to-chapters.js`
- Create: `test/unit/blocks-to-chapters.test.js`
- Modify: `src/parse/markdown.js`

**Step 1: Write the failing tests.** Create `test/unit/blocks-to-chapters.test.js`:

```js
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
```

**Step 2: Run, confirm fail.** `node --test test/unit/blocks-to-chapters.test.js` → FAIL
(`Cannot find module`).

**Step 3: Implement** `src/parse/blocks-to-chapters.js` (this is the logic lifted from
`markdown.js`, with a format-agnostic `baseName` that strips any single trailing extension):

```js
'use strict';

/**
 * A flat block list -> the normalized Document { title, chapters }.
 * A "block" is { tag, text } as produced by htmlToBlocks(). Chapters split at the
 * top-most heading level present (smallest number); leading pre-heading content
 * becomes one untitled chapter; a file with no headings is one untitled chapter.
 * Title: the first top-level heading's text, else filename-without-extension, else
 * 'Untitled'. Format-agnostic: both Markdown and DOCX funnel their HTML through here.
 */

const { splitSentences } = require('./split-sentences');

const HEADING_LEVEL = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

// filename -> title fallback: drop the path and a single trailing extension.
function baseName(fileName) {
  if (!fileName) return null;
  const base = String(fileName).split(/[\\/]/).pop();
  return base.replace(/\.[^.]+$/, '') || null;
}

// One block -> a paragraph, or null if it has no sentences.
function blockToParagraph(b) {
  const sentences = splitSentences(b.text);
  if (sentences.length === 0) return null;
  const lvl = HEADING_LEVEL[b.tag];
  return lvl ? { heading: lvl, sentences } : { sentences };
}

function blocksToChapters(blocks, { fileName } = {}) {
  // Top-most heading level present (smallest number); null if no headings.
  let topLevel = null;
  for (const b of blocks) {
    const lvl = HEADING_LEVEL[b.tag];
    if (lvl && (topLevel === null || lvl < topLevel)) topLevel = lvl;
  }

  const chapters = [];
  let current = null;
  let docTitle = null;
  const startChapter = (title) => {
    current = { title: title || null, paragraphs: [] };
    chapters.push(current);
  };

  for (const b of blocks) {
    const isChapterHead = topLevel !== null && HEADING_LEVEL[b.tag] === topLevel;
    if (isChapterHead) {
      startChapter(b.text);
      if (docTitle === null) docTitle = b.text;
    } else if (current === null) {
      startChapter(null); // leading content before the first top-level heading
    }
    const para = blockToParagraph(b);
    if (para) current.paragraphs.push(para);
  }

  const kept = chapters.filter((c) => c.paragraphs.length > 0);
  const title = docTitle || baseName(fileName) || 'Untitled';
  return { title, chapters: kept };
}

module.exports = { blocksToChapters, baseName, blockToParagraph, HEADING_LEVEL };
```

**Step 4: Run, confirm pass.** `node --test test/unit/blocks-to-chapters.test.js` → all PASS.

**Step 5: Refactor `markdown.js` to call the shared helper.** Replace the body so it keeps ONLY the
Markdown-specific front-end (frontmatter strip + `marked`), delegating the rest:

```js
'use strict';

/**
 * Markdown -> normalized Document. Markdown-specific front-end only:
 *   strip YAML frontmatter -> marked.parse -> HTML -> htmlToBlocks() ->
 *   the shared blocksToChapters() (top-most-heading split, { heading?, sentences }).
 * Pure: (Buffer|string, fileName) in, Document out. No I/O, no native modules.
 */

const { marked } = require('marked');
const { htmlToBlocks } = require('./epub');
const { blocksToChapters } = require('./blocks-to-chapters');

// Strip a single leading YAML frontmatter block (--- ... ---) at the very start.
function stripFrontmatter(text) {
  const s = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text; // drop a leading BOM
  const m = s.match(/^\s*---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/);
  return m ? s.slice(m[0].length) : s;
}

function parseMarkdown(buffer, fileName) {
  const raw = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer);
  const html = marked.parse(stripFrontmatter(raw));
  const blocks = htmlToBlocks(html);
  return blocksToChapters(blocks, { fileName });
}

module.exports = { parseMarkdown, stripFrontmatter };
```

**Step 6: Run the regression net.** `node --test test/unit/markdown.test.js` → still **7/7 PASS**
(unchanged file, proving the extract preserved behavior). Then `npm test` → green (103 + 6 new = 109).

> Why the Markdown tests still pass: the generic `baseName` (`/\.[^.]+$/`) strips `.md`/`.markdown`
> just as the old `/\.(md|markdown)$/i` did, and the chapter loop is byte-for-byte the same logic.

**Step 7: Commit**

```bash
git add src/parse/blocks-to-chapters.js test/unit/blocks-to-chapters.test.js src/parse/markdown.js
git commit -m "refactor(parse): extract shared blocksToChapters; markdown.js delegates to it"
```

---

## Task 3: The `.docx` fixture (generator + binary)

A `.docx` is a binary OOXML zip, so commit a tiny generated fixture plus the script that makes it
(for reproducibility). The script **self-checks** that mammoth emits `<h1>`.

**Files:**
- Create: `test/fixtures/make-sample-docx.js`
- Create (generated): `test/fixtures/sample.docx`

**Step 1:** Create `test/fixtures/make-sample-docx.js`:

```js
'use strict';
// Generates test/fixtures/sample.docx — a minimal 2-chapter Word doc using the
// built-in "Heading1" paragraph style (which mammoth maps to <h1>). Run once:
//   node test/fixtures/make-sample-docx.js
const fs = require('node:fs');
const path = require('node:path');
const JSZip = require('jszip');

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const para = (text, style) => {
  const pPr = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : '';
  return `<w:p>${pPr}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
};

const DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
${para('Sample Word Document', 'Heading1')}
${para('This is the first paragraph. It has two sentences.')}
${para('Second Chapter', 'Heading1')}
${para('Here is another paragraph with some plain text.')}
</w:body>
</w:document>`;

async function main() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.folder('_rels').file('.rels', RELS);
  zip.folder('word').file('document.xml', DOCUMENT);
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  const out = path.join(__dirname, 'sample.docx');
  fs.writeFileSync(out, buf);
  console.log('wrote', out, buf.length, 'bytes');

  // self-check: mammoth must see the Heading-1 styles as <h1>
  const mammoth = require('mammoth');
  const { value } = await mammoth.convertToHtml({ buffer: buf });
  console.log(value);
  if (!/<h1>/.test(value)) {
    throw new Error('FIXTURE BAD: mammoth did not emit <h1>. Add a word/styles.xml that names ' +
      'style id "Heading1" as "heading 1", then re-run.');
  }
  console.log('OK: mammoth emits <h1> for the Heading1 style');
}
main();
```

**Step 2: Generate + self-verify.**

Run: `node test/fixtures/make-sample-docx.js`
Expected: prints the byte count, then HTML containing `<h1>Sample Word Document</h1>` … and
`OK: mammoth emits <h1>`. (If it throws FIXTURE BAD, add the `word/styles.xml` it describes — a
minimal `styles.xml` declaring `<w:style w:type="paragraph" w:styleId="Heading1"><w:name
w:val="heading 1"/></w:style>` — and re-run.)

**Step 3: Commit** (the binary fixture + its generator):

```bash
git add test/fixtures/make-sample-docx.js test/fixtures/sample.docx
git commit -m "test(fixtures): add sample.docx (2 chapters, Heading1 styles) + generator"
```

---

## Task 4: `parseDocx` — the parser (TDD)

**Files:**
- Create: `src/parse/docx.js`
- Test: `test/unit/docx.test.js`

**Step 1: Write the failing test.** Create `test/unit/docx.test.js`:

```js
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
```

**Step 2: Run, confirm fail.** `node --test test/unit/docx.test.js` → FAIL (`Cannot find module`).

**Step 3: Implement** `src/parse/docx.js`:

```js
'use strict';

/**
 * DOCX -> normalized Document. mammoth converts .docx (OOXML) to HTML, mapping
 * Word "Heading 1-6" styles to <h1>-<h6>; we then reuse the EPUB htmlToBlocks()
 * and the shared blocksToChapters(). Only .docx (OOXML), not the old binary .doc.
 */

const mammoth = require('mammoth');
const { htmlToBlocks } = require('./epub');
const { blocksToChapters } = require('./blocks-to-chapters');

async function parseDocx(buffer, fileName) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const { value: html } = await mammoth.convertToHtml({ buffer: buf }); // ignore .messages (style warnings)
  const blocks = htmlToBlocks(html);
  return blocksToChapters(blocks, { fileName });
}

module.exports = { parseDocx };
```

**Step 4: Run, confirm pass.** `node --test test/unit/docx.test.js` → PASS. Then `npm test` → green
(now ~111).

**Step 5: Commit**

```bash
git add src/parse/docx.js test/unit/docx.test.js
git commit -m "feat(parse): parseDocx — mammoth->HTML->htmlToBlocks->blocksToChapters"
```

---

## Task 5: Route `.docx` through the dispatcher

**Files:**
- Modify: `src/parse/index.js`
- Test: `test/unit/parse-dispatch.test.js` (add one case)

**Step 1: Write the failing test.** Add to `test/unit/parse-dispatch.test.js`:

```js
test('parseDocument dispatches .docx to the DOCX parser', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const buf = fs.readFileSync(path.join(__dirname, '../fixtures/sample.docx'));
  const doc = await parseDocument(buf, 'sample.docx');
  assert.equal(doc.chapters[0].title, 'Sample Word Document');
});

test('extractCover returns null for docx, never throws', async () => {
  assert.equal(await extractCover(Buffer.from('x'), 'x.docx'), null);
});
```

**Step 2: Run, confirm fail.** `node --test test/unit/parse-dispatch.test.js` → the `.docx` case
fails (`Unsupported file type`).

**Step 3: Implement.** In `src/parse/index.js`, add the import and the route:

```js
const { parseDocx } = require('./docx');
```
and inside `parseDocument`, before the throw:
```js
  if (ext === 'docx') return parseDocx(buffer, fileName);
```
(`extractCover` already returns `null` for any non-epub type — no change needed; the new test just
pins that contract for `.docx`.)

**Step 4: Run, confirm pass.** `node --test test/unit/parse-dispatch.test.js` → PASS. `npm test` →
green.

**Step 5: Commit**

```bash
git add src/parse/index.js test/unit/parse-dispatch.test.js
git commit -m "feat(parse): dispatch .docx to parseDocx in the format dispatcher"
```

---

## Task 6: Picker filters + empty-state copy (no tests; UI copy)

**Files:**
- Modify: `src/main/main.js`
- Modify: `src/renderer/index.html`

**Step 1:** In `src/main/main.js`, both `showOpenDialog` filters currently read
`extensions: ['epub', 'md', 'markdown']` (lines ~114 and ~191). Add `'docx'` to **both**:

```js
    filters: [{ name: 'Books', extensions: ['epub', 'md', 'markdown', 'docx'] }],
```

**Step 2:** In `src/renderer/index.html`, both empty-state copies (lines ~89 and ~99) read
`Drag an EPUB or Markdown file here, or click <strong>Add book</strong>.` Update **both** to:

```html
          <p>Drag an EPUB, Markdown, or Word file here, or click <strong>Add book</strong>.</p>
```

> No renderer drop-guard needed: an unsupported drop flows `addAndOpen → libraryAdd →
> parseDocument` which **throws "Unsupported file type"**, caught by `addAndOpen`'s existing catch →
> the "Couldn't open that file" card. Confirm that catch path is intact; don't add new code.

**Step 3:** Sanity. `npm test` → still green. Optional manual: `env -u ELECTRON_RUN_AS_NODE npm
start`, drag in a `.docx`.

**Step 4: Commit**

```bash
git add src/main/main.js src/renderer/index.html
git commit -m "feat(library): accept .docx in the picker + drop copy"
```

---

## Task 7: Smoke flow (`.docx`)

**Files:**
- Modify: `test/smoke/launch.smoke.js`

**Step 1:** Reuse the existing `dropFile(win, fixturePath, fileName, mime)` helper. Add a DOCX
section **immediately after the existing Markdown section** and **before** the final `app.close()`
/ `console.log('SMOKE OK …')` lines (purely additive). Mirror the Markdown block.

> **Ordering note:** the Markdown section *ends* on the library screen (its tile check navigates
> there). This DOCX block *opens* with a `#library-btn` click that assumes you're on the **reader**.
> Check where the Markdown section leaves the app: if it's already on the library screen, drop the
> leading `#library-btn` click here (or it will auto-wait/time out, since `#library-btn` is the
> reader-only "← Library" back button). Match the actual end-state of the section above you.

```js
  // --- Phase 4 (part 2): DOCX reading --------------------------------------
  await win.click('#library-btn');
  await win.waitForSelector('body[data-screen="library"]', { timeout: 5000 });
  await dropFile(
    win, path.join(ROOT, 'test', 'fixtures', 'sample.docx'), 'sample.docx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  );
  await win.waitForSelector('body[data-screen="reader"]', { timeout: 5000 });

  // The first narratable span is the chapter heading itself (0.0.0).
  const docxFirst = await win.evaluate(() => {
    const el = document.querySelector('span.sentence');
    return el ? `${el.dataset.chapter}.${el.dataset.paragraph}.${el.dataset.sentence}` : null;
  });
  assert.strictEqual(docxFirst, '0.0.0', `docx first span should be 0.0.0, got ${docxFirst}`);

  // Narration advances through the REAL engine.
  await win.evaluate(() => document.getElementById('play-pause').click());
  await win.waitForFunction(() => {
    const el = document.querySelector('.sentence.is-reading');
    return el && `${el.dataset.chapter}.${el.dataset.paragraph}.${el.dataset.sentence}` !== '0.0.0';
  }, null, { timeout: 30000 });
  await win.evaluate(() => {
    const b = document.getElementById('play-pause');
    if (b.getAttribute('aria-label') === 'Pause') b.click();
  });

  // The tile uses a TITLE-CARD (no embedded cover), not an <img>.
  await win.click('#library-btn');
  await win.waitForSelector('#shelf-active .book-tile', { timeout: 10000 });
  const docxTile = await win.evaluate(() => {
    const tiles = [...document.querySelectorAll('#shelf-active .book-tile')];
    const t = tiles.find((x) => (x.querySelector('.tile-title')?.textContent || '').includes('Sample Word'));
    return t ? { card: !!t.querySelector('.cover.title-card'), img: !!t.querySelector('.cover img') } : null;
  });
  assert.ok(docxTile && docxTile.card && !docxTile.img, 'docx book should show a title-card, not a cover');
  console.log('  ✓ docx (.docx): title-card tile, opens, heading is 0.0.0, narration advances');
```

> Use the SAME selectors the Markdown section uses. If the Markdown block references `.tile-title`
> / `.cover.title-card` / `.cover img` differently, match it exactly — those class names come from
> `library-view.js` and must not be guessed.

**Step 2: Run.** `npm run smoke`
Expected: `SMOKE OK` (exit 0) with the new docx line, **and all prior assertions (EPUB + Markdown)
intact**.

**Step 3: Commit**

```bash
git add test/smoke/launch.smoke.js
git commit -m "test(smoke): DOCX reading — title-card add, heading=0.0.0, narration advances"
```

---

## Task 8: Package gate + report (do NOT edit planning docs)

**Step 1:** Full suite green.

Run: `npm test` → all pass (103 prior + blocks-to-chapters 6 + docx 2 + dispatch 2 = **~113**; note
the real final number).
Run: `npm run smoke` → `SMOKE OK`.

**Step 2:** Build and confirm `mammoth` + the new sources ship in the asar.

Run: `npm run dist:win`
Run: `npx asar list dist/win-unpacked/resources/app.asar | grep -E "parse/docx|parse/blocks-to-chapters|node_modules/mammoth/"`
Expected: lines for `/src/parse/docx.js`, `/src/parse/blocks-to-chapters.js`, and `mammoth` under
`node_modules`. **mammoth is pure-JS** — it must NOT need `asarUnpack` and must NOT pull a native
`.node` (if `dist:win` tries to build/download a native binary, stop and report — that contradicts
the pure-JS premise).

**Step 3:** Launch the packaged app and add the `.docx` fixture by hand — confirm it appears with a
title-card and reads. (Storage path is `userData`, identical packaged vs dev, but build anyway to
catch any `build.files` gap.)

**Step 4: Write your report in chat** (NOT into any doc). Cover: what shipped; the
test/smoke/package numbers; whether mammoth's default style map handled `Heading1` or you needed a
`styles.xml` in the fixture; any deviations; and honest caveats (voice quality on a real `.docx`
draft is ears-only; the Add-button native-dialog path can't be smoke-driven). The planning session
records it into HANDOFF.

---

## Acceptance criteria (check against THIS list, not your restatement)

1. Drag-drop **or** Add imports a `.docx`; it appears on the shelf with a **title-card** (no cover
   image), stored under `userData/library/books/<sha256>/` like any book.
2. Opening reads it aloud with **sentence highlighting**; Word **Heading** styles drive **chapters**
   and are **spoken** (first narratable span is the heading, `0.0.0`).
3. A `.docx` with **no heading styles** reads as **one chapter** (covered in
   `blocks-to-chapters.test.js`).
4. **Resume / finished / remove / persist** work identically to EPUB/Markdown — with **no new code**
   in the reader/library beyond the dispatcher route (same `document.json` shape).
5. **No regression:** EPUB and Markdown paths + all existing unit tests + smoke stay green; the
   Markdown tests prove the `blocksToChapters` extract preserved behavior; an unsupported drop shows
   the friendly "Couldn't open that file" card.
6. **Ships in the package:** `mammoth`, `src/parse/docx.js`, and `src/parse/blocks-to-chapters.js`
   are in the asar; `npm run dist:win` succeeds with no native build.

## Out of scope (do not build)

Legacy `.doc` (binary); RTF / ODT; pronunciation overrides (still a later Phase 4 item);
`docProps/core.xml` title extraction (deferred nicety); DOCX images/tables/footnotes as rendered
content (text-only via `htmlToBlocks`, by design); per-book settings; app rename.

**Do NOT patch `htmlToBlocks`** for any DOCX quirk — it is shared with the verified EPUB + Markdown
paths; a change there risks regressing both. Accept mammoth's HTML as-is.

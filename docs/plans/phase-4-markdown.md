# Phase 4 (part 1) — Markdown Reading Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan
> task-by-task. Also use superpowers:test-driven-development (tests fail first) and
> superpowers:verification-before-completion (run commands, show output, before any "done").
>
> **STRICT — separation of duties:** You are a *builder*. Do **NOT** edit any planning doc
> (`HANDOFF.md`, `design.md`, anything in `docs/plans/`). When finished, deliver a written report
> in chat; the planning session records it. Make small, frequent commits on a branch.
>
> **Recommended model:** Sonnet 4.6, medium.

**Goal:** Let the user add their own Markdown drafts (`.md` / `.markdown`) to the library and listen
to them — sentence highlighting, chapters-from-headings, headings read aloud, auto-resume, and the
shelf — exactly like EPUBs, by emitting the same `Document` the reader already consumes.

**Architecture:** A new pure `parseMarkdown(buffer, fileName)` renders Markdown → HTML with `marked`
(pure-JS), then **reuses the EPUB `htmlToBlocks()` path** and the Phase 2.6 `{heading?, sentences}`
paragraph model. The only new logic is splitting blocks into chapters at the top-most heading level.
A tiny format dispatcher (`src/parse/index.js`) routes `library.add` by file extension. No reader,
IPC, or `document.json` schema changes — `.md` books are the same `Document` shape as EPUB, so
resume/finished/remove/persist work with zero new code.

**Tech Stack:** `marked` (new, pure-JS, zero runtime deps), existing `cheerio` (via `htmlToBlocks`),
`node:test` unit tests, Playwright-`_electron` smoke.

**Read before starting:**
- [`2026-06-28-phase-4-markdown-design.md`](./2026-06-28-phase-4-markdown-design.md) — the validated
  design + the locked scope decisions (Markdown only; no new cover code; no reader/IPC changes).
- `src/parse/epub.js` — **especially** `htmlToBlocks` (lines 183–198), `HEADING_LEVEL` (200), and the
  chapter-building loop in `parseEpub` (244–271). You reuse `htmlToBlocks` verbatim and mirror that
  loop's per-block → paragraph mapping.
- `src/parse/split-sentences.js` (`splitSentences`).
- `src/main/library.js` — `makeLibrary`'s `parse`/`cover` deps + the `add()` body (the dispatch wiring
  point).
- `src/main/main.js` (the `pick-file-bytes` dialog ~line 187), `src/renderer/index.html`
  (`#library-empty` ~line 89, `#empty-state` ~line 99), `test/smoke/launch.smoke.js`
  (`dropBook` ~line 30).

**Conventions that are NON-NEGOTIABLE (from the codebase):**
- The `Document` contract is **`{ title, chapters: [ { title, paragraphs: [ { heading?, sentences:[] } ] } ] }`**.
  A heading paragraph carries `heading: <1-6>`; a normal paragraph has only `sentences`. Don't invent
  a new shape — the reader, library, and `lastAddress` all depend on this exact one.
- **Reuse `htmlToBlocks` — do not write a second HTML/text extractor.** It already strips chrome,
  de-dupes nested blocks, and ignores `<pre>` code fences (not in `BLOCK_TAGS`).
- Pure-JS only — no native modules (`marked` qualifies).
- Cache/IO and parsing must be pure where the tests expect it: `parseMarkdown` is a pure function
  (bytes/string in, `Document` out), unit-tested with inline strings (no fixture dependence).

---

## Task 0: Branch + baseline

**Step 1:** Branch off `master`.

```bash
git checkout master && git pull --ff-only 2>/dev/null; git checkout -b phase-4-markdown
```

**Step 2:** Confirm a clean baseline.

Run: `npm test`
Expected: **82 pass, 0 fail** (the current count on master — note it; never regress it).

---

## Task 1: Add the `marked` dependency

**Files:**
- Modify: `package.json` (dependencies)

**Step 1:** Install `marked` as a runtime dependency (it must ship in the package — it's pulled into
the parser at runtime, and electron-builder bundles production deps).

```bash
npm install marked
```

**Step 2:** Confirm it loads and is pure-JS (no native build step ran):

Run: `node -e "const {marked}=require('marked'); console.log(typeof marked.parse, marked.parse('# Hi').trim())"`
Expected: `function <h1>Hi</h1>` (or `<h1 ...>Hi</h1>` — marked may add an id; either is fine).

**Step 3:** Confirm `npm test` still green (82).

**Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "build(deps): add marked (pure-JS markdown -> HTML) for Phase 4"
```

---

## Task 2: `parseMarkdown` — the parser (pure, TDD, the heart of this phase)

**Files:**
- Create: `src/parse/markdown.js`
- Test: `test/unit/markdown.test.js`

**Step 1: Write the failing tests.** Create `test/unit/markdown.test.js`:

```js
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
```

**Step 2: Run, confirm fail.** `node --test test/unit/markdown.test.js` → FAIL (`Cannot find module`).

**Step 3: Implement** `src/parse/markdown.js`:

```js
'use strict';

/**
 * Markdown -> normalized Document. Reuses the EPUB HTML extraction path:
 *   marked.parse(md) -> HTML -> htmlToBlocks() -> chapter split on the top-most
 *   heading level -> the Phase 2.6 { heading?, sentences } paragraph model.
 * Pure: (Buffer|string, fileName) in, Document out. No I/O, no native modules.
 */

const { marked } = require('marked');
const { htmlToBlocks } = require('./epub');     // reuse the EPUB block extractor
const { splitSentences } = require('./split-sentences');

const HEADING_LEVEL = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

// Strip a single leading YAML frontmatter block (--- ... ---) at the very start.
function stripFrontmatter(text) {
  const s = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text; // drop a leading BOM
  const m = s.match(/^\s*---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/);
  return m ? s.slice(m[0].length) : s;
}

function baseName(fileName) {
  if (!fileName) return null;
  const base = String(fileName).split(/[\\/]/).pop();
  return base.replace(/\.(md|markdown)$/i, '') || null;
}

// One block -> a paragraph, or null if it has no sentences.
function blockToParagraph(b) {
  const sentences = splitSentences(b.text);
  if (sentences.length === 0) return null;
  const lvl = HEADING_LEVEL[b.tag];
  return lvl ? { heading: lvl, sentences } : { sentences };
}

function parseMarkdown(buffer, fileName) {
  const raw = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer);
  const html = marked.parse(stripFrontmatter(raw));
  const blocks = htmlToBlocks(html);

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

module.exports = { parseMarkdown, stripFrontmatter };
```

**Step 4: Run, confirm pass.** `node --test test/unit/markdown.test.js` → all PASS. Then `npm test`
→ still green (now 89: 82 + 7).

> If the emphasis/link test surprises you: `marked` renders `**bold**`→`<strong>`, `[t](u)`→
> `<a href=u>t</a>`, and fenced code → `<pre><code>`. `htmlToBlocks` takes element `.text()` (so the
> `href` attribute is dropped) and never visits `<pre>` (absent from `BLOCK_TAGS`). That's the whole
> reason we go through HTML instead of hand-cleaning markdown.

**Step 5: Commit**

```bash
git add src/parse/markdown.js test/unit/markdown.test.js
git commit -m "feat(parse): parseMarkdown — marked->HTML->htmlToBlocks, top-most-heading chapter split"
```

---

## Task 3: Format dispatcher (`src/parse/index.js`)

Keeps `library.add` format-agnostic: pick the parser/cover extractor by extension.

**Files:**
- Create: `src/parse/index.js`
- Test: `test/unit/parse-dispatch.test.js`

**Step 1: Write the failing tests.** Create `test/unit/parse-dispatch.test.js`:

```js
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
```

**Step 2: Run, confirm fail.** `node --test test/unit/parse-dispatch.test.js` → FAIL (module not found).

**Step 3: Implement** `src/parse/index.js`:

```js
'use strict';
// Format dispatcher: route a (buffer, fileName) to the right parser / cover extractor
// by file extension. library.add uses these as its defaults so it stays format-agnostic.
const path = require('node:path');
const { parseEpub, coverImage } = require('./epub');
const { parseMarkdown } = require('./markdown');

function extOf(fileName) {
  return path.extname(String(fileName || '')).toLowerCase().replace(/^\./, '');
}

async function parseDocument(buffer, fileName) {
  const ext = extOf(fileName);
  if (ext === 'epub') return parseEpub(buffer);
  if (ext === 'md' || ext === 'markdown') return parseMarkdown(buffer, fileName);
  throw new Error(`Unsupported file type: .${ext || '(none)'}`);
}

async function extractCover(buffer, fileName) {
  const ext = extOf(fileName);
  if (ext === 'epub') return coverImage(buffer);
  return null; // markdown (and anything else) has no embedded cover -> title card
}

module.exports = { parseDocument, extractCover };
```

**Step 4: Run, confirm pass.** `node --test test/unit/parse-dispatch.test.js` → PASS. `npm test` → green.

**Step 5: Commit**

```bash
git add src/parse/index.js test/unit/parse-dispatch.test.js
git commit -m "feat(parse): format dispatcher — parseDocument/extractCover by extension"
```

---

## Task 4: Wire the dispatcher into `library.js`

**Files:**
- Modify: `src/main/library.js`
- Test: `test/unit/library.test.js` (add one case)

**Step 1:** In `src/main/library.js`, change the import and the defaults so the real `add` path
dispatches by extension, and pass `fileName` through.

- Replace the parser import:
  ```js
  const { parseDocument, extractCover } = require('../parse');
  ```
  (remove the old `const { parseEpub, coverImage } = require('../parse/epub');` — but **keep**
  `const { lastAddress } = require('../renderer/reading-cursor');`).
- In `makeLibrary`, change the dep defaults:
  ```js
  const parse = deps.parse || parseDocument;
  const cover = deps.cover || extractCover;
  ```
- In `add()`, pass the filename to both:
  ```js
  const doc = await parse(buffer, fileName);
  ...
  const cov = await cover(buffer, fileName);
  ```

The existing fake-dep tests inject single-arg fakes (`async () => fakeDoc`) — the extra `fileName`
arg is harmless.

**Step 2: Write the failing test.** Add to `test/unit/library.test.js` (uses the **real** dispatcher
— no `deps` injected — so it proves end-to-end .md dispatch):

```js
test('add dispatches a .md file to the markdown parser and stores a null-cover record', async () => {
  const lib = makeLibrary(tmpDir()); // real parseDocument/extractCover
  const rec = await lib.add(Buffer.from('# Title\n\nHello world. Second one.'), 'note.md');
  assert.equal(rec.title, 'Title');
  assert.equal(rec.cover, null);                     // -> title card on the shelf
  const opened = await lib.open(rec.id);
  assert.equal(opened.doc.chapters[0].title, 'Title');
});
```

**Step 3: Run.** `node --test test/unit/library.test.js` → all PASS (existing + new). `npm test` → green.

**Step 4: Commit**

```bash
git add src/main/library.js test/unit/library.test.js
git commit -m "feat(library): dispatch add() by file type (EPUB + Markdown) via parse/index"
```

---

## Task 5: Renderer/main copy + file-picker filters (no tests; UI copy)

**Files:**
- Modify: `src/main/main.js`
- Modify: `src/renderer/index.html`

**Step 1:** In `src/main/main.js`, widen the `pick-file-bytes` dialog (~line 187) to accept Markdown
and relabel it:

```js
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Open a book', properties: ['openFile'],
    filters: [{ name: 'Books', extensions: ['epub', 'md', 'markdown'] }],
  });
```

If a second `showOpenDialog` exists earlier (~line 110, the legacy `pick-and-parse`), update its
`title`/`filters` the same way for consistency (it may be unused now, but keep them aligned).

**Step 2:** In `src/renderer/index.html`, update both empty-state copies:
- `#library-empty` (~line 89): `Drag an EPUB here, or click <strong>Add book</strong>.`
  → `Drag an EPUB or Markdown file here, or click <strong>Add book</strong>.`
- `#empty-state` (~line 99): `Drag an EPUB book here, ...`
  → `Drag an EPUB or Markdown file here, ...`

> No renderer drop-guard needed: an unsupported drop flows `addAndOpen → libraryAdd →
> parseDocument` which **throws "Unsupported file type"**, caught by `addAndOpen`'s existing catch →
> the shelf "Couldn't open that file" card. Confirm that catch path is intact; don't add new code.

**Step 3:** Sanity. `npm test` → still green. Optional manual: `env -u ELECTRON_RUN_AS_NODE npm start`,
drag in a `.md`.

**Step 4: Commit**

```bash
git add src/main/main.js src/renderer/index.html
git commit -m "feat(library): accept .md/.markdown in the picker + drop copy"
```

---

## Task 6: Fixture + smoke flow

**Files:**
- Create: `test/fixtures/sample.md`
- Modify: `test/smoke/launch.smoke.js`

**Step 1:** Create `test/fixtures/sample.md` (heading-first so the first narratable span is `0.0.0`):

```markdown
# Sample Markdown Book

This is the first paragraph. It has two sentences.

# Second Chapter

Here is another paragraph with a [link](http://example.test) and some **bold** text.
```

**Step 2:** Generalize the drop helper in `test/smoke/launch.smoke.js` so it can drop any fixture,
keeping `dropBook(win)` working unchanged. Replace the existing `dropBook` (lines ~30–44) with:

```js
async function dropFile(win, fixturePath, fileName, mime) {
  const b64 = fs.readFileSync(fixturePath).toString('base64');
  await win.evaluate(({ b64, fileName, mime }) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], fileName, { type: mime });
    const dt = new DataTransfer();
    dt.items.add(file);
    window.dispatchEvent(
      new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })
    );
  }, { b64, fileName, mime });
  await win.waitForSelector('#reading span.sentence', { timeout: 20000 });
}

async function dropBook(win) {
  return dropFile(win, FIXTURE, 'alice.epub', 'application/epub+zip');
}
```

**Step 3:** Append a Markdown section at the **very end** of the smoke (after the existing
restart-persistence checks — purely additive, so it can't perturb the earlier sequence):

```js
  // --- Phase 4: Markdown reading -------------------------------------------
  await win.click('#library-btn');
  await win.waitForSelector('body[data-screen="library"]', { timeout: 5000 });
  await dropFile(
    win, path.join(ROOT, 'test', 'fixtures', 'sample.md'), 'sample.md', 'text/markdown'
  );
  await win.waitForSelector('body[data-screen="reader"]', { timeout: 5000 });

  // The first narratable span is the chapter heading itself (0.0.0).
  const mdFirst = await win.evaluate(() => {
    const el = document.querySelector('span.sentence');
    return el ? `${el.dataset.chapter}.${el.dataset.paragraph}.${el.dataset.sentence}` : null;
  });
  assert.strictEqual(mdFirst, '0.0.0', `markdown first span should be 0.0.0, got ${mdFirst}`);

  // Narration advances through the REAL engine (same pattern as the EPUB check).
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
  const mdTile = await win.evaluate(() => {
    const tiles = [...document.querySelectorAll('#shelf-active .book-tile')];
    const t = tiles.find((x) => (x.querySelector('.tile-title')?.textContent || '').includes('Sample'));
    return t ? { card: !!t.querySelector('.cover.title-card'), img: !!t.querySelector('.cover img') } : null;
  });
  assert.ok(mdTile && mdTile.card && !mdTile.img, 'markdown book should show a title-card, not a cover');
  console.log('  ✓ markdown (.md): title-card tile, opens, heading is 0.0.0, narration advances');
```

**Step 4: Run.** `npm run smoke`
Expected: `SMOKE OK` (exit 0) with the new markdown line, **and all prior assertions intact**.

**Step 5: Commit**

```bash
git add test/fixtures/sample.md test/smoke/launch.smoke.js
git commit -m "test(smoke): Markdown reading — title-card add, heading=0.0.0, narration advances"
```

---

## Task 7: Package gate + report (do NOT edit planning docs)

**Step 1:** Full suite green.

Run: `npm test` → all pass (82 prior + markdown 7 + dispatch 5 + library 1 = **95**; note the real
final number).
Run: `npm run smoke` → `SMOKE OK`.

**Step 2:** Build and confirm `marked` + `markdown.js` ship in the asar.

Run: `npm run dist:win`
Run: `npx asar list dist/win-unpacked/resources/app.asar | grep -E "parse/markdown|parse/index|node_modules/marked/"`
Expected: lines for `/src/parse/markdown.js`, `/src/parse/index.js`, and `marked` under
`node_modules` (e.g. `/node_modules/marked/lib/marked.cjs` or similar).

**Step 3:** Launch the packaged app and add the `.md` fixture by hand (or via the packaged-launch
helper) — confirm it appears with a title-card and reads. (Storage path is `userData`, identical
packaged vs dev, but build anyway to catch any `build.files` gap.)

**Step 4: Write your report in chat** (NOT into any doc). Cover: what shipped, the test/smoke/package
numbers, anything about `marked`'s output that needed handling, any deviations, and honest caveats
(e.g. anything only smoke-proven vs human-verified — voice quality on a real draft is ears-only).
The planning session records it into HANDOFF.

---

## Acceptance criteria (check against THIS list, not your restatement)

1. Drag-drop **or** Add imports a `.md`/`.markdown`; it appears on the shelf with a **title-card**
   (no cover image), stored under `userData/library/books/<sha256>/` like any book.
2. Opening reads it aloud with **sentence highlighting**; `#`/top-level headings drive **chapters**
   and are **spoken** (first narratable span is the heading, `0.0.0`).
3. A **no-heading** `.md` reads as **one chapter**.
4. **Resume / finished / remove / persist** work identically to EPUB — with **no new code** in the
   reader/library beyond the dispatcher (same `document.json` shape).
5. **No regression:** the EPUB path and all existing unit tests + smoke stay green; an unsupported
   drop shows the friendly "Couldn't open that file" card (dispatcher throws → existing catch).
6. **Ships in the package:** `marked`, `src/parse/markdown.js`, and `src/parse/index.js` are in the
   asar; `npm run dist:win` succeeds.

## Out of scope (do not build)

DOCX (a later phase); generic generated covers (title cards suffice); Obsidian `[[wikilink]]`/`#tag`/
`![[embed]]` special-casing; pronunciation overrides (still a later Phase 4 item); per-book settings;
the "voice-leads" nav flag; app rename.

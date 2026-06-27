# Phase 3 — Library + Auto-Resume Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan
> task-by-task. Also use superpowers:test-driven-development (tests fail first) and
> superpowers:verification-before-completion (run commands, show output, before any "done").
>
> **STRICT — separation of duties:** You are a *builder*. Do **NOT** edit any planning doc
> (`HANDOFF.md`, `design.md`, anything in `docs/plans/`). When finished, deliver a written report in
> chat; the planning session records it. Make small, frequent commits on a branch.
>
> **Recommended model:** Sonnet 4.6, medium.

**Goal:** Turn the single-book reader into a **library**: a bookshelf home screen where you add EPUBs,
each remembered with its cover and the **exact sentence** you stopped on, reopening right there.

**Architecture:** A new main-process module `src/main/library.js` owns a JSON index + per-book folders
under `userData/library` (copied original + parsed `document.json` + cover). New IPC exposes
list/add/open/remove/updateProgress. The renderer gains a **shelf view** and a top-level shell that
toggles shelf ↔ the existing reader (CSS show/hide — the reader's per-sentence DOM contract,
pagination, and CSS-only `setView` are untouched). Progress is captured at the player's existing
`view.show(addr)` choke point, debounced to disk, and flushed on stop/back/quit.

**Tech Stack:** Electron (main + preload + renderer, all JS), `node:test` unit tests,
Playwright-`_electron` smoke, `jszip`+`cheerio` (existing EPUB parser), `node:crypto` (book id hash).

**Read before starting:**
- [`2026-06-27-phase-3-library-design.md`](./2026-06-27-phase-3-library-design.md) — the validated
  design + the **three robustness requirements** (end-of-book persists `progress === lastAddress`;
  re-add preserves progress; quit-flush avoids the Electron teardown race).
- `src/main/main.js` (IPC + lifecycle), `src/main/clip-cache.js` (the module pattern to mirror),
  `src/main/preload.js` (the bridge), `src/parse/epub.js` (`parseEpub`, `parseOpf`),
  `src/renderer/reading-cursor.js` (address `{ci,pi,si}` helpers), `src/renderer/player.js`
  (`current()`, `onStateChange`, injected `view.show`), `src/renderer/app.js` (the integration file),
  `src/renderer/index.html`.

**Conventions that are NON-NEGOTIABLE (from the codebase):**
- Address shape is **`{ci, pi, si}`** (chapter/paragraph/sentence indices). Use it everywhere.
- The reader's sacred DOM contract: per-sentence `<span class="sentence" data-chapter/-paragraph/-sentence>`;
  `setView()` is CSS-only; one chapter mounted at a time. Don't touch these.
- Dual-mode modules (CommonJS for `node:test` + browser global) like `reading-cursor.js`/`player.js`.
- Cache/IO writes are atomic temp-write+rename and best-effort (see `clip-cache.js`).

---

## Task 0: Branch

**Step 1:** Create the work branch off `master`.

```bash
git checkout master && git pull --ff-only 2>/dev/null; git checkout -b phase-3-library
```

**Step 2:** Confirm a clean baseline.

Run: `npm test`
Expected: **68 pass, 0 fail** (or the current count on master — note it; you must never regress it).

---

## Task 1: `lastAddress(doc)` — the final-sentence address (pure)

The "finished" derivation needs the book's last sentence address. It belongs with the other pure
address helpers, and `library.js` (main) will require it (the module is dual-mode, so `require` works).

**Files:**
- Modify: `src/renderer/reading-cursor.js`
- Test: `test/unit/reading-cursor.test.js` (add cases)

**Step 1: Write the failing test**

Add to `test/unit/reading-cursor.test.js` (match the existing fixture/style in that file):

```js
const { lastAddress, firstAddress } = require('../../src/renderer/reading-cursor');

test('lastAddress points at the final sentence of the final chapter', () => {
  const doc = { chapters: [
    { paragraphs: [ { sentences: ['a', 'b'] } ] },
    { paragraphs: [ { sentences: ['c'] }, { sentences: ['d', 'e', 'f'] } ] },
  ] };
  assert.deepStrictEqual(lastAddress(doc), { ci: 1, pi: 1, si: 2 });
});

test('lastAddress of a one-sentence book equals firstAddress', () => {
  const doc = { chapters: [ { paragraphs: [ { sentences: ['only'] } ] } ] };
  assert.deepStrictEqual(lastAddress(doc), firstAddress(doc));
});

test('lastAddress returns null for an empty doc', () => {
  assert.strictEqual(lastAddress({ chapters: [] }), null);
});
```

**Step 2: Run it, confirm it fails**

Run: `node --test test/unit/reading-cursor.test.js`
Expected: FAIL — `lastAddress is not a function`.

**Step 3: Implement**

Add to `src/renderer/reading-cursor.js` (before the dual-mode export) and **add `lastAddress` to BOTH
export lists** (the `module.exports` object and the `globalThis.ReaderCursor` object):

```js
/**
 * The last sentence of the book (final sentence, final paragraph, final chapter).
 * @param {{chapters:Array}} doc
 * @returns {?{ci:number,pi:number,si:number}} the end address, or null if empty.
 */
function lastAddress(doc) {
  if (!doc || !doc.chapters || doc.chapters.length === 0) return null;
  const ci = doc.chapters.length - 1;
  const paras = doc.chapters[ci].paragraphs;
  const pi = paras.length - 1;
  const si = paras[pi].sentences.length - 1;
  return { ci, pi, si };
}
```

**Step 4: Run, confirm pass**

Run: `node --test test/unit/reading-cursor.test.js` → PASS. Then `npm test` → still all green.

**Step 5: Commit**

```bash
git add src/renderer/reading-cursor.js test/unit/reading-cursor.test.js
git commit -m "feat(cursor): lastAddress() — final-sentence address for finished-detection"
```

---

## Task 2: EPUB cover extraction

Add a `coverImage(buffer)` to the parser returning `{ bytes, ext }` or `null`. EPUB3 marks the cover
image with manifest `properties="cover-image"`; EPUB2 uses `<meta name="cover" content="<itemId>">`
pointing at a manifest item. Reuse `parseOpf`'s manifest walk.

**Files:**
- Modify: `src/parse/epub.js`
- Test: `test/unit/epub.test.js` (add cases; follow its existing inline-XML style)

**Step 1: Write the failing tests** (unit-level, inline OPF — no fixture dependence)

First refactor: have `parseOpf` also return the **cover item id**. Add to the returned object a
`coverId` resolved as: the manifest item whose `properties` includes `cover-image`, else the id named
by `<meta name="cover" content="…">`. Test it:

```js
const { parseOpf } = require('../../src/parse/epub');

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
```

Then an integration test that `coverImage` returns bytes-or-null without throwing on a real fixture:

```js
const fs = require('node:fs');
const path = require('node:path');
const { coverImage } = require('../../src/parse/epub');

test('coverImage returns {bytes,ext} or null for a real EPUB, never throws', async () => {
  const buf = fs.readFileSync(path.join(__dirname, '../fixtures/alice.epub'));
  const cov = await coverImage(buf);
  if (cov !== null) {
    assert.ok(cov.bytes && cov.bytes.length > 0);
    assert.match(cov.ext, /^(jpg|jpeg|png|gif|webp|svg)$/);
  }
});
```

**Step 2: Run, confirm fail.** `node --test test/unit/epub.test.js` → FAIL (`coverId` undefined / `coverImage` not a function).

**Step 3: Implement** in `src/parse/epub.js`.

In `parseOpf`, while walking `manifest item`, also capture each item's id; then resolve the cover id and
include it + return it. Concretely:
- In the `$('manifest item').each(...)` loop, store the id alongside (`byId.set(id, {…, id})`).
- Read the EPUB2 meta: `let metaCover=null; $('metadata').find('*').each((_,el)=>{ if((el.tagName||'').toLowerCase()==='meta' && ($(el).attr('name')||'').toLowerCase()==='cover') metaCover=$(el).attr('content'); });`
- `let coverId=null; for (const [id,item] of byId) { if (/\bcover-image\b/.test(item.properties)) { coverId=id; break; } } if(!coverId && metaCover && byId.has(metaCover)) coverId=metaCover;`
- Add `coverId` to the returned object: `return { title, spine, toc, coverId };`

Add the new exported function:

```js
const EXT_BY_MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' };

/** Extract the cover image bytes from an EPUB buffer, or null if none. */
async function coverImage(buffer) {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const containerFile = zip.file('META-INF/container.xml');
    if (!containerFile) return null;
    const opfPath = findOpfPath(await containerFile.async('string'));
    const opfFile = zip.file(opfPath);
    if (!opfFile) return null;
    const parsed = parseOpf(await opfFile.async('string'), opfPath);
    if (!parsed.coverId) return null;
    // re-walk the manifest to map the cover id -> {href, mediaType}
    const $ = cheerio.load(await opfFile.async('string'), { xmlMode: true });
    const opfDir = dirOf(opfPath);
    let href = null, mime = '';
    $('manifest item').each((_, el) => {
      if ($(el).attr('id') === parsed.coverId) {
        href = resolveHref($(el).attr('href') || '', opfDir);
        mime = $(el).attr('media-type') || '';
      }
    });
    if (!href) return null;
    const f = zip.file(href);
    if (!f) return null;
    const bytes = await f.async('nodebuffer');
    const ext = EXT_BY_MIME[mime] || (href.split('.').pop() || 'img').toLowerCase();
    return { bytes, ext };
  } catch { return null; } // a missing/odd cover must never break add
}
```

Add `coverImage` to `module.exports`.

**Step 4: Run, confirm pass.** `node --test test/unit/epub.test.js` → PASS. `npm test` → all green.

**Step 5: Commit**

```bash
git add src/parse/epub.js test/unit/epub.test.js
git commit -m "feat(parse): coverImage() + parseOpf coverId (EPUB3 properties + EPUB2 meta)"
```

---

## Task 3: `src/main/library.js` — the index + book store (core logic, heavily tested)

This is the heart of Phase 3. It owns `userData/library/index.json` and `userData/library/books/<id>/`.
All decisions live here so they're unit-testable: idempotent-by-hash **preserving progress**, the
**reopen-finished-restarts** reset, and the active/finished split.

**Files:**
- Create: `src/main/library.js`
- Test: `test/unit/library.test.js`

**Step 1: Write failing tests** (`test/unit/library.test.js`). Use a fresh tmp dir per test and inject
fakes for `parse` + `cover` so the tests don't depend on real EPUB bytes:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeLibrary, isFinished, splitShelf } = require('../../src/main/library');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'reader-lib-')); }

// Fake parse/cover deps: a 2-chapter doc, lastAddress = {1,0,0}; no cover.
const fakeDoc = { title: 'Test Book', chapters: [
  { paragraphs: [ { sentences: ['a', 'b'] } ] },
  { paragraphs: [ { sentences: ['c'] } ] },
] };
const deps = { parse: async () => fakeDoc, cover: async () => null };

test('add stores a record with lastAddress and null progress', async () => {
  const lib = makeLibrary(tmpDir(), deps);
  const rec = await lib.add(Buffer.from('EPUBBYTES-1'), 'book.epub');
  assert.equal(rec.title, 'Test Book');
  assert.deepEqual(rec.lastAddress, { ci: 1, pi: 0, si: 0 });
  assert.equal(rec.progress, null);
  assert.equal((await lib.list()).length, 1);
});

test('add is idempotent by content hash AND preserves progress on re-add', async () => {
  const lib = makeLibrary(tmpDir(), deps);
  const bytes = Buffer.from('SAME-BYTES');
  const rec = await lib.add(bytes, 'book.epub');
  await lib.updateProgress(rec.id, { ci: 0, pi: 0, si: 1 });
  const again = await lib.add(bytes, 'book.epub'); // re-drop a half-read book
  assert.equal((await lib.list()).length, 1, 'no duplicate tile');
  assert.deepEqual(again.progress, { ci: 0, pi: 0, si: 1 }, 'progress survives re-add');
});

test('open returns the doc + progress and bumps lastOpenedAt', async () => {
  const lib = makeLibrary(tmpDir(), deps);
  const rec = await lib.add(Buffer.from('B'), 'b.epub');
  await lib.updateProgress(rec.id, { ci: 0, pi: 0, si: 1 });
  const opened = await lib.open(rec.id);
  assert.deepEqual(opened.doc, fakeDoc);
  assert.deepEqual(opened.progress, { ci: 0, pi: 0, si: 1 });
});

test('opening a FINISHED book resets progress to null (restart from beginning)', async () => {
  const lib = makeLibrary(tmpDir(), deps);
  const rec = await lib.add(Buffer.from('B'), 'b.epub');
  await lib.updateProgress(rec.id, rec.lastAddress); // mark finished
  assert.equal(isFinished(await getRec(lib, rec.id)), true);
  const opened = await lib.open(rec.id);
  assert.equal(opened.progress, null, 'finished reopen starts at the beginning');
  assert.equal(isFinished(await getRec(lib, rec.id)), false, 'back to active');
});

test('remove deletes the record (and its folder)', async () => {
  const lib = makeLibrary(tmpDir(), deps);
  const rec = await lib.add(Buffer.from('B'), 'b.epub');
  await lib.remove(rec.id);
  assert.equal((await lib.list()).length, 0);
});

test('isFinished: progress deep-equals lastAddress', () => {
  assert.equal(isFinished({ progress: { ci: 1, pi: 0, si: 0 }, lastAddress: { ci: 1, pi: 0, si: 0 } }), true);
  assert.equal(isFinished({ progress: { ci: 0, pi: 0, si: 0 }, lastAddress: { ci: 1, pi: 0, si: 0 } }), false);
  assert.equal(isFinished({ progress: null, lastAddress: { ci: 1, pi: 0, si: 0 } }), false);
});

test('splitShelf: active (unfinished) by lastOpened desc, finished separate', () => {
  const recs = [
    { id: 'a', lastOpenedAt: 10, progress: null, lastAddress: { ci: 0, pi: 0, si: 1 } },
    { id: 'b', lastOpenedAt: 30, progress: { ci: 0, pi: 0, si: 1 }, lastAddress: { ci: 0, pi: 0, si: 1 } }, // finished
    { id: 'c', lastOpenedAt: 20, progress: { ci: 0, pi: 0, si: 0 }, lastAddress: { ci: 0, pi: 0, si: 1 } },
  ];
  const { active, finished } = splitShelf(recs);
  assert.deepEqual(active.map(r => r.id), ['c', 'a']); // 20 then 10
  assert.deepEqual(finished.map(r => r.id), ['b']);
});

// helper: read one record back via list()
async function getRec(lib, id) { return (await lib.list()).find(r => r.id === id); }
```

**Step 2: Run, confirm fail.** `node --test test/unit/library.test.js` → FAIL (module not found).

**Step 3: Implement `src/main/library.js`:**

```js
'use strict';
// The library index + per-book store. Lives under <base>/ (caller passes userData/library).
//   <base>/index.json                  -> { books: [ record, ... ] }
//   <base>/books/<id>/original.epub     copied source
//   <base>/books/<id>/document.json     parsed Document (instant reopen)
//   <base>/books/<id>/cover.<ext>       extracted cover (absent => render a title card)
// Decisions live here so they're unit-testable: idempotent-by-hash preserves progress;
// opening a finished book resets progress (restart); active/finished split is derived.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const fssync = require('node:fs');
const path = require('node:path');
const { parseEpub, coverImage } = require('../parse/epub');
const { lastAddress } = require('../renderer/reading-cursor'); // dual-mode require

function eqAddr(a, b) {
  return !!a && !!b && a.ci === b.ci && a.pi === b.pi && a.si === b.si;
}
function isFinished(rec) { return eqAddr(rec.progress, rec.lastAddress); }
function splitShelf(records) {
  const byRecent = (x, y) => (y.lastOpenedAt || 0) - (x.lastOpenedAt || 0);
  const active = records.filter((r) => !isFinished(r)).sort(byRecent);
  const finished = records.filter(isFinished).sort(byRecent);
  return { active, finished };
}

// `deps` lets tests inject fakes: { parse(buffer)->doc, cover(buffer)->{bytes,ext}|null }
function makeLibrary(base, deps = {}) {
  const parse = deps.parse || parseEpub;
  const cover = deps.cover || coverImage;
  const indexPath = path.join(base, 'index.json');
  const bookDir = (id) => path.join(base, 'books', id);

  async function readIndex() {
    try { return JSON.parse(await fs.readFile(indexPath, 'utf8')); }
    catch { return { books: [] }; }
  }
  async function writeIndex(idx) {
    await fs.mkdir(base, { recursive: true });
    const tmp = `${indexPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(idx, null, 2), 'utf8');
    await fs.rename(tmp, indexPath);
  }

  async function list() { return (await readIndex()).books; }

  async function add(buffer, fileName) {
    const id = crypto.createHash('sha256').update(buffer).digest('hex');
    const idx = await readIndex();
    const existing = idx.books.find((b) => b.id === id);
    if (existing) {                      // idempotent: refresh recency, KEEP progress
      existing.lastOpenedAt = Date.now();
      await writeIndex(idx);
      return existing;
    }
    const doc = await parse(buffer);
    const dir = bookDir(id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'original.epub'), buffer);
    await fs.writeFile(path.join(dir, 'document.json'), JSON.stringify(doc), 'utf8');
    let coverName = null;
    const cov = await cover(buffer);
    if (cov && cov.bytes && cov.bytes.length) {
      coverName = `cover.${cov.ext}`;
      await fs.writeFile(path.join(dir, coverName), Buffer.from(cov.bytes));
    }
    const rec = {
      id, title: doc.title || fileName || 'Untitled', author: doc.author || null,
      fileName: fileName || null, addedAt: Date.now(), lastOpenedAt: Date.now(),
      cover: coverName, lastAddress: lastAddress(doc), progress: null,
    };
    idx.books.push(rec);
    await writeIndex(idx);
    return rec;
  }

  async function open(id) {
    const idx = await readIndex();
    const rec = idx.books.find((b) => b.id === id);
    if (!rec) return null;
    if (isFinished(rec)) rec.progress = null; // reopen finished => restart from beginning
    rec.lastOpenedAt = Date.now();
    await writeIndex(idx);
    const doc = JSON.parse(await fs.readFile(path.join(bookDir(id), 'document.json'), 'utf8'));
    return { doc, progress: rec.progress, record: rec };
  }

  async function updateProgress(id, addr) {
    const idx = await readIndex();
    const rec = idx.books.find((b) => b.id === id);
    if (!rec) return false;
    rec.progress = addr;
    await writeIndex(idx);
    return true;
  }

  // Synchronous flush for the renderer 'beforeunload' path (see Task 7). Avoids the
  // before-quit async-write race: writes index.json with the latest address before exit.
  function updateProgressSync(id, addr) {
    try {
      let idx; try { idx = JSON.parse(fssync.readFileSync(indexPath, 'utf8')); } catch { return false; }
      const rec = idx.books.find((b) => b.id === id);
      if (!rec) return false;
      rec.progress = addr;
      fssync.writeFileSync(indexPath, JSON.stringify(idx, null, 2), 'utf8');
      return true;
    } catch { return false; }
  }

  async function remove(id) {
    const idx = await readIndex();
    idx.books = idx.books.filter((b) => b.id !== id);
    await writeIndex(idx);
    await fs.rm(bookDir(id), { recursive: true, force: true });
    return true;
  }

  return { list, add, open, updateProgress, updateProgressSync, remove };
}

module.exports = { makeLibrary, isFinished, splitShelf, eqAddr };
```

**Step 4: Run, confirm pass.** `node --test test/unit/library.test.js` → all PASS. `npm test` → green.

**Step 5: Commit**

```bash
git add src/main/library.js test/unit/library.test.js
git commit -m "feat(library): index + book store (idempotent-by-hash, finished-reset, shelf split)"
```

---

## Task 4: Wire library IPC (main + preload)

**Files:**
- Modify: `src/main/main.js`
- Modify: `src/main/preload.js`

**Step 1:** In `src/main/main.js`, require the module and lazily build the library (mirror `clipCache`):

```js
const { makeLibrary } = require('./library');
let library = null;
function getLibrary() {
  return (library ||= makeLibrary(path.join(app.getPath('userData'), 'library')));
}
```

**Step 2:** Add IPC handlers (near the other `ipcMain.handle` calls). `cover` paths must be readable by
the renderer under CSP `img-src 'self' data:` — return the cover as a **`data:` URL** so no custom
protocol is needed:

```js
const fssync = require('node:fs');

ipcMain.handle('library:list', async () => getLibrary().list());

// The shelf, pre-split into active/finished by the TESTED splitShelf (so the UI renders the
// same logic the unit tests cover, instead of re-deriving the split in the renderer).
ipcMain.handle('library:shelf', async () => {
  const { splitShelf } = require('./library');
  return splitShelf(await getLibrary().list());
});

ipcMain.handle('library:add', async (_evt, bytes, fileName) => {
  return getLibrary().add(Buffer.from(bytes), fileName);
});

ipcMain.handle('library:open', async (_evt, id) => getLibrary().open(id));

ipcMain.handle('library:remove', async (_evt, id) => getLibrary().remove(id));

ipcMain.handle('library:updateProgress', async (_evt, id, addr) =>
  getLibrary().updateProgress(id, addr));

// Cover bytes as a data: URL (CSP-safe under img-src 'self' data:). null if no cover.
ipcMain.handle('library:coverDataUrl', async (_evt, id, coverName) => {
  if (!coverName) return null;
  try {
    const p = path.join(app.getPath('userData'), 'library', 'books', id, coverName);
    const bytes = await fs.readFile(p);
    const mime = coverName.endsWith('.png') ? 'image/png'
      : coverName.endsWith('.svg') ? 'image/svg+xml'
      : coverName.endsWith('.gif') ? 'image/gif'
      : coverName.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
    return `data:${mime};base64,${bytes.toString('base64')}`;
  } catch { return null; }
});

// Synchronous progress flush for renderer 'beforeunload' (quit-flush race fix).
ipcMain.on('library:updateProgressSync', (evt, id, addr) => {
  evt.returnValue = getLibrary().updateProgressSync(id, addr);
});
```

**Step 3:** In `src/main/preload.js`, extend the `reader` bridge:

```js
  // Library (Phase 3)
  libraryList: () => ipcRenderer.invoke('library:list'),
  libraryShelf: () => ipcRenderer.invoke('library:shelf'),
  libraryAdd: (bytes, fileName) => ipcRenderer.invoke('library:add', bytes, fileName),
  libraryOpen: (id) => ipcRenderer.invoke('library:open', id),
  libraryRemove: (id) => ipcRenderer.invoke('library:remove', id),
  libraryUpdateProgress: (id, addr) => ipcRenderer.invoke('library:updateProgress', id, addr),
  libraryCoverDataUrl: (id, coverName) => ipcRenderer.invoke('library:coverDataUrl', id, coverName),
  libraryUpdateProgressSync: (id, addr) => ipcRenderer.sendSync('library:updateProgressSync', id, addr),
```

**Step 4: Verify it loads** (no unit test for IPC; the smoke in Task 8 is the gate). Quick sanity:

Run: `node -e "require('./src/main/library'); console.log('library module loads')"`
Expected: `library module loads` (and `npm test` still green).

**Step 5: Commit**

```bash
git add src/main/main.js src/main/preload.js
git commit -m "feat(library): IPC — list/add/open/remove/updateProgress(+Sync)/coverDataUrl"
```

---

## Task 5: The shelf view (HTML + renderer module + styles)

A new top-level view that shows the bookshelf. The existing reader markup stays; we add a shell that
shows exactly one of `#library-view` / the reader at a time.

**Files:**
- Modify: `src/renderer/index.html`
- Create: `src/renderer/library-view.js`
- Modify: `src/renderer/styles.css`

**Step 1 (HTML):** In `index.html`, add a library view as the first child of `<main id="stage">`
(before `#empty-state`):

```html
      <section id="library-view">
        <header class="library-head"><h1>Your library</h1></header>
        <div id="library-empty" class="empty-card" hidden>
          <h1>No books yet</h1>
          <p>Drag an EPUB here, or click <strong>Add book</strong>.</p>
        </div>
        <h2 class="shelf-title" id="active-title" hidden>Reading</h2>
        <div class="shelf" id="shelf-active"></div>
        <h2 class="shelf-title" id="finished-title" hidden>Finished</h2>
        <div class="shelf" id="shelf-finished"></div>
      </section>
```

Add a **"← Library"** button to the reader top bar — put it first inside `<nav class="controls">`:

```html
        <button type="button" id="library-btn" aria-label="Back to library" title="Back to library">← Library</button>
```

Add `data-screen="library"` to `<body>` (default screen is the shelf) and load the new script before
`app.js`:

```html
    <script src="library-view.js"></script>
```
(place it just above `<script src="app.js"></script>`)

**Step 2 (renderer module):** Create `src/renderer/library-view.js`. It renders tiles and exposes a
small API; `app.js` (Task 6) injects the open/remove/add callbacks so this file stays DOM-only.

```js
'use strict';
// Bookshelf view: renders cover tiles into the active + finished shelves, with a
// title-card fallback for cover-less books. DOM-only; app.js injects the callbacks.
(function () {
  const view = document.getElementById('library-view');
  const emptyEl = document.getElementById('library-empty');
  const activeShelf = document.getElementById('shelf-active');
  const finishedShelf = document.getElementById('shelf-finished');
  const activeTitle = document.getElementById('active-title');
  const finishedTitle = document.getElementById('finished-title');

  // NOTE: the active/finished split is computed in main (library.js splitShelf, unit-tested) and
  // passed in pre-split — do NOT re-derive it here, so the shipped split == the tested split.

  // Deterministic calm color from the title (for the title-card fallback).
  function colorFor(str) {
    let h = 0; for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return `hsl(${h % 360} 35% 42%)`;
  }

  async function tile(rec, cbs) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'book-tile';
    el.dataset.id = rec.id;
    const art = document.createElement('div');
    art.className = 'cover';
    const url = rec.cover ? await window.reader.libraryCoverDataUrl(rec.id, rec.cover) : null;
    if (url) {
      const img = document.createElement('img'); img.src = url; img.alt = '';
      art.appendChild(img);
    } else {
      art.classList.add('title-card');
      art.style.background = colorFor(rec.title);
      const t = document.createElement('span'); t.textContent = rec.title; art.appendChild(t);
    }
    const cap = document.createElement('div'); cap.className = 'tile-title'; cap.textContent = rec.title;
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'tile-remove'; del.title = 'Remove from library';
    del.setAttribute('aria-label', `Remove ${rec.title}`); del.textContent = '×';
    del.addEventListener('click', (e) => { e.stopPropagation(); cbs.onRemove(rec); });
    el.addEventListener('click', () => cbs.onOpen(rec));
    el.append(art, cap, del);
    return el;
  }

  // active + finished arrive PRE-SPLIT from main (library.js splitShelf, the tested logic).
  async function render(active, finished, cbs) {
    activeShelf.innerHTML = ''; finishedShelf.innerHTML = '';
    const total = active.length + finished.length;
    emptyEl.hidden = total > 0;
    activeTitle.hidden = active.length === 0;
    finishedTitle.hidden = finished.length === 0;
    for (const r of active) activeShelf.appendChild(await tile(r, cbs));
    for (const r of finished) finishedShelf.appendChild(await tile(r, cbs));
  }

  function show() { document.body.dataset.screen = 'library'; }
  function hide() { document.body.dataset.screen = 'reader'; }

  globalThis.ReaderLibrary = { render, show, hide, view };
})();
```

**Step 3 (CSS):** In `styles.css`, add screen-toggling + shelf styles. The shell rule is the important
part — it must hide the reader chrome on the library screen and vice-versa:

```css
/* Screen toggle: library vs reader. Library is the home screen. */
body[data-screen="library"] #reading-viewport,
body[data-screen="library"] #bottom-bar,
body[data-screen="library"] #empty-state { display: none !important; }
body[data-screen="library"] #toc-btn,
body[data-screen="library"] #view-toggle,
body[data-screen="library"] #voice-btn,
body[data-screen="library"] #library-btn { display: none; } /* shelf needs only Add + Aa */
body[data-screen="reader"]   #library-view { display: none; }

#library-view { padding: 24px 32px; overflow: auto; height: 100%; }
.shelf { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 20px; }
.shelf-title { margin: 24px 4px 8px; font-size: 0.95rem; opacity: 0.7; }
.book-tile { display: flex; flex-direction: column; gap: 8px; background: none; border: 0; cursor: pointer; padding: 0; position: relative; text-align: left; }
.book-tile .cover { aspect-ratio: 2/3; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 10px rgba(0,0,0,.18); background: #ccc; }
.book-tile .cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.cover.title-card { display: flex; align-items: center; justify-content: center; padding: 12px; }
.cover.title-card span { color: #fff; font-size: 1.05rem; line-height: 1.25; text-align: center; }
.tile-title { font-size: 0.9rem; line-height: 1.2; }
.tile-remove { position: absolute; top: 6px; right: 6px; width: 26px; height: 26px; border-radius: 50%; border: 0; background: rgba(0,0,0,.55); color: #fff; font-size: 18px; line-height: 1; cursor: pointer; opacity: 0; transition: opacity .12s; }
.book-tile:hover .tile-remove, .tile-remove:focus { opacity: 1; }
```

> Note: `#empty-state` is now superseded by `#library-empty` for the no-books case; the old reader
> empty-state stays for the error path (`reportError`). Keep both.

**Step 4:** No unit test (DOM). Sanity: `npm test` still green; the smoke (Task 8) exercises it.

**Step 5: Commit**

```bash
git add src/renderer/index.html src/renderer/library-view.js src/renderer/styles.css
git commit -m "feat(library): bookshelf view — cover tiles, title-card fallback, active/finished shelves"
```

---

## Task 6: Wire the shell — shelf is home, add→store→open, ← Library

Now connect the shelf to the reader in `app.js`. The add path (drag-drop + Add button) is rerouted
through the library; opening mounts the stored document.

**Files:**
- Modify: `src/renderer/app.js`

**Step 1: Add library state + an opener.** Near `state` (app.js:21), add:

```js
state.currentBookId = null; // the open book's library id (for progress saves)
```

Add a function to (re)render and show the shelf:

```js
async function showLibrary() {
  if (state.player) state.player.pause();
  flushProgress();                 // persist where we were (Task 7)
  state.currentBookId = null;
  // Use the IPC that returns the TESTED split (active/finished) — don't re-derive in the UI.
  const { active, finished } = await window.reader.libraryShelf();
  await ReaderLibrary.render(active, finished, { onOpen: openFromLibrary, onRemove: removeFromLibrary });
  ReaderLibrary.show();
}

async function openFromLibrary(rec) {
  const { doc, progress } = await window.reader.libraryOpen(rec.id);
  state.currentBookId = rec.id;
  ReaderLibrary.hide();
  showDocument(doc, rec.fileName);                 // existing reader bootstrap (builds the player)
  const start = progress || ReaderCursor.firstAddress(doc);
  if (start && state.player) {
    state.player.showAt(start);                    // position + highlight, paused (no auto-play)
    // RESUME-PAGE ACCURACY (paged modes): goToPageContaining reads el.offsetLeft, which is wrong
    // until fonts/layout settle on a fresh open. Re-resolve the page once metrics are real.
    if (document.fonts && document.fonts.ready) {
      try { await document.fonts.ready; } catch (_) {}
      state.player.showAt(start);                  // re-flip to the correct page with real metrics
    }
  }
}

async function removeFromLibrary(rec) {
  if (!window.confirm(`Remove “${rec.title}” from your library?`)) return;
  await window.reader.libraryRemove(rec.id);
  await showLibrary();
}
```

> **Add-error visibility (shelf):** `reportError` un-hides `#empty-state`, but the screen CSS hides
> `#empty-state` while `data-screen="library"`. So a failed import *from the shelf* would show nothing.
> In `addAndOpen`'s catch, surface the error on the shelf instead — simplest: set `#library-empty`'s
> text to a "Couldn't open that file" message and ensure it's visible, or a `window.alert`. Don't rely
> on `reportError` alone for the shelf path.

> **Seeking to the saved sentence without auto-playing:** the player exposes `jumpTo` (which *plays*)
> and `seekTo` is internal. Add a tiny public method to `player.js` for "position here, paused":
> in the returned object add `showAt: (a) => seekTo(a)` (seekTo already re-shows when paused and
> replays when playing — and we call it while paused, so it just highlights + flips to the sentence).
> `openFromLibrary` (above) already calls `state.player.showAt(start)`.

Make that `player.js` change now (one line in the returned object of `createPlayer`):

```js
    showAt: (a) => seekTo(a), // position + highlight at an address without auto-playing
```
Add a unit test in `test/unit/player.test.js` asserting `showAt` sets `current()` and calls
`view.show` without setting `isPlaying()` true (mirror the existing fake-deps player tests).

**Step 2: Reroute add + drop through the library.** Replace the body of the Add button handler
(app.js:331) and the `drop` handler (app.js:356) so they call `library:add` then open:

```js
// Add button
document.getElementById('add-btn').addEventListener('click', async () => {
  try {
    const picked = await window.reader.pickAndParse(); // still used only to get bytes? -> see note
  } catch (err) { reportError(err); }
});
```

> **Important:** `pick-and-parse` returns a parsed doc, not raw bytes, so it can't feed `library:add`
> (which hashes bytes). Two clean options — pick ONE and note it in your report:
> (a) Add a new `pick-file-bytes` IPC that returns `{ bytes, fileName }` (native dialog → `fs.readFile`
>     → return bytes), and route both Add + drop through `library:add`. **Recommended** (one add path).
> (b) Keep `pick-and-parse` for the button but also persist: have the renderer get bytes via the drop
>     path only, and for the button add the new bytes IPC. (a) is simpler; do (a).

Implement (a): in `main.js` add

```js
ipcMain.handle('pick-file-bytes', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Open an EPUB', properties: ['openFile'],
    filters: [{ name: 'EPUB books', extensions: ['epub'] }],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const fp = res.filePaths[0];
  return { bytes: await fs.readFile(fp), fileName: path.basename(fp) };
});
```
and in preload add `pickFileBytes: () => ipcRenderer.invoke('pick-file-bytes')`.

Then the handlers become:

```js
async function addAndOpen(bytes, fileName) {
  try {
    const rec = await window.reader.libraryAdd(bytes, fileName);
    await openFromLibrary(rec);
  } catch (err) { reportError(err); }
}

document.getElementById('add-btn').addEventListener('click', async () => {
  const picked = await window.reader.pickFileBytes();
  if (picked) addAndOpen(new Uint8Array(picked.bytes), picked.fileName);
});
```

And in the `drop` handler, replace the parse+show block with:

```js
  const buf = await file.arrayBuffer();
  addAndOpen(new Uint8Array(buf), file.name);
```

**Step 3: Wire the ← Library button + boot to the shelf.** Add near the other control wiring:

```js
document.getElementById('library-btn').addEventListener('click', showLibrary);
```

At the **boot** section (app.js:811-814), after `loadSettings();`, show the library as the home screen:

```js
showLibrary(); // shelf is home (design §6 / Phase 3)
```

Set the initial body screen so nothing flashes: in `index.html` you already set
`data-screen="library"` on `<body>`. Good.

**Step 4:** `npm test` green; full flow is covered by the smoke (Task 8). Do a manual
`npm start` smoke if convenient (env note: `env -u ELECTRON_RUN_AS_NODE npm start`).

**Step 5: Commit**

```bash
git add src/renderer/app.js src/renderer/player.js src/main/main.js src/main/preload.js test/unit/player.test.js
git commit -m "feat(library): shelf-as-home wiring — add→store→open, ← Library, showAt() seek"
```

---

## Task 7: Auto-resume — capture, debounce, flush, restore

Progress is captured at the player's existing `view.show(addr)` choke point (called on every sentence
change — play advance, jump, back/forward, paused seek). We debounce writes and flush on stop / back /
quit.

**Files:**
- Modify: `src/renderer/app.js`

**Step 1: Capture + debounce.** In `ReaderView.show(addr)` (app.js:735), after the existing body, record
progress:

```js
const ReaderView = {
  show(addr) {
    const { ci, pi, si } = addr;
    if (ci !== state.ci) goToChapter(ci);
    const el = highlightSentence(ci, pi, si);
    recordProgress(addr);            // <-- NEW
    if (!el) return;
    if (currentView() === 'continuous') scrollSentenceThreeQuarters(el);
    else goToPageContaining(el);
  },
};
```

Add the debounced recorder + flush:

```js
let progressTimer = null;
let pendingAddr = null;
function recordProgress(addr) {
  if (!state.currentBookId) return;
  pendingAddr = addr;
  clearTimeout(progressTimer);
  progressTimer = setTimeout(flushProgress, 1500); // debounce disk writes
}
function flushProgress() {
  clearTimeout(progressTimer);
  if (!state.currentBookId || !pendingAddr) return;
  window.reader.libraryUpdateProgress(state.currentBookId, pendingAddr)
    .catch((e) => console.warn('[Reader] progress save failed:', e));
}
```

**Step 2: Flush on stop.** The player calls `onStateChange` on every play/pause transition, including
the **auto-stop at book end** (where `current()` is the last sentence → `progress === lastAddress` →
the book becomes "finished"). Extend the existing `updatePlayButton` handler so a transition to *not
playing* flushes:

```js
function updatePlayButton() {
  const btn = document.getElementById('play-pause');
  const on = !!(state.player && state.player.isPlaying());
  btn.classList.toggle('is-playing', on);
  btn.setAttribute('aria-label', on ? 'Pause' : 'Play');
  if (!on) flushProgress();   // <-- NEW: pause / book-end persist immediately
}
```

> This satisfies robustness requirement #1: when the last sentence starts, `view.show(lastAddress)`
> records it; when it ends the player flips to not-playing → `flushProgress()` writes
> `progress = lastAddress` → finished. (`recordProgress` already cancels the pending debounce by
> reassigning `pendingAddr`; `flushProgress` clears the timer, so the end-state write always wins.)

**Step 3: Flush on quit (the Electron race).** A debounced write can be in flight when the window
closes. Use a synchronous IPC on `beforeunload`:

```js
window.addEventListener('beforeunload', () => {
  if (state.currentBookId && pendingAddr) {
    try { window.reader.libraryUpdateProgressSync(state.currentBookId, pendingAddr); } catch (_) {}
  }
});
```

(`showLibrary()` from Task 6 already calls `flushProgress()` before leaving a book — back-to-library
is covered.)

**Step 4: Restore on open.** Already handled in Task 6 `openFromLibrary` via `player.showAt(start)`.
Confirm the order: `showDocument()` builds the player, THEN `showAt(progress || firstAddress)`. Verify
the highlighted sentence + correct page show on open (smoke, Task 8).

**Step 5: Commit**

```bash
git add src/renderer/app.js
git commit -m "feat(library): auto-resume — capture at view.show, debounce, flush on stop/back/quit"
```

---

## Task 8: End-to-end smoke test

Extend the Playwright-Electron smoke to drive the whole library loop against the **real** engine and an
isolated `--user-data-dir`, including a restart to prove persistence.

**Files:**
- Modify: `test/smoke/launch.smoke.js`

**Step 1: Write the smoke assertions.** Follow the existing file's launch/helper patterns (isolated
user-data-dir, `_electron.launch`, the `env` strip of `ELECTRON_RUN_AS_NODE`). Add a flow that:

1. App opens on the **library** screen (`body[data-screen="library"]`), empty state visible.
2. Drag-drop `test/fixtures/alice.epub` (reuse the existing synthetic drop helper) → a tile appears in
   `#shelf-active` with a cover or title-card.
3. Click the tile → reader shows (`body[data-screen="reader"]`), first sentence highlighted.
4. Press Play → narration advances (assert `.is-reading` moves, like the current smoke).
5. Click **← Library** → back on the shelf.
6. Reopen the tile → assert the highlighted sentence is **the advanced one, not 0.0.0** (resume works).
   **AND verify the resume landed on the right PAGE, not just highlighted the right span** — in
   single/two-page mode the highlight is set regardless of which page is showing, so an attribute-only
   check false-greens a broken resume. Assert one of: the `.is-reading` span is actually in the
   viewport (`getBoundingClientRect` within `#reading-viewport`), or the `#orientation` "Page N/M"
   matches the highlighted span's page. Do this check in a **paged** view (set `data-view="single"`),
   not just scroll mode.
7. Remove the book (the `×`, accept the confirm via `page.on('dialog')`) → shelf empty.
8. Re-add, advance to the **last** sentence (use the existing forward controls / `showAt` path or just
   assert the finished-section logic with a tiny book), confirm it lands in `#shelf-finished`.
   *(If driving to true book-end is slow, assert the finished split with a short fixture or by calling
   `libraryUpdateProgress(id, lastAddress)` via `page.evaluate(window.reader...)`, then re-render.)*
9. Relaunch with the **same** user-data-dir → the book is still on the shelf with its progress.

Keep the existing Phase 2/2.5/2.6 smoke assertions intact (don't regress them).

**Step 2: Run.** `npm run smoke`
Expected: `SMOKE OK` (exit 0) with the new library assertions printed.

**Step 3: Commit**

```bash
git add test/smoke/launch.smoke.js
git commit -m "test(smoke): library loop — add, open, resume, remove, finished, persist across restart"
```

---

## Task 9: Package gate + report (do NOT edit planning docs)

**Step 1:** Full suite green.

Run: `npm test` → all pass (68 prior + new: cursor, epub cover, library, player.showAt).
Run: `npm run smoke` → `SMOKE OK`.

**Step 2:** Build the packaged app and confirm it launches + the library persists in the package
(the storage path is `userData`, which is identical packaged vs dev, but build anyway to catch any
`build.files` gap — `library-view.js` must ship):

Run: `npm run dist:win`
Then launch `dist/win-unpacked/Reader.exe` (Playwright or by hand), add a book, confirm the shelf.

**Step 3:** Verify `library-view.js` is in the asar (it must be packaged):

Run: `npx asar list dist/win-unpacked/resources/app.asar | grep library-view`
Expected: `/src/renderer/library-view.js`

**Step 4: Write your report in chat** (NOT into any doc). Cover: what shipped, the test/smoke/package
results (with numbers), the `pick-and-parse` → `pick-file-bytes` decision, any deviations, and honest
caveats (e.g. anything only smoke-proven vs human-verified). The planning session records it into
HANDOFF.

---

## Acceptance criteria (check against THIS list, not your restatement)

1. App opens to a **bookshelf**; first run shows the drop/Add empty state.
2. Drag-drop **or** Add button imports an EPUB: original + `document.json` + cover stored under
   `userData/library/books/<sha256>/`; **re-adding the same file makes no duplicate and preserves
   progress**.
3. Tiles show the **EPUB cover**, or a **title-card** fallback; click opens the reader at the saved
   sentence (or sentence 1 if new).
4. Reading **persists the exact sentence**, surviving back-to-library, app quit (sync flush), and a
   relaunch. Reaching the **end** moves the book to a **Finished** section (`progress === lastAddress`).
5. Opening a **finished** book **restarts from the beginning** (and it returns to the active shelf).
6. A clear **remove** control deletes a book (folder + index entry); global clips are untouched.
7. **No regression:** the Phase 2/2.5/2.6 reader (voice, highlight, pagination, popovers, headings)
   works unchanged; `npm test` + `npm run smoke` green; `library-view.js` ships in the package.

## Out of scope (do not build)

MD/DOCX + a generic generated-cover system (Phase 4); per-book comfort/voice/speed; pronunciation
(Phase 4); the "voice-leads" nav flag; app rename.

# DOCX Reading — Design (Phase 4, part 2)

**Date:** 2026-06-28
**Status:** Designed & approved (brainstormed with the user). Ready for a builder plan.
**Depends on:** Phase 4 part 1 (Markdown reading) — merged. Reuses its format dispatcher,
`htmlToBlocks`, and the `{heading?, sentences}` chapter model.

---

## Goal

Let the user drop a `.docx` Word document onto the shelf and listen to it with the **same**
chapters / headings / highlight / resume / finished / remove as an EPUB or Markdown file —
via the existing reader, with **zero new reader logic**.

This is one of the two logged Phase 4 items (the other, pronunciation overrides, stays
deferred). DOCX is the natural next format because the user writes drafts in Word.

---

## Why this is small

The reader, IPC, and on-disk `document.json` already speak one normalized contract:

```
Document { title, chapters: [ { title, paragraphs: [ { heading?, sentences:[] } ] } ] }
```

Markdown (part 1) proved that **any** format that can produce this shape inherits
resume / finished / remove / highlight / persistence for free. DOCX is the same trick with a
different front-end converter:

```
format → HTML → htmlToBlocks → {heading?, sentences} chapters
```

EPUB and Markdown both already run this path. DOCX adds a third entry point.

---

## Architecture

### Converter: `mammoth` (decided)

`mammoth` is the standard **pure-JS** `.docx → HTML` converter — consistent with the project's
no-native-modules stance (`jszip`, `cheerio`, `marked` are all pure JS; `onnxruntime-node` is
the lone native piece and stays that way). mammoth maps Word's built-in **Heading 1–6 styles**
to `<h1>–<h6>` and paragraphs to `<p>`, which is exactly what the heading-aware chapter split
consumes.

- **Only `.docx`** (OOXML). The old binary `.doc` is **not** supported — the dispatcher throws
  `Unsupported file type` → the existing "Couldn't open that file" card. Do not claim `.doc`.
- mammoth returns `{ value: html, messages }`; read `.value`, ignore `.messages` (style-map
  warnings, not errors).

### New file: `src/parse/docx.js`

```js
parseDocx(buffer, fileName):
  html = (await mammoth.convertToHtml({ buffer })).value
  blocks = htmlToBlocks(html)                 // reuse epub.js verbatim
  return blocksToChapters(blocks, { fileName })   // shared helper (see refactor)
```

### Refactor: extract `blocksToChapters` shared with Markdown

Markdown's chapter-splitting logic currently lives **inline** in `src/parse/markdown.js`
(top-most heading level splits chapters; no heading → one chapter; leading pre-heading content
→ an untitled chapter; title falls back `firstHeadingText || baseName(fileName) || 'Untitled'`).

DOCX needs that logic **identically**. So extract it into a shared, format-agnostic helper that
both `markdown.js` and `docx.js` call — rather than copy-paste:

```js
// src/parse/blocks-to-chapters.js  (or a shared export)
blocksToChapters(blocks, { fileName })  // returns { title, chapters }
```

After the extract:
- `markdown.js` keeps only its frontmatter-strip + `marked.parse()`, then calls the helper.
- `docx.js` keeps only its `mammoth` call, then calls the helper.
- The helper owns: top-most-heading detection, chapter accumulation, untitled-leading-chapter,
  empty-chapter filtering, title fallback.

The `baseName(fileName)` filename → title fallback inside the helper must strip the **caller's**
extension generically (it already handles `.md`/`.markdown`; widen to also strip `.docx`, or
make it extension-agnostic — strip the last `.<ext>`).

### Dispatcher: `src/parse/index.js` (two lines)

```js
if (ext === 'docx') return parseDocx(buffer, fileName);   // in parseDocument
// extractCover: docx has no cover → return null (Phase 3 title-card tile, free)
```

### Wiring (mirrors the Markdown change exactly)

- **`main.js`** — native file-picker filter and **both** empty-state copy strings gain `.docx`.
- **`library.js`** — already calls the dispatcher with `fileName`; **no change**. (The stored
  copy is still hash-keyed `original.epub` — harmless, never re-parsed by name; same cosmetic
  note Markdown carries.)

---

## Title

`firstHeadingText || baseName(fileName) || 'Untitled'` — same as Markdown, owned by the shared
helper. **Deferred (future nicety, not v1):** Word docs carry a real title in
`docProps/core.xml`, and jszip is already a dependency so reading it is cheap — but for fiction
drafts the first Heading-1 or the filename is almost always the real title, and matching
Markdown keeps `blocksToChapters` format-agnostic. Revisit only if filename titles feel wrong.

---

## Edge cases (accept mammoth defaults — YAGNI)

- **No heading styles** → one chapter. Acceptable; the user's drafts use Heading styles anyway.
- **Images** — mammoth emits `<img>` data-URIs; `htmlToBlocks` collects *text* from block tags
  only, so images are silently ignored. Good.
- **Tables / footnotes** — rare in prose drafts; whatever `htmlToBlocks` does is fine for v1.
  Footnotes become trailing list items at most. Not worth special-casing.
- **No cover** — `extractCover` returns `null` → deterministic-color title-card tile (Phase 3),
  no new cover code.

---

## Testing & verification (same bar Markdown cleared)

### Unit tests (Node `node:test`)

- **`test/unit/blocks-to-chapters.test.js`** — the extracted shared helper, tested directly with
  inline block arrays (pure, no fixtures): top-most-heading split, no-heading → one chapter,
  leading-content → untitled chapter, title fallback. This is the real new logic → most coverage.
- **`test/unit/docx.test.js`** — `parseDocx` end-to-end on a **tiny real `.docx` fixture**
  committed to `test/fixtures/` (a 2-chapter doc using Heading-1 styles). Asserts: 2 chapters,
  real titles, headings carried as `{heading, sentences}`, sentences split.
- **Markdown regression** — re-run the existing markdown tests **unchanged** after the extract to
  prove the refactor preserved behavior (all 7 still green). This is the safety net for the
  shared-helper refactor.

### Smoke (`npm run smoke`)

Add one line mirroring the Markdown smoke: drop `sample.docx` onto the shelf → opens to the
reader → first narratable span is the heading `0.0.0` → narration advances through the **real
engine** → shelf tile is a title-card (not `<img>`). Prior 100/100 + all format assertions stay
green.

### Package gate

`npm run dist:win`, then `asar list` confirms `src/parse/docx.js`, the shared helper, and
`node_modules/mammoth/**` are inside `app.asar`. mammoth is **pure-JS** — no native binary, no
`asarUnpack`, no model fetch. Rebuild the portable `.exe`.

---

## Honest caveats to carry into the build

- **Voice quality on real prose is ears-only** — not assertable by Playwright; the user listens
  to one of their own `.docx` drafts.
- **Add-button path** for `.docx` is code-complete but the smoke can't drive the native OS file
  dialog (same as every format; drag-drop is the automated path).
- **`.doc` (old binary) unsupported** — loud, correct failure via the dispatcher's throw.
- macOS still unbuilt (Phase 1 carryover, deferred until the Windows version is finished).

---

## Out of scope (explicitly)

- Pronunciation overrides (the other Phase 4 item — stays deferred).
- `docProps/core.xml` title extraction (deferred nicety, above).
- `.doc`, RTF, ODT, or any non-OOXML word-processor format.
- DOCX images/tables as rendered content (text-only, by design).

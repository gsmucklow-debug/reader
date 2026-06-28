# Phase 4 (part 1) — Markdown reading: validated design

> Brainstormed and validated with the user (2026-06-28). This is the **why/decisions**
> doc; the TDD builder plan is a separate file. Scope was deliberately narrowed during
> brainstorming — see "Scope decisions" below.

## Goal

Let the user drop their **own Markdown drafts** (`.md` / `.markdown`) into the library and
listen to them, with the same sentence highlighting, chapters, headings-read-aloud,
auto-resume, and shelf behaviour that EPUBs already get. Driven by the user's real use
case: manuscripts/drafts written in Markdown (Obsidian-style, but **no YAML frontmatter**
in practice), listened back to.

## Scope decisions (locked during brainstorming)

- **Markdown only this phase.** DOCX was considered and explicitly **deferred** to a later
  phase. The user's drafts are in Markdown first; `.docx` "later or not at all."
- **No new cover code.** Markdown carries no embedded cover, so the **Phase 3 title-card
  fallback already handles the shelf tile**. The "generic generated covers" item that was
  loosely bundled into "Phase 4" is **dropped** (YAGNI) — title cards are sufficient.
- **No reader / IPC / schema changes.** The whole feature lands at the parse layer plus a
  format dispatcher and three copy/filter tweaks. `document.json` for a `.md` book is the
  same `Document` shape as for EPUB, so resume / finished / remove / persistence work with
  **zero new code**.
- **Plain-ish markdown, no YAML.** Drafts don't use frontmatter; we still strip a leading
  `---…---` block defensively (near-zero cost, can't hurt). Full Obsidian `[[wikilinks]]` /
  `#tags` handling is **not** built — `marked`→HTML→text already yields clean prose, and the
  user confirmed plain files.

## Architecture — reuse the EPUB HTML path

The EPUB parser already turns *any* HTML into the reader's contract. Markdown rides that
seam instead of inventing a parallel pipeline.

New pure function `parseMarkdown(buffer, fileName)` in `src/parse/markdown.js`:

1. `buffer.toString('utf8')` → text; strip a leading `---…---` frontmatter block if present.
2. `marked.parse(text)` → HTML string. `marked` is **pure-JS, zero runtime deps** — the same
   "focused pure-JS library" precedent as `jszip` + `cheerio` (no native modules to compile
   per-OS, a standing constraint).
3. **Reuse `htmlToBlocks(html)` unchanged** (already exported from `epub.js`) → ordered
   `[{tag, text}]` blocks (h1–h6, p, blockquote, li), with `script/style/nav/header/footer/
   aside` chrome removed and nested-block de-duplication handled. `<pre>` code fences are not
   in `BLOCK_TAGS`, so code blocks are **not** narrated as gibberish.
4. Split blocks into chapters (the only new logic, below), mapping each block to a paragraph
   with the **Phase 2.6 heading model** (`{heading: level, sentences}` for headings, else
   `{sentences}`), sentences via the existing `splitSentences`.

Output: `Document { title, chapters: [ { title, paragraphs: [ { heading?, sentences:[] } ] } ] }`
— byte-for-byte the same contract `parseEpub` produces.

## Chapter splitting (the one new piece)

- `topLevel` = the **smallest heading level present** in the block list (file using `#` +
  `###` → split on `#`; file whose biggest heading is `##` → split on `##`). Adapts to the
  author's convention instead of over-splitting subsections.
- Each block at `topLevel` **starts a new chapter**; its heading becomes that chapter's own
  `<hN>` (shown + spoken). Deeper headings and paragraphs accumulate into the current chapter.
- Blocks **before the first** `topLevel` heading form one leading untitled chapter, only if
  non-empty (mirrors EPUB front matter).
- **No headings at all → one chapter** (paragraphs only) — the common quick-draft case.
- **No synthesized-heading fallback** (unlike EPUB, whose title often comes from a separate
  TOC): the chapter's splitting heading is already an in-block heading, so nothing to inject.

**Title resolution:** `Document.title` = first `topLevel` heading text → else **filename
without extension** → else "Untitled". Chapter `title` = that chapter's heading text (Chapters
panel + "Chapter X of Y" strip) or `null`.

## Integration — a dispatcher + three tweaks

A format dispatcher keeps the library format-agnostic. `src/parse/index.js` exports
`parseDocument(buffer, fileName)` and `extractCover(buffer, fileName)`:

- `.epub` → `parseEpub` / `coverImage` (unchanged)
- `.md` / `.markdown` → `parseMarkdown` / `() => null`
- otherwise → throw a clear "Unsupported file type" error (caught by the existing
  `addAndOpen` catch → the shelf's "Couldn't open that file" card)

`makeLibrary`'s injectable `parse`/`cover` deps already exist; widen the call to pass
`fileName` and point the defaults at the dispatcher. The fake-dep unit tests keep working
(extra arg ignored).

Renderer/main surface changes (copy + filters only):
1. `pick-file-bytes` dialog filter `['epub']` → `['epub','md','markdown']`; relabel
   "Open an EPUB" → "Open a book".
2. Drag-drop already routes bytes through `addAndOpen` → `library.add`; add a guard so an
   unsupported drop shows the friendly error instead of a raw throw. `.md` flows through once
   the dispatcher exists.
3. Empty-state / drop copy: "Drag an EPUB here" → "Drag an EPUB or Markdown file here."

No new IPC channel, no `document.json` schema change, no reader changes.

## Testing & acceptance

**Unit (TDD, pure):** `test/unit/markdown.test.js` — top-most-level heading split; no-heading
→ one chapter; frontmatter stripped; emphasis/links cleaned and code fences not emitted;
title resolution (H1 → filename → "Untitled"); multi-sentence paragraph splits;
`extractCover('.md')` → `null` without throwing. Plus a `library.test.js` case: `add(bytes,
'x.md')` dispatches to the markdown parser (spy via deps) and stores a `null`-cover record.

**Fixture:** `test/fixtures/sample.md` (title, two `#` chapters, paragraphs incl. emphasis +
a link).

**Smoke (one added flow):** drag-drop `sample.md` → title-card tile → open → first heading is
the first narratable span → Play advances one sentence through the **real engine**. Reuses the
Phase 3 library-loop harness; resume/finished are format-agnostic and not re-proven.

**Package gate:** `marked` and `src/parse/markdown.js` ship in the asar; rebuild `dist:win`.

**Acceptance criteria:**
1. Drag-drop or Add imports a `.md`; it appears on the shelf with a title-card.
2. Opening reads it aloud with sentence highlighting; `#` headings drive chapters + are spoken.
3. A no-heading `.md` reads as one chapter.
4. Resume / finished / remove / persist work identically to EPUB (no new code).
5. No regression: EPUB path and all existing tests + smoke green; `marked` + `markdown.js` ship.

## Out of scope (do not build)

DOCX (later phase); generic generated covers (title cards suffice); Obsidian wikilink/tag/
embed special-casing; pronunciation overrides (still a later Phase 4 item); per-book settings.

## Recommended build

Sonnet 4.6, medium — standard parse + dispatch + tests, no voice/GPU/Electron-lifecycle risk.
The one judgement-heavy spot is the chapter-split rule, which is fully specified above.

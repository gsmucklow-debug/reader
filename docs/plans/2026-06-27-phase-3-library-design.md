# Phase 3 — Library + auto-resume (design)

> The validated design from a brainstorming session with the user (2026-06-27). The builder plan
> ([`phase-3-library.md`](./phase-3-library.md)) turns this into steps. Source of truth for "why."
>
> **Context:** [`../design.md`](../design.md) §6 (Library & persistence) + §9 (roadmap),
> [`../HANDOFF.md`](../HANDOFF.md).

## Goal

A **bookshelf** is the app's home. Add EPUBs by drag-or-button; each book remembers the **exact
sentence** you stopped on and reopens right there, ready to play. The single-book reading flow built in
Phases 1–2.6 becomes a sub-view reached from the shelf.

## Decisions (locked with the user)

1. **Storage = copy original + parsed cache.** On add, copy the original EPUB into app-data and store
   the parsed `Document` JSON + the cover. Self-contained: moving/deleting the source never breaks the
   shelf, and we can re-parse later if the parser improves.
2. **Resume position is the only per-book state.** All comfort/voice settings (font, theme, text size,
   page width, view mode, voice, speed, end-of-chapter pause) **stay global** as today. Per-book
   comfort/voice is deferred (YAGNI).
3. **EPUB-only, with a title-card fallback cover.** Extract the embedded EPUB cover; for cover-less
   EPUBs generate a clean title card (deterministic color from the title) so the grid never has blank
   tiles. MD/DOCX + a generic cover system stay in Phase 4.
4. **Shelf is home; reader is a sub-view.** App opens to the shelf (drop-zone empty state on first
   run). Click a cover → reader opens at the saved sentence. A **"← Library"** control returns to the
   shelf.
5. **Two groups on the shelf:** **active** (unfinished, `lastOpened` desc) and a separate **Finished**
   section below. **"Finished" is derived** (`progress === lastAddress`), not a stored flag — reopening
   a finished book and jumping earlier moves it back to active automatically.
   - **Reopening a finished book restarts from the beginning** (resets `progress` → it returns to the
     active shelf). Landing on the saved last-sentence is useless; re-reading is the normal reason to
     reopen a finished book.
6. **A clear delete/remove** control per book (with confirm): deletes the book folder + index entry.
   Global clips are **not** purged (other books may share sentences; clips are cheap + self-evicting).

## Data model

Under Electron `userData`:

```
userData/
  library/
    index.json            # array of book records (the shelf)
    books/<bookId>/
      original.epub       # copied source
      document.json       # parsed normalized Document
      cover.<ext>         # extracted EPUB cover OR generated title card
  clips/                  # existing global clip cache (unchanged)
  settings.json           # existing global settings (unchanged)
```

- **`bookId` = SHA-256 of the original file bytes** → adding the same book twice is idempotent.
- **Book record:**
  ```
  { id, title, author, addedAt, lastOpenedAt,
    cover,                      // relative filename, or null → render title card
    lastAddress,                // {ci,pi,si} of the final sentence (from parse; reading-cursor shape)
    progress }                  // {ci,pi,si} | null (never opened)
  ```
  (Addresses use the existing `reading-cursor.js` shape `{ci,pi,si}` = chapter/paragraph/sentence
  indices — not a separate notation.)
- **Finished** = `progress != null && progress` deep-equals `lastAddress`. Derived at render time; no
  flag to keep in sync.

## Components

- **`src/main/library.js`** (new) — CRUD over `index.json` + book folders. Pure index logic
  (add/remove/updateProgress/list-split) is dependency-injected with a base dir, unit-tested like
  `clip-cache.js`. The fs/copy/parse edges are thin.
- **IPC:** `library:list`, `library:add` (bytes → store → record), `library:remove`,
  `library:getDocument`, `library:updateProgress`.
- **`src/parse/epub.js`** — add cover extraction (OPF manifest `properties="cover-image"` or legacy
  `meta[name=cover]` → image bytes + mime).
- **Renderer:** a **shelf view** (`src/renderer/library.js` + grid DOM in `index.html`); a top-level
  shell that toggles shelf ↔ reader via CSS show/hide (same pattern as the popover split — the reader's
  per-sentence DOM contract, pagination, and CSS-only `setView` are untouched). Title-card fallback
  rendered client-side (SVG/canvas, deterministic color from a title hash).

## Data flow

- **Add:** drag-drop/picker bytes → `library:add` → hash, copy original, parse to `Document`, extract
  cover (or mark null), compute `lastAddress`, write files + append record → return record → open it.
  (Reuses the existing import/parse path; it's now fed from the library, not a one-shot parse.)
- **Open:** `library:getDocument` → mount → seek reading-cursor to `progress` (or sentence one) →
  paused, highlighted, page shown.
- **Save progress:** on sentence advance, **debounced ~1–2s** `library:updateProgress`; **flushed** on
  pause, back-to-library, and app quit.

## Robustness requirements (must build deliberately, not discover via red tests)

1. **End-of-book must persist `progress` exactly equal to `lastAddress`.** "Finished" is derived from
   that equality, so the book-end handler must flush progress at the final sentence — and that flush
   must **win over any in-flight debounce** (cancel the pending debounced write, write `lastAddress`).
   Phase 2's book-end ("stops cleanly, play resets") doesn't currently guarantee where the cursor
   lands; pin it here.
2. **Re-adding a book preserves existing `progress`.** Idempotent-by-hash means more than "no dupe
   tile": re-dropping a book you're halfway through must **not** reset you to the start. `library:add`
   on an existing `bookId` keeps the existing record's `progress`/`lastOpenedAt` (refreshes files if
   needed). Unit test asserts progress survives a re-add.
3. **Quit-flush must not race process teardown.** `before-quit` async fs writes can lose to exit.
   Either write progress **synchronously** on the quit path, or `event.preventDefault()` and quit after
   the write resolves. (Joins the Electron-lifecycle gotchas in HANDOFF.)

## Testing

- **Unit (`node:test`):** index add idempotent by hash; remove; `updateProgress` round-trip; list split
  (active by `lastOpened` desc vs derived-finished); title-card color determinism. Injected temp dir.
- **Smoke (Playwright-Electron):** drag-drop add → tile w/ cover → click → reader at start → play
  advances → back to shelf → reopen → **resumes at the advanced sentence**; reaching the end moves the
  book to **Finished**; remove deletes it; persists across a restart (isolated `--user-data-dir`).

## Out of scope (deferred)

- MD/DOCX formats + the generic generated-cover system (Phase 4).
- Per-book comfort/voice/speed memory; pronunciation overrides (Phase 4).
- The "voice-leads" manual-nav-vs-clip UX flag (noted open question in HANDOFF).
- App rename.

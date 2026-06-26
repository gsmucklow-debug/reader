# Reader — Handoff / Current State

> **This is the single living file that tells a fresh session where things stand.**
> Read this first, then the design doc if you need the full picture.
> Keep it short and current. Update the "What's done" and "Next up" sections as work lands.

**Project:** Reader — a narrating, sentence-highlighting reading app for a user with MS /
brain fog. Goal: listen + read together, never lose your place. No terminal, double-clickable,
runs on Windows 11 + macOS (MacBook Pro M5).

**Full design:** [`design.md`](./design.md) — read for any "why" question.

---

## The 60-second orientation

- **Voice:** Kokoro via `kokoro-js` + ONNX Runtime, in-process JS, **CPU only**. No Python.
- **Sync:** **sentence-level**, one **audio clip per sentence**. No alignment/timestamps.
  Rewind = replay earlier clips. This is the key design decision — don't reintroduce alignment.
- **Shell:** Electron, all-JavaScript, double-clickable builds on both OSes.
- **Formats:** EPUB, Markdown, DOCX. **No PDF.**
- **Constraints that override convenience:** no terminal, cross-platform, calm/low-load UI,
  auto-resume, offline/free/private.

---

## What's done

- [x] Brainstorming + design complete and approved (2026-06-25).
- [x] Master design doc written: [`design.md`](./design.md).
- [x] Phase 1 plan written: [`plans/phase-1-skeleton.md`](./plans/phase-1-skeleton.md).
- [~] **Phase 1 — Skeleton built; Windows-verified, Mac pending (2026-06-25).**
  Built by an Opus 4.8 coder session; report verified by the planning session (23/23 unit tests
  re-run green, portable `.exe` confirmed present). **Six of seven acceptance criteria met on
  Windows; AC#2 (macOS arm64) is unverified** — see "Next up." Double-clickable Electron app
  opens an EPUB into a calm reading view: single-page + continuous-scroll modes, light/dark,
  text zoom, page width. No voice yet, by design.
  - **Windows portable `.exe` built and launch-verified** → `dist/Reader-0.1.0-portable.exe`.
  - **macOS `.dmg` configured but NOT built/verified** — electron-builder can't produce or
    launch a Mac build from Windows. Needs the user to run `npm run dist:mac` on the M5,
    then right-click→Open (unsigned). This is the one acceptance criterion still open.
  - 23 unit tests green (sentence splitter, EPUB extractor, renderer). A Playwright-Electron
    smoke test launches both the dev window and the packaged `.exe` and drives the **real**
    handlers: a synthetic drag-drop renders the book, and the zoom / view-mode / theme buttons
    are clicked and asserted. Parser verified on 7 EPUBs — 3 Gutenberg fixtures + the user's 4
    commercial books — with zero crashes.
  - **One path still manual:** the **Add-book** button opens a native OS file dialog that
    Playwright can't drive — it's code-complete (`pickAndParse` IPC), give it one click on
    first run. (Drag-drop, which shares the same render path, is automated.)
  - How to run: [`../HOW-TO-RUN.md`](../HOW-TO-RUN.md). Dev scripts: `npm start`, `npm test`,
    `npm run smoke`, `npm run dist:win`.
- [x] Phase 1.5 plan written & approved (2026-06-25):
  [`plans/phase-1.5-pagination-chapters-fonts.md`](./plans/phase-1.5-pagination-chapters-fonts.md).
- [x] **Phase 1.5 — built & planner-verified (2026-06-25, Windows).** Coder report (Opus 4.8)
  received; planning session independently re-verified every claim — **not taken on "looks good."**
  Real CSS-multi-column pagination (single-page + **two-page spread** + bounded scroll, one chapter
  mounted at a time), TOC panel + chapter-skip + live "Chapter X of Y · Page N/M" strip, a **6-font
  switcher** (Inter, Atkinson Hyperlegible, Source Sans 3, Literata, Lora, Bitter — bundled OFL
  `.woff2`, offline), and a global `settings.json` (font/theme/textSize/pageWidth/viewMode only).
  - **Independently re-verified by the planner:**
    - `npm test` → **31/31 green** (re-run here, the original 23 + 8 new pagination tests).
    - `npm run smoke` → **PASS** (re-run here): real drag-drop renders addressable spans;
      single-page flip + **cross-chapter roll** both directions; all 3 modes cycle; pagination
      integrity (no blank trailing page, last sentence not cut off) on chapters 1 & 4; TOC shows
      **real chapter titles** (not "Untitled") and jumps; **Inter loads offline** + spans survive
      re-pagination; both Phase 2 seams resolve without throwing; **all 6 comfort prefs persist
      across a restart** (set to non-default values in an isolated `--user-data-dir`).
    - **Fonts ship in the package:** all 12 `.woff2` confirmed *inside* `dist/.../app.asar` (via
      `asar list`); each file has a valid `wOF2` magic header (not a 404/HTML stub); `fonts.css`
      declares all 6 families with names that **exactly match** the `FONTS` catalog in `app.js`;
      CSP is `font-src 'self'` (no CDN at runtime).
    - **Per-sentence spans survive pagination in all 3 modes — verified by construction, not just
      assertion:** `setView()` only flips `document.body.dataset.view` + re-runs `paginate()`
      (CSS layout); it never rebuilds `readingEl.innerHTML`. The mounted-chapter DOM (every
      `span.sentence[data-chapter/-paragraph/-sentence]`) is identical across single/two/scroll.
      The Phase 2 `highlightSentence` seam is safe in all modes.
  - **Honest caveats recorded:** (a) only **Inter** was *runtime*-load-verified in the smoke; the
    other 5 families rest on valid-file-in-asar + name-matched `@font-face` declarations (strong,
    but not all-6 runtime-proven). (b) Only the **current chapter is mounted** now, so Phase 2
    must `goToChapter()` before a cross-chapter highlight (the coder left `goToPageContaining()`
    unwired for this). (c) macOS still unbuilt — Phase 1 AC#2 carryover, below.
  - **Checked against the *plan's* 8 acceptance criteria (not just the coder's restatement) — they
    map 1:1.** Keyboard bindings the smoke doesn't exercise (`PageUp/PageDown`, `[`/`]`, `t`) were
    confirmed wired in `app.js`'s keydown handler, matching the plan.
  - **AC#8 (no crash on all 7 EPUBs) provenance:** the GUI flip/resize/mode-cycle stress on all 7
    is **coder-reported** (my smoke only drives `alice.epub`). I *independently* re-ran the parser
    over the user's **4 commercial books** — no crash; real chapter titles; and `null`-title
    chapters (9 of them in *A Collapse of Horses*) correctly render as "Untitled"/"Front matter"
    via `chapterLabel()`, never blank.
  - **Feedback the coder fixed (both verified):** chapter titles now come from the EPUB nav/ncx
    (`parseToc`) → real names, not "Untitled" — **re-confirmed on the user's own books**
    (*Never Let Me Go* → "Part One / Chapter One…", Annihilation/Fever Dream all titled);
    dark-mode scrollbar fixed via `color-scheme`.

---

## Next up

**Phase 1.5 is verified. Next: write the Phase 2 plan (voice + highlighting).**

1. **User: confirm the Mac build.** On the M5 MacBook run `npm install` then `npm run dist:mac`,
   double-click the `.dmg`, right-click→Open the app, drag in an EPUB. That closes the only
   unverified Phase 1 acceptance criterion (the app is confirmed on Windows already). *(Parked —
   Windows is the focus right now.)*
2. **Write the Phase 2 plan** (voice + sentence highlighting). The seam is already in place —
   `src/renderer/app.js` has a documented `highlightSentence(ci, pi, si)` hook and the reading
   view renders every sentence as `<span class="sentence" data-chapter data-paragraph
   data-sentence>`, matching `doc.chapters[ci].paragraphs[pi].sentences[si]`. Phase 2 = make
   one Kokoro clip per sentence, play in order, call that hook, scroll it ~¾ up.

> Recommended for Phase 2: **Opus 4.8, high thinking** (core engine). See design.md §9.

---

## Decisions log (so they're not re-litigated)

- Local neural voice (Kokoro), not cloud — free/offline/private. Cloud premium voice deferred.
- Sentence-level highlighting (not word-level) → per-sentence clips → no alignment needed.
- Electron (not Tauri) → simplest path to all-JS, double-clickable, cross-platform.
- CPU (not GPU) → identical behavior on Win/Mac; model is fast enough.
- Library with covers + auto-resume from the start (Phase 3). Bookmarks/notes deferred.
- PDF out of scope.
- Three reading view modes: single page, two-page, continuous autoscroll (~¾-up highlight).
- Pronunciation overrides via "sounds-like" respelling, per-book + global.
- All work with Claude (no Codex).

---

## Open questions / things to revisit later

- App name — currently just "Reader" (working title). Pick a real one before Phase 3 polish.
- Premium cloud voice as an optional toggle — possible future phase.
- Couch/tablet listening (serve audio from PC over wifi) — possible future phase.
- Bookmarks / notes — deferred enhancement to the library.

---

## Tech chosen in Phase 1 (the parsing stack)

- **EPUB parsing = `jszip` + `cheerio`, our own extractor** (`src/parse/epub.js`), not a
  3rd-party reader. Both are pure-JS → no native modules to compile per-OS. We extract into our
  own normalized `Document { title, chapters[{title, paragraphs[{sentences[]}]}] }` so Phase 2
  owns the per-sentence model. Reading order follows the OPF **spine**, skips the `nav` doc.
- **Sentence splitting = our own abbreviation-aware splitter** (`src/parse/split-sentences.js`),
  unit-tested + spot-checked on real prose (6089 sentences, 0 bad splits). Not `Intl.Segmenter`
  (inconsistent on abbreviations across engines).
- **Tests = Node's built-in `node:test`** (no Jest/Mocha). **GUI smoke = Playwright `_electron`.**
- **Packaging = electron-builder**: Windows `portable` (single double-click `.exe`), macOS `dmg` arm64.

## Gotchas to remember (will grow as we build)

- **EPUB reading order** must follow the spine and skip nav/headers/footers — not just "dump
  all text." (Done in `htmlToBlocks` / `readingOrder`.)
- **Sentence splitting** must handle abbreviations ("Mr.", "e.g.", "St.") so clips don't break
  mid-sentence. (Done; abbreviation list lives at the top of `split-sentences.js` — add to it
  if you hit a new one.)
- **Front-matter / Gutenberg boilerplate** ("Title:", "Author:", license pages) currently shows
  as the first "chapter." Harmless for Phase 1 reading; revisit if it's annoying when narrated.
- **`dc:title` needs a namespaced lookup** — cheerio CSS selectors can't address the `dc:` prefix
  in xml mode, so we match by tag name. Watch for this on any other Dublin Core metadata.
- **`[hidden]` vs CSS `display`**: an ID rule with `display:flex` beats the `hidden` attribute.
  We force `[hidden]{display:none !important}` — keep that, or show/hide toggling silently breaks.
- **Electron drag-drop**: `File.path` is gone in modern Electron. We read the dropped file to an
  ArrayBuffer in the renderer and IPC the bytes to main for parsing; `preventDefault` on
  dragover/drop + a `will-navigate` guard stop Electron from navigating away from the app.
- **This dev shell exports `ELECTRON_RUN_AS_NODE=1`**, which makes the `electron` binary run as
  plain Node (no window; `require('electron')` returns a path string). Clear it before launching:
  `env -u ELECTRON_RUN_AS_NODE npm start` (and Playwright launches strip it from `env`).
- **Mac build must happen on the Mac** — you cannot produce/verify the `.dmg` from Windows.
- Keep the voice on **CPU** — do not "optimize" onto GPU; it reintroduces per-OS divergence.
- **Mode switch is CSS-only.** `setView()` flips `body.dataset.view` + re-paginates; it never
  rebuilds `readingEl.innerHTML`. Keep it that way — the per-sentence spans (and the Phase 2
  highlight seam) depend on the chapter DOM being identical across single/two/scroll.
- **Pagination is one chapter at a time** (only the current chapter is mounted). Phase 2 must
  `goToChapter()` before highlighting a span in another chapter. `goToPageContaining()` exists
  but is unwired; it reads a span's `offsetLeft` in the multi-column flow — may need a
  `getBoundingClientRect` fallback if an engine reports offsets pre-fragmentation.
- **Pagination page-count math** folds the column gap into the stride (`round` for columns,
  `ceil` for two-page spreads) — empirically tuned so there's no blank trailing page and no
  cut-off tail. Don't "simplify" the gap term away. `paginate()` must re-run after
  `document.fonts` load so metrics are real (font change, resize, text-size, page-width).
- **Page margins live on the viewport wrapper**, never on the column-flow element — that element
  is padding-free so `column-width` == its content width exactly. Putting padding on it causes
  cross-page bleed / off-by-one. (Design-review trap; keep it as is.)
- **Bundled fonts:** family names in `app.js`'s `FONTS` array must match the `@font-face`
  `font-family` in `fonts.css` *exactly* (incl. spaces: "Source Sans 3", "Atkinson Hyperlegible")
  or the switcher silently falls back. Inter/Source Sans 3/Literata/Lora/Bitter are variable
  `.woff2` (Regular==Bold file, same bytes); Atkinson is static. `font-src 'self'` in the CSP is
  what lets them load — don't tighten it.
- **`package.json` `build.files` must include `assets/**/*`** or the fonts don't ship in the
  `.exe`/`.dmg`. (Verified present in the asar.)
- **Stale `dist/` artifact:** the portable `.exe` + `win-unpacked/` from the font-packaging check
  are build outputs, not source. Safe to delete / regenerate with `npm run dist:win`.

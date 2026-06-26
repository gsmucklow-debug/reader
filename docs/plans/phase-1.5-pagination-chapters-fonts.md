# Phase 1.5 Plan — Real Pages, Chapters, and Fonts

> **Run this with:** Claude **Opus 4.8**, **high thinking**, in VS Code.
>
> **STRICT — separation of duties (see [`../design.md`](../design.md) §10):**
> You are a **builder session. Execute this plan only.** Do **NOT** edit any planning
> document — not `HANDOFF.md`, not `design.md`, not this plan, not anything in `docs/`.
> When you finish, **deliver a self-contained written report** back in chat (what you built,
> how you verified each acceptance criterion, what's left, and any gotchas). The planning
> session will verify your report and is the **sole author** of `HANDOFF.md`.
>
> **Full context if needed:** [`../design.md`](../design.md), [`../HANDOFF.md`](../HANDOFF.md),
> [`phase-1-skeleton.md`](./phase-1-skeleton.md). This plan refines the Phase 1 reading view;
> the parsing core and Electron shell already exist and pass 23 unit tests — don't rebuild them.

---

## Goal of this phase

The Phase 1 reading view works but has three gaps the user hit on the real Windows build:

1. **"Single page" doesn't paginate** — it's just a scroll with no page height.
2. **No chapter structure** — the whole book is dumped into one long column.
3. **No font choice.**

Fix all three, and pull the **two-page view** forward (it was tagged Phase 4, but the
pagination engine built here makes it nearly free). **Windows is the focus this round**;
nothing here is OS-specific, so the Mac build stays intact (still unverified — not this round).

**No voice yet** — Phase 2 is still next. Everything here must keep the Phase 2 seams intact.

---

## Hard constraints / invariants (do not violate)

- **The per-sentence DOM contract is sacred.** Every sentence must remain a distinct, addressable
  element — `<span class="sentence" data-chapter data-paragraph data-sentence>` keyed to
  `doc.chapters[ci].paragraphs[pi].sentences[si]`. **Pagination is layout-only** (CSS columns +
  `translateX`); **never** chop or restructure the DOM to make pages. Phase 2's highlight depends
  on this.
- **Pure-JS only.** No native modules. Fonts ship as static `.woff2` files; multi-column is
  built into the browser engine. No new native compilation.
- **Offline / private.** Fonts are **bundled into the app**, declared via `@font-face` from local
  files. **Nothing fetches from a CDN / Google Fonts.**
- **Calm, low-load UI.** Controls stay one tap away and out of the way; reading view stays
  distraction-free. Keyboard-drivable.
- **Don't regress** the existing parsing/render contracts. `src/parse/epub.js`,
  `src/parse/split-sentences.js`, and `src/renderer/render.js`'s span output must keep their
  current behavior and keep their 23 unit tests green.

---

## What to build

### 1. Core model — a "current chapter"
The chapter becomes the unit of what's on screen, in **all three view modes**.
- Track a **current chapter index**. Render **only that chapter** into the reading view at a time
  (not the whole book). `render.js` already emits one section per chapter — render/show the
  current one.
- Moving between chapters is done by the chapter controls (below), not by scrolling off the end.

### 2. Three view modes (CSS multi-column engine)
Replace the current 2-way toggle ("Single page" / "Scroll") with a **3-way** toggle:

1. **Single page** — current chapter laid out in **CSS multi-column**; each page is **one column**
   the exact size of the reading area. Flip = `translateX` by one page width. **No DOM changes.**
   - Flipping past the **last** page → next chapter's **first** page.
   - `←` on **page 1** → previous chapter's **last** page.
2. **Two-page** — same engine, **two columns visible per spread**, flip by two column-widths.
   Reading flows bottom-left → top-right (design §5).
3. **Scroll** — current chapter as one continuous, **bounded** column (manual scroll). Reaching
   the bottom does **not** auto-jump; the user uses chapter controls to continue.

**Pagination helper (`paginate()`):** after layout, compute page width and **page count**
(`scrollWidth / pageWidth`), clamp the current page. **Re-paginate on:** window resize (debounced),
text-size change, page-width change, **font change**. Page breaks shifting on zoom is expected and
fine (design §5).

**Phase 2 seam:** add and document a `goToPageContaining(sentenceEl)` helper (find the span's
column/page index and flip to it) alongside the existing `highlightSentence(ci, pi, si)` seam.
Comment it clearly as a Phase 2 hook. **Do not wire it to anything yet.**

**Keyboard:** `←`/`→` and `PageUp`/`PageDown` flip pages; `Home`/`End` jump to chapter
start/end; `[` / `]` previous/next chapter; `t` toggles the TOC.

### 3. Chapter navigation & orientation
- **TOC button** in the top bar. Click → a calm panel **slides in over the left** listing chapter
  titles from the parsed `Document`. Click a chapter → jump to its first page, panel closes.
  Click-away or `Esc` also closes. Highlight the current chapter in the list.
- **Chapter-skip buttons** `⇤` / `⇥` in the bottom control strip — previous / next chapter.
- **Orientation strip** (quiet, bottom): `Chapter 3 of 21 · Page 4 / 12`, updates live.
- Untitled chapters (front-matter / the Gutenberg boilerplate gotcha) show as "Front matter" /
  "Untitled", never blank.

### 4. Fonts
- In the existing **Aa settings popover**, add a **Font** control above Text size: a labeled list
  of the bundled families, **each item rendered in its own typeface** (preview by looking).
  Click to apply live.
- **Bundle these 6** (all OFL, good-looking on screen). Ship local `.woff2` in `assets/fonts/`,
  declared with `@font-face`:
  - **Sans:** Inter · Atkinson Hyperlegible · Source Sans 3
  - **Serif:** Literata · Lora · Bitter
- **Default = the current serif reading font** (nothing changes unless the user picks).
- Font change → `paginate()` re-run (metrics change page breaks).
- Verify the `.woff2` files are included by `electron-builder` in the packaged app (they're under
  `assets/`, which is outside the current `files` globs — **update the build `files` list** so
  fonts ship, and confirm in `win-unpacked/`).

### 5. Persist comfort settings (minimal)
- Write a single **`settings.json`** in the Electron **app-data** folder holding: `font`, `theme`,
  `textSize`, `pageWidth`, `viewMode`. Load on launch, save on change.
- **Global only.** This is *not* per-book memory and *not* reading-position resume — those are
  Phase 3. Keep it to these few global comfort fields.

---

## Acceptance criteria (this phase is done when…)

1. **Single page** shows real, window-sized pages; `←`/`→` flips; flipping past a chapter's end
   rolls into the next chapter's first page (and `←` on page 1 goes to the prior chapter's end).
2. **Two-page** spread renders two columns and flips by two.
3. **Scroll** mode shows one bounded chapter (no bleed into the next).
4. **TOC** panel opens/jumps/closes; `⇤`/`⇥` skip chapters; `Chapter X of Y · Page N/M` updates
   live.
5. **Font switcher** lists the 6 bundled fonts with in-typeface previews, applies live, and the
   fonts are confirmed bundled in the packaged `.exe` (offline — no network).
6. **Comfort settings persist** across an app restart (font/theme/size/width/mode).
7. **Sentence spans remain addressable** (`data-chapter/paragraph/sentence`) in all three modes
   after paginating — verify in devtools. **All 23 existing unit tests stay green**, plus new
   tests below.
8. No crash flipping/jumping/resizing on the same 7 EPUBs used in Phase 1.

---

## Testing

- **Unit:** pure pagination math — given content width + page width → correct page count; given a
  sentence index → correct page index. Keep these as pure functions so they're testable without a
  window.
- **Playwright-Electron smoke (extend the existing one):** flip pages with `←`/`→` and assert the
  visible page changed; cycle all three modes; open TOC and jump to a chapter; change font and
  assert re-pagination; after paginating, assert a chosen sentence span is still present and
  addressable.
- Existing 23 unit tests must remain green.

---

## Out of scope for Phase 1.5 (do NOT build)

- Any voice / TTS / audio, and any wiring of `highlightSentence` / `goToPageContaining`. (Phase 2.)
- Per-book memory, reading-position auto-resume, library/bookshelf/covers. (Phase 3.) Only the
  small **global** `settings.json` above.
- Markdown / DOCX. EPUB only, still.
- Line spacing, reading speed, end-of-chapter pause, pronunciation. (Phase 4.)
- Mac build verification. (Windows focus this round; just don't break cross-platform.)
- Code-signing / notarization.

---

## When finished

1. Confirm each acceptance criterion with a quick check; note any that are partial.
2. **Do NOT edit `HANDOFF.md`, `design.md`, or any doc.** Instead, write a **report in chat**
   covering: what you built, per-criterion verification (with the test output), what's left or
   partial, the font files/licenses bundled, any `electron-builder` `files`-glob changes, and any
   new gotchas (esp. multi-column page-count quirks). The planning session records it.
3. Leave the per-sentence spans and the documented `goToPageContaining` / `highlightSentence`
   seams clearly in place — Phase 2 depends on them.

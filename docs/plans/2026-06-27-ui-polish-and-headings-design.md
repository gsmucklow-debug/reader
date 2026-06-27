# Design — UI polish & heading reading (+ voice-latency spike)

> Brainstormed + decided with the user (2026-06-27). This is the **why / decisions**
> document. The builder executes [`phase-2.6-ui-polish-headings.md`](./phase-2.6-ui-polish-headings.md)
> (the *how*); the latency question is investigated via
> [`spike-voice-latency.md`](./spike-voice-latency.md). Planning session owns all three;
> see [`../design.md`](../design.md) §10 (separation of duties).

## Context

Phases 1–2.5 are built & verified: the book renders calmly and narrates itself with a
moving highlight, voice/speed/pause are exposed and persisted. The user ran the Windows
build, liked the voice, and gave five concrete UI/parse notes plus a performance question.
This round addresses those before Phase 3 (Library + auto-resume).

## The five issues and their decided fixes

1. **Electron default menu bar** (File/Edit/View/Window/Help, top-left) is wasted space and
   distracting. There is *no* menu code in `main.js` — it's Electron's default.
   **Decision:** remove it with `Menu.setApplicationMenu(null)`. Accepts the loss of default
   accelerators (nothing to copy/paste in a reader; the close button quits). A minimal macOS
   app-menu (Quit) is revisited at the mac build, not now.

2. **The comfort popover is overcrowded** — Font, Text size, Theme, Page width, Voice picker,
   Reading speed and End-of-chapter pause are all crammed into one `#settings-panel`.
   **Decision:** split into **two** top-bar buttons / popovers — **"Aa" → Comfort**
   (Font, Text size, Theme, Page width) and **"Voice"** (Voice picker, Reading speed,
   End-of-chapter pause). Mutually exclusive; Esc / outside-click closes. The control logic is
   unchanged — only the markup moves and a second toggle is added.

3. **"Horrible blue" transport icons** (⏮ back-a-paragraph, ⏸ pause) — those are
   *emoji-presentation* Unicode characters, so Windows paints them in full color.
   **Decision:** replace **all** transport glyphs with **inline SVG** icons colored via
   `currentColor`, so they're crisp, theme-aware, and identical on Windows and macOS.

4. **Play button looks vertically stretched** — it should be a clean circle.
   **Decision:** give `#play-pause` an explicit equal `width`/`height`, `padding: 0`, and
   `border-radius: 50%`, centering its SVG. (Today the bottom-bar's horizontal padding skews it.)

5. **Headings: duplicated chapter title + headings never read.** The parser pulls the *first*
   heading out of each chapter, uses it as the title, and the renderer injects it as a separate
   `<h2 class="chapter-title">` **that the narrator never reads**. So meaningful headings
   (character POV names like **BARRY**, dates like **November 2, 2018**, section titles) are shown
   but skipped, and when a book *also* keeps its own in-body heading you see the title twice (only
   the body one is read). A bad TOC title ("mischievous of the twins…") gets injected as that
   heading.
   **Decision (chosen by the user): show the book's own headings and read them.**

## Heading handling — the design

The trick that keeps the change small: **a heading is represented as an ordinary paragraph that
carries a `heading` level.** The chapter shape stays
`chapters[ci].paragraphs[pi].sentences[si]`, so the reading-cursor, player, highlight, and
pagination need **zero** changes — only the parser and renderer change.

- **Parser (`epub.js`):** stop pulling/skipping the first heading. Every block stays in reading
  order; a heading block becomes `{ heading: <level>, sentences: splitSentences(text) }`, a normal
  block stays `{ sentences: [...] }`.
- **Chapter title = metadata only:** still `navTitles.get(href) || firstHeadingText || null`, used
  **only** for the Chapters panel and the "Chapter X of Y" strip — never injected into the page.
  This removes the duplicate and keeps garbage TOC titles off the page.
- **Fallback (decided: option a):** a chapter with **no heading of its own** but a known title gets a
  **synthesized** leading heading paragraph (`{ heading: 2, sentences: split(title) }`) so *every*
  chapter has a visible, spoken heading. A chapter that already has its own heading is **not**
  given one (no duplication). A chapter with neither gets none.
- **Renderer (`render.js`):** no injected `chapter-title`. A `heading` paragraph renders as its
  `<hN class="chapter-heading">` (level clamped 1–6) **with sentence spans inside**, so it
  highlights and is narrated like any sentence. Normal paragraphs render as before.
- **Narration:** headings now sit in the normal sentence sequence → read in order, highlighted.

**Known, accepted caveat:** front-matter pages that merely repeat the book title as an `<h1>` will
now be read as a heading. Acceptable per the user's "read the headings" call; revisit only if it's
annoying when narrated.

## Voice latency — spike, don't guess

The user asked about GPU to cut the delay when skipping/seeking/switching voice. This **touches a
logged decision** ([`../HANDOFF.md`](../HANDOFF.md): "CPU (not GPU) → identical behavior on Win/Mac";
"do not optimize onto GPU; it reintroduces per-OS divergence"). So we **measure first**:

- Characterize where the delay is (cold model load on first play; an uncached seek/skip; a
  voice/speed change that flushes prefetch and re-synthesizes).
- Try the **cheap, zero-divergence wins** and measure: warm the model at launch, widen prefetch
  around the cursor, raise the in-memory clip cap.
- Probe whether `onnxruntime-node` can actually use the user's NVIDIA GPU (CUDA/DirectML EP) and the
  real speedup, **with a CPU fallback** — noting the Mac (CoreML/Metal) path would be separate.

Output is a written report with numbers + a recommendation. **No shipping GPU code in this round.**
See [`spike-voice-latency.md`](./spike-voice-latency.md).

## Sequencing

Ship **Phase 2.6** (the five fixes) first — clean, visible, low-risk. Run the **latency spike**
alongside or right after; decide GPU with data.

## Out of scope / deferred

- macOS build (Phase 1 carryover) and a minimal mac app-menu.
- The **app name** (still "Reader") — pick before Phase 3 polish; not blocking.
- Phase 3 (Library + auto-resume) and Phase 4 (pronunciation, Markdown/DOCX).

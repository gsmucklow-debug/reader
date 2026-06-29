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
- [x] Phase 2 plan written & approved (2026-06-27):
  [`plans/phase-2-voice-highlighting.md`](./plans/phase-2-voice-highlighting.md).
- [x] **Phase 2 — Voice + sentence highlighting: built & planner-verified (2026-06-27, Windows).**
  Built in this session via **subagent-driven development** — a fresh implementer per task, each
  gated by an independent spec-compliance review *and* a code-quality review (every review
  re-verified the work rather than trusting the report), plus a final whole-Phase-2 integration
  review. **The book now reads itself aloud in Kokoro's voice with the spoken sentence highlighted.**
  - **The voice is real and offline.** Kokoro-82M (`kokoro-js` + `onnxruntime-node`, **CPU**) runs
    in an Electron **`utilityProcess`** (off the main thread — ORT inference is synchronous and would
    jank the UI). The model is **bundled** and loaded with `allowRemoteModels=false`; **no network at
    runtime** (verified down to the kokoro-js voice loader, which reads bundled `voices/*.bin` via
    `fs` in Node — the Hugging Face fetch branch is unreachable in the Node build). Default voice
    **`af_heart`** (Grade-A); the user listened to a sample and approved it.
  - **One clip per sentence (design §4).** `src/renderer/reading-cursor.js` (pure) walks the
    sentence sequence; `src/renderer/player.js` (dependency-injected controller) plays clip *N*,
    highlights it, advances on clip-end, prefetches the next 2, and rewinds by replaying earlier
    clips. No alignment/timestamps. A content-addressed **on-disk clip cache** (`src/main/clip-cache.js`,
    `userData/clips`, atomic write) makes rewind/re-read instant (~250× faster on a hit, measured).
  - **Controls:** Play/Pause (Space), back-a-sentence, back-a-paragraph, forward-a-sentence/paragraph,
    **click any sentence to start there**. Highlight rides ~¾ up in scroll mode and flips pages in
    paged modes. Reads across chapter boundaries automatically (mounts the next chapter first) and
    stops cleanly at book end (the play button resets).
  - **Voice-agnostic seam:** the renderer only calls `reader.synthesize(text, {voice})` over IPC —
    swapping to a premium cloud voice later = editing only `src/main/tts-service.js`.
  - **Independently re-verified by the planner:**
    - `npm test` → **52/52 green** (31 inherited + new pure-logic tests: `reading-cursor`,
      `clip-cache`, `player` — incl. tests that *pin* the stale-clip-end token guard, the
      synth-failure stop-and-retry, and the bounded clip cache).
    - `npm run smoke` → **PASS**, including a new assertion that drives the **real engine**
      (click Play → real synth → IPC → decode → play → `.is-reading` appears → **advances** to the
      next sentence).
    - **Packaged offline synth proven:** built `dist/Reader-0.1.0-portable.exe`; launched
      `win-unpacked/Reader.exe` via Playwright and `reader.synthesize` returned a valid WAV
      (201,644 bytes @ 24 kHz) with the model loaded from `resources/assets/models` and the native
      `.node` from `app.asar.unpacked` — i.e. the bundled-model + unpacked-binary path resolves in
      the package.
  - **Honest caveats / what's still manual:** (a) **voice quality + true network-off** is a human
    check — the engine is *proven* offline-capable (code forbids network; packaged synth works), but
    physically toggling the adapter off and *listening* to all 7 books is the user's gate (checklist
    in [`../HOW-TO-RUN.md`](../HOW-TO-RUN.md)). (b) **macOS still unbuilt** (Phase 1 carryover). (c)
    `goToPageContaining` paged-mode flip was not live-verified (deferred to manual testing — code
    unchanged; the HANDOFF pre-fragmentation-offset caveat still stands if a flip lands wrong).
- [x] Phase 2.5 plan written & approved (2026-06-27):
  [`plans/phase-2.5-voice-settings.md`](./plans/phase-2.5-voice-settings.md) — voice picker (+preview),
  reading speed, end-of-chapter pause; global, persisted. Brainstormed + scoped with the user.
- [x] **Phase 2.5 — Voice & playback settings: built & planner-verified (2026-06-27, Windows).**
  Built by a fresh Opus 4.8 builder session (6 commits, `7d07463` → `e61db64`); planning session
  **independently re-verified every claim** — re-ran the tests/smoke and read the diffs, not taken on
  "looks good." **The narrator's voice, reading speed, and an end-of-chapter pause are now in the "Aa"
  comfort popover, global and persisted.** The default user sees no change (`af_heart` / `1.0×` / pause
  `off`) until they touch a control.
  - **What shipped:** a grouped **US/UK voice picker** (8 curated voices, each with a **▶ preview**),
    a **reading-speed** slider (0.7–1.5×, applies on release, live label), and an **end-of-chapter
    pause** (Off / Short 1.5s / Longer 4s). A voice/speed change **restarts the current sentence
    immediately** via the player's new `reload()` (flush in-memory prefetch + replay current sentence);
    pause only affects the *next* chapter crossing.
  - **The voice-agnostic seam held:** the only widening is `reader.synthesize(text, {voice})` →
    `{voice, speed}`. No engine swap, no new IPC surface (preload already spread `opts`; that diff is
    comment-only). Offline/CPU/utilityProcess and the per-sentence `.is-reading` DOM contract are
    untouched.
  - **Cache stays correct under multiple voices/speeds:** `clipKey(text, voice, speed)` =
    `sha1("<voice> <speed> <text>")`; `get`/`put`/the `synthesize` IPC handler all thread `speed`.
    Each (voice, speed, text) caches independently — **switching never wipes the others**; rewind stays
    instant. Kokoro `generate` gets `speed` (clamped 0.5–2 defensively).
  - **Independently re-verified by the planner:**
    - `npm test` → **56/56 green** (re-run here; the 52 inherited + 4 new: `reload()` restarts/flushes
      when playing and only-flushes when paused; the end-of-chapter beat **defers** a cross-chapter
      advance and is **cancelable** via the token guard, using node `mock.timers`).
    - `npm run smoke` → **PASS** (re-run here, exit 0): a mid-narration voice switch to `bm_george`
      **keeps narration playing** and marks the new voice active; **▶ preview** writes the exact
      `af_bella` clip to disk through the **real** engine (full IPC→synth→cache, voice-specific via
      `clipKey`); and **voice/speed/pause persist across a real restart** (`bm_george` / `1.25×` /
      `longer` all restored, label `1.25×`).
    - **All 8 curated voice IDs verified present** in the shipped kokoro-js voices
      (`node_modules/kokoro-js/voices/*.bin`): `af_heart`, `af_bella`, `am_michael`, `am_fenrir`,
      `bf_emma`, `bf_isabella`, `bm_george`, `bm_fable`. Coder-reported grades: `af_heart` (A),
      `af_bella` (A−), `bf_emma` (B−); **US male voices top out at C+** (`am_michael`/`am_fenrir`) —
      worth an ear check.
  - **Two plan deviations (test scaffolding only; production code is byte-for-byte the plan) — both
    accepted as equivalent-or-stronger:** (a) the pause unit tests flush with `setImmediate`, not the
    plan's `setTimeout`-based `tick()` — *required*, since a `setTimeout`-based flush can't resolve
    while `setTimeout` is mocked; plus one extra `endCurrent()` because the shared test doc advances
    `0.0.0→0.0.1→0.1.0→1.0.0` (three steps before the chapter crossing). (b) the smoke's voice check
    asserts the **on-disk clip artifact** instead of a synth-spy — `window.reader` is a frozen
    contextBridge object that can't be spied, and the artifact check proves the *whole* path.
  - **Honest caveats / still manual:** (a) **audible** voice quality, that speed *sounds* faster, and
    that the pause beats *feel* right are ears-only — checklist appended to
    [`../HOW-TO-RUN.md`](../HOW-TO-RUN.md). (b) Cosmetic: a code comment + the coder report say "28
    voices total" but the dir ships **54** `.bin` files — harmless, all 8 curated IDs confirmed present.
    (c) macOS still unbuilt (Phase 1 carryover). (d) **The user runs the packaged `.exe`, not `npm
    start`** — renderer changes don't appear until a rebuild. `dist/Reader-0.1.0-portable.exe` was
    rebuilt this session (confirmed). **⚠️ Any `.exe` copies the user keeps on Desktop/USB are still
    the old build and must be replaced with the fresh `dist/` one.**
- [x] **Phase 2.6 brainstormed, designed & planned (2026-06-27).** User ran the Windows build, liked
  the voice, and gave five UI/parse notes + a GPU question. Brainstormed and decided with the user;
  three planning docs written:
  - [`plans/2026-06-27-ui-polish-and-headings-design.md`](./plans/2026-06-27-ui-polish-and-headings-design.md)
    — the decisions/why.
  - [`plans/phase-2.6-ui-polish-headings.md`](./plans/phase-2.6-ui-polish-headings.md) — builder plan:
    (1) remove the Electron menu bar; (2) split the comfort popover into **Comfort** + **Voice**;
    (3) **inline-SVG** transport icons (kill the colored-emoji "blue" ⏮/⏸); (4) **circular** play
    button; (5) **read headings** — parser keeps headings inline as `{heading, sentences}`, renderer
    emits styled `<hN>` with sentence spans (narrated + highlighted), TOC title becomes metadata-only
    (Chapters panel + strip, no injected duplicate), chapters with no heading fall back to the TOC
    title rendered+read. **Ready for a fresh builder; not built yet.**
  - [`plans/spike-voice-latency.md`](./plans/spike-voice-latency.md) — an **investigation** (not a
    feature): measure where the synth delay is, try the cheap no-divergence wins (launch warm-up,
    wider prefetch, larger clip cap), and probe whether `onnxruntime-node` can use the user's NVIDIA
    GPU + the real speedup. **Output = numbers + a recommendation; no GPU code ships from the spike.**
    Decided deliberately because GPU **overrides the logged CPU-only decision**.
- [x] **Voice-latency spike — run & findings recorded (2026-06-27, Windows; builder-reported).** A
  fresh Opus 4.8 session ran [`plans/spike-voice-latency.md`](./plans/spike-voice-latency.md) on branch
  `spike/voice-latency` (nothing shipped). Full numbers + tables:
  [`plans/spike-voice-latency-findings.md`](./plans/spike-voice-latency-findings.md). Headlines:
  - **Dominant cost = one uncached single-sentence synth** (~1.7 s median; ~0.5 s short, ~3–4 s long).
    Cache hits (2 ms), decode (5 ms), DOM mount/paginate (6 ms), even cold load (~1.45 s, hidden behind
    book-open) are all negligible. Continuous play never stutters (0.41× realtime keeps ahead); only
    **discontinuous jumps to a cold sentence** are felt — confirms the brief's hypothesis.
  - **🔑 The shipping `q8` dtype is the slowest option (planner-verified — re-ran the sweep here).** q8
    (~1.9 s median) is the sole outlier; **fp16/q4/q4f16/fp32 are all ~4× faster** (~0.5 s) — int8
    dequant overhead outweighs its benefit on this CPU. **Dropping q8 cuts the dominant cost ~4×,
    CPU-only, zero per-OS divergence.** This is the spike's highest-value result. **Gated, not landed:**
    the numbers are Windows-x64/fast-desktop; **the user's primary device is the MacBook Pro M5 (ARM),
    which the spike never touched** — so the win is *unvalidated on the actual target*. Also +70 MB
    bundle + a re-run of the packaged-offline gate. → scoped as a follow-up (see Next up), M5
    measurement is the **gate**.
  - **GPU is a dead end on this stack** (see Decisions log). DirectML loads Kokoro then **fails at the
    vocoder's ConvTranspose** on first inference; CUDA isn't in the prebuilt Node binding; CoreML is a
    separate Mac backend. **No working GPU path, no measured speedup** — strengthens the CPU-only call.
  - **Part B:** launch warm-up is **already wired** (`main.js:159`); wider prefetch (ahead 3 + behind 1)
    makes back-a-sentence an instant 2 ms hit; clip cap 24→48 is a marginal rewind win. **Both landed on
    master (cherry-picked `85da182`, `a525940`; 68/68 unit tests green here after the pick).** They polish
    rewind/continuous play but **cannot close the dominant felt gap** (an arbitrary cold jump still pays
    one synth) — only faster synth (dtype) does.
- [x] **Phase 2.6 — UI polish & heading reading: built & planner-verified (2026-06-27, Windows).**
  Built by a fresh Opus 4.8 builder (8 commits, `4dca458` → `68a0cb0`); planning session
  **independently re-verified** — re-ran the suites here and read the diffs, not taken on "looks good."
  - **What shipped:** (1) the default Electron **menu bar is gone** (`Menu.setApplicationMenu(null)`);
    (2) the comfort popover is **split into mutually-exclusive Comfort (Aa) + Voice panels** (inner
    control ids unchanged; Esc/outside-click close); (3) **inline-SVG transport icons** in
    `currentColor` (kills the colored-emoji glyphs; play/pause toggles via an `.is-playing` class, not
    `textContent`); (4) a **circular** play button; (5) **the narrator reads headings** — the parser
    keeps headings as `{heading, sentences}` paragraphs in reading order, the TOC title is
    **metadata-only** (`navTitles.get(href) ‖ firstHeadingText ‖ null`, never injected), one synthetic
    `heading:2` is added **only** when a chapter has no heading of its own, and the renderer emits
    `<hN class="chapter-heading">` wrapping the same per-sentence spans (narrated + highlighted).
  - **Independently re-verified by the planner:**
    - `npm test` → **68/68 green** (re-run here; 56 inherited + 8 Phase 2.6 + 4 from the bug fixes
      below). Heading render + parser tests were written failing-first (TDD).
    - `npm run smoke` → **PASS** (re-run here): the **first narrated span is `0.0.0` — the heading
      itself** (headings spoken, in order), narration advances `0.0.0 → 0.1.0` through the real engine,
      the popover split works, and no chapter-title is injected onto the page.
  - **Accepted caveat now live (by design, design.md):** Gutenberg front-matter boilerplate ("The
    Project Gutenberg eBook of…") is now read as a heading — **confirmed in the smoke output**. Low
    impact.
  - **AC split (coder's honest accounting, accepted):** test-verified — AC2 (popovers + persistence),
    AC5 (heading narratable, no injected title), AC6 (no regression), AC3 `.is-playing` toggle.
    **Human eye/ear still owes:** AC1 menu absence (one code line), AC3 icon crispness/monochrome,
    AC4 the circle, theme contrast, and voice quality.
- [x] **Two bugs from user testing root-caused & fixed (2026-06-27, Windows).** User ran the build and
  reported three things; the builder used systematic-debugging, reproduced both real bugs with
  failing-first unit tests, then fixed. Planner re-verified the diffs + suites.
  - **`89a8db1` — audio glitching on `. . .` (spaced ellipsis).** The splitter treated a period with
    whitespace before it as a boundary, emitting a lone `"."` sentence per dot → each synthesized as an
    audible click. **Fix:** a dot with no word char before it (`word === ''`) is never a boundary.
    (Unicode `…` and run-together `...` were already correct.)
  - **`4f04141` — page flips forward then snaps back when skipping (single/two-page only).**
    `pageForOffset` used `Math.round`; a span in the back ~40% of a column rounded up to the next page,
    so a skip flipped to a wrong/empty page then snapped back on the next clip. **Fix:** `round → floor`
    (a span at `offsetLeft` sits in column `floor(offsetLeft/pitch)` since `colWidth < pitch`). Scroll
    mode was always fine (`scrollIntoView`). **Note:** this is a different function from the page-*count*
    stride math (which still uses `round`/`ceil` per the existing gotcha) — don't conflate them.
  - **Third report — flat question intonation: not a bug.** The `?` reaches the engine intact; weak
    interrogative prosody is a **Kokoro model characteristic**. Changing it would mean a new TTS engine
    (touches the logged CPU/offline decision) — left alone.
  - Both fixes are **by-ear / by-eye in the end** — worth a quick confirm in the flagged passage, but
    the root causes are solid and pinned by tests. **Exe rebuilt with both fixes (today 18:16).**
- [x] **Phase 3 — Library + auto-resume: built & planner-verified (2026-06-28, Windows; branch
  `phase-3-library`).** Built by a fresh Sonnet 4.6 builder (7 feature commits, `ed730db` → `784cfbc`);
  planning session **independently re-verified** — re-ran the suites here, read every diff, extracted the
  packaged asar, **not taken on "looks good."** **The reader is now a library: a bookshelf home where you
  add EPUBs, each remembered with its cover and the exact sentence you stopped on, reopening right there.**
  - **What shipped:** `lastAddress()` (pure, for finished-detection); `coverImage()` + `parseOpf` `coverId`
    (EPUB3 `properties=cover-image` + EPUB2 `<meta name=cover>`); **`src/main/library.js`** — JSON index +
    per-book folders under `userData/library/books/<sha256>/` (copied original + `document.json` + cover),
    **idempotent-by-hash preserving progress**, **reopen-finished-restarts** reset, derived active/finished
    split (`progress === lastAddress`); library IPC (list/shelf/add/open/remove/updateProgress + **sync**
    flush + coverDataUrl + `pick-file-bytes`); a **bookshelf view** (`library-view.js`, cover tiles with a
    deterministic-color **title-card fallback**, active/finished shelves, per-book remove); shell wiring
    (shelf-as-home, add→store→open, **← Library**, `player.showAt()` = seek-without-autoplay); and
    **auto-resume** — progress captured at `view.show(addr)`, debounced 1.5 s, flushed on pause/book-end,
    and a **synchronous** IPC on `beforeunload` to beat the Electron teardown race.
  - **Independently re-verified by the planner:**
    - `npm test` → **82/82 green** (re-run here; 68 inherited + 14 Phase 3: `lastAddress`, cover/`coverId`,
      the 8 `library.js` cases incl. idempotent-preserves-progress + finished-reset + shelf-split, and
      `player.showAt`). TDD: tests written failing-first per the plan.
    - `npm run smoke` → **SMOKE OK** (re-run here, exit 0): all **12** assertions incl. open-to-shelf →
      drag-drop add → click-open → **auto-resume to the advanced sentence (0.1.0, not 0.0.0)** → remove →
      finished-section move → finished-reopen **restart (0.0.0)** → **persistence across a real relaunch**.
      Prior Phase 2/2.5/2.6 assertions preserved (comfort persistence now reopens the book via the shelf).
    - **The resume-page accuracy guard is real, not a false-green:** the smoke asserts the `.is-reading`
      span is *within the viewport rect*, and I confirmed step 7f runs in **single-page** mode (HTML default
      `data-view="single"`, fresh user-data-dir, before §8 sets `view=two`) — so it's a genuine page-flip
      test, not a scroll-mode freebie (which would pass trivially).
    - **Package gate:** `dist:win` built today (portable `.exe` 13:52, `win-unpacked` 13:51); **both
      `library.js` and `library-view.js` confirmed in `app.asar`**; and the **packaged `app.js` is
      byte-identical to verified HEAD** (extracted the asar and diffed — only line endings differ). The
      shipped exe matches what was verified; **no rebuild needed.**
  - **⚠️ Critical issue the builder left, fixed by the planner:** a prior AI-assisted edit had replaced **7
    straight-quote string delimiters in `app.js` with curly quotes (U+2018/2019)** — the renderer script
    failed to parse, so **a clean checkout of the builder's HEAD would not load the app at all.** The
    builder fixed it in the working tree **but never committed the fix**, leaving the branch tip broken with
    the repair (plus the two-step shelf render) uncommitted. The planning session committed the verified
    working tree so **HEAD now equals the verified state** — `8a83302` (smart-quote repair + two-step
    render) and `e6b9ff2` (Task 8 smoke, which also never landed). The broken commit stays in history (clean
    fix-on-top; no rebase). This is *planner committing the builder's own verified fix to repair HEAD* —
    separation-of-duties (builders don't edit planning docs) is intact.
  - **Honest caveats / still manual:** (a) **Add-button path: smoke can't drive it, but the USER
    manually tested it — works (2026-06-28).** `pick-file-bytes` is code-complete and Playwright can't
    drive the native OS file dialog, so the *smoke* exercises only drag-drop — but the user added books via
    the Add button and confirmed real **cover extraction on their own commercial EPUBs** (Dragonflight,
    Recursion) onto the active "Reading" shelf. AC2 now satisfied both ways. (b) Cosmetic: a duplicated
    comment block in the smoke (harmless). (c) Two pre-existing
    Phase 2 manual harnesses (`test/manual/verify-{packaged,synthesize}.js`) remain untracked — not Phase 3.
    (d) **Branch `phase-3-library` is verified but NOT merged to `main`** — left for the user (merge decision
    + the listen/by-eye gates below are still open). (e) macOS still unbuilt (Phase 1 carryover).
- [x] **Phase 4 (part 1) — Markdown reading: built & planner-verified (2026-06-28, Windows; branch
  `phase-4-markdown`).** Built by a Sonnet 4.6 builder (8 feature/fix commits, `832599c` → `556a58d`);
  planning session **independently re-verified** — re-ran the full unit suite, **machine-ran the smoke
  (which the builder couldn't), read every diff, and listed the packaged asar — not taken on "looks
  good."** **The user can now drop a `.md`/`.markdown` draft onto the shelf and listen to it with the
  same chapters/headings/highlight/resume/finished/remove as an EPUB — via the existing reader, zero new
  reader logic.**
  - **What shipped:** `src/parse/markdown.js` — pure `parseMarkdown(buffer, fileName)`: `marked`→HTML→
    **reuses the EPUB `htmlToBlocks`** + the Phase 2.6 `{heading?, sentences}` model, with one new
    **top-most-heading chapter split** (smallest `#` level present; no-heading file → one chapter; leading
    pre-heading content → an untitled chapter); strips a leading YAML frontmatter block; title falls back
    filename→"Untitled". `src/parse/index.js` — a tiny **format dispatcher** (`parseDocument`/`extractCover`
    by extension; unsupported → throws `Unsupported file type` → existing "Couldn't open that file" card).
    `library.js` swapped to the dispatcher (passes `fileName` through); `main.js` picker + both empty-state
    copies accept `.md`/`.markdown`. **No reader/IPC/`document.json` changes** — same `Document` shape, so
    resume/finished/remove/persist come free. `.md` has no embedded cover → the Phase 3 **title-card**
    fallback (no new cover code).
  - **TTS fixes (apply to EPUB + Markdown equally), `34acf73`→`556a58d`:** `#N`→"number N"; ALL-CAPS words
    lowercased at **synthesis time only** (display unchanged; dotted `F.B.I.` left alone) — moved out of
    parse-time into a new `src/main/tts-normalize.js`. **Normalization now runs before the clip-cache key
    is computed** (`main.js` `synthesize` handler: `get`/synth/`put` all key on the normalized text), so
    old mispronounced clips become cold misses and are re-synthesized correctly — **verified by reading the
    diff**: the duplicate `normalizeTTS` was removed from `tts-service.js` (no double-normalization).
  - **Independently re-verified by the planner:**
    - `npm test` → **100/100 green** (re-run here; 82 inherited + markdown 7 + dispatch 5 + library 1 +
      tts-normalize 5). The markdown/dispatch tests are pure (inline strings, no fixture dependence).
    - `npm run smoke` → **SMOKE OK** (re-run here, exit 0) — **now machine-run, closing the builder's main
      caveat.** All prior assertions intact **plus** the new markdown line: drop `sample.md` → opens to the
      reader → **first narratable span is the heading `0.0.0`** → narration advances through the **real
      engine** → back on the shelf the tile is a **title-card, not an `<img>`**.
    - **Package gate:** `dist/win-unpacked/resources/app.asar` (mtime 19:21, matching the tip commit)
      contains `src/parse/markdown.js`, `src/parse/index.js`, `src/main/tts-normalize.js`, and
      `node_modules/marked/lib/marked.cjs` — confirmed via `asar list`.
  - **Honest caveats / still manual:** (a) **voice quality on real prose is ears-only** — not assertable by
    Playwright; the user should listen to one of their own drafts. (b) **Add-button path** for `.md` is
    code-complete but smoke can't drive the native dialog (same as EPUB; drag-drop is the automated path).
    (c) Cosmetic: the stored copy of a `.md` is still written as `original.epub` in its book folder
    (`library.js` hardcodes that name) — harmless (it's a hash-keyed copy, never re-parsed by name), but
    rename if it ever matters. (d) Known minor edge (left alone per plan): deeply **nested** Markdown lists
    can double-extract — shared with the EPUB `htmlToBlocks` path; don't patch it (regresses EPUB). Flat
    lists fine. (e) **Branch `phase-4-markdown` is verified but NOT merged to `master`** — left for the
    user. (f) macOS still unbuilt (Phase 1 carryover).
- [x] **Phase 4 (part 2) — DOCX reading: built & planner-verified (2026-06-29, Windows; branch
  `phase-4-docx`).** Built by a fresh builder (7 commits, `67b3ea8` → `b9ecbe0`, off `master`); planning
  session **independently re-verified** — re-ran the full unit suite, **machine-ran the smoke on the real
  Electron runtime, read every diff, and listed the packaged asar — not taken on "looks good."** **The user
  can now drop a Word `.docx` draft onto the shelf and listen to it exactly like an EPUB/Markdown book —
  chapters from Heading styles, headings read aloud, sentence highlight, auto-resume, title-card on the
  shelf — via the existing reader, zero new reader/IPC/library/schema code.**
  - **What shipped:** `src/parse/docx.js` — `parseDocx(buffer, fileName)`: **mammoth** (pure-JS) converts
    `.docx`→HTML (Word Heading 1–6 styles → `<h1–h6>` via mammoth's default style map — no `styles.xml`
    needed; the plan's fallback was never required), reuses the EPUB `htmlToBlocks`, then the new shared
    helper. `src/parse/blocks-to-chapters.js` — **`blocksToChapters` extracted from `markdown.js`**
    (format-agnostic: top-most-heading split, `{heading?, sentences}`, leading-content → untitled chapter,
    title = first top-level heading ‖ filename ‖ "Untitled"); **`markdown.js` now delegates to it** (the
    Markdown tests are the regression net). `src/parse/index.js` dispatches `.docx`→`parseDocx`; `main.js`
    both picker filters + `index.html` both empty-state copies accept Word files. `.docx` only (not legacy
    `.doc`); no cover → Phase 3 **title-card** fallback. Same `Document` shape → resume/finished/remove/persist
    come free.
  - **Independently re-verified by the planner:**
    - `npm test` → **113/113 green** (re-run here; 103 inherited + `blocks-to-chapters` 6 + `docx` 2 +
      `parse-dispatch` 2). The extract is **behavior-preserving** — `markdown.test.js` stays 7/7 and the new
      helper tests pin smallest-heading split, no-heading→one-chapter, leading-content, title fallback, and
      empty-block drop.
    - `npm run smoke` → **SMOKE OK** (re-run here on the real Electron runtime, exit 0) — all prior
      EPUB+Markdown assertions intact **plus** the new line: drop `sample.docx` → opens to the reader →
      **first narratable span is the heading `0.0.0`** → narration advances through the **real engine** →
      back on the shelf the tile is a **title-card, not an `<img>`**.
    - **Package gate:** `npm run dist:win` built (portable `.exe` + `win-unpacked`, asar mtime 12:25);
      `asar list` confirms `src\parse\docx.js`, `src\parse\blocks-to-chapters.js`, `src\parse\index.js`,
      `src\parse\markdown.js`, and the **mammoth subtree (198 entries)** all ship — and **0 `.node` files in
      mammoth** → pure-JS, no `asarUnpack` needed (unlike onnxruntime).
  - **Honest caveats / still manual:** (a) **voice quality on a real `.docx` draft is ears-only** — the
    user should listen to one of their own Word drafts. (b) **Add-button native dialog** can't be
    smoke-driven (OS dialog); the picker-filter change is code-only — drag-drop is the automated path. (c)
    resume/finished/remove/persist for a docx book are covered **structurally** (identical `Document` shape,
    zero new reader/library code) rather than re-tested docx-specifically — by design. (d) the stored copy
    of a `.docx` is still written as `original.epub` in its hash-keyed book folder (`library.js` hardcodes
    that name) — harmless, same as Markdown. (e) **Branch `phase-4-docx` is verified but NOT merged to
    `master`** — left for the user. (f) macOS still unbuilt (Phase 1 carryover).
  - **Pre-existing npm advisories (builder follow-up note, accepted):** the 10 high-severity advisories npm
    reports are **NOT from mammoth** (its subtree — jszip/xmlbuilder/lop — is clean) — they're pre-existing
    in `electron` (≤39.8.4) and `tar` (via electron-builder). The only fixes are `--force` breaking majors
    that change the runtime/packager under the whole app → a dedicated branch with its own smoke + manual
    verification, not folded into this feature. Left untouched here.

---

## Next up

**Phases 2, 2.5, and 2.6 are built & planner-verified on Windows (Phase 2.6 also picked up two
user-reported bug fixes). The voice-latency spike has been run; findings recorded (GPU = dead end; the
CPU dtype is the real lever). Two near-term decisions below (Part B landing + dtype follow-up), then
human-ears/eyes confirmation and Phase 3 — all on Windows. **macOS is deliberately deferred until the
Windows version is finished** (user decision 2026-06-27) — don't start the Mac build before then.**

1. **✅ Part B landed (done 2026-06-27).** The two low-risk CPU-only spike commits are cherry-picked to
   master — `85da182` (prefetch ahead 3 + behind 1 → instant back-a-sentence) and `a525940` (clip cap
   24→48); 68/68 unit tests green after the pick. The throwaway harnesses stay off master except
   `test/manual/spike-dtype-sweep.js` (kept for the dtype follow-up). **The shipped `.exe` will reflect
   these only after a rebuild** (`npm run dist:win`) — do that before the next user listen-test.
2. **Dtype follow-up — validate on the M5, then maybe swap (own small phase). HIGH VALUE.** Plan ready:
   [`plans/dtype-validate-and-swap.md`](./plans/dtype-validate-and-swap.md). The spike's biggest find:
   `q8` is ~4× slower than fp16/q4/q4f16 on CPU (planner-verified on Windows; see findings). **The catch:
   all numbers are Windows x64, but the user's *primary* device is the MacBook Pro M5 (ARM), which the
   spike never measured.** The plan gates the swap on running `test/manual/spike-dtype-sweep.js` **on the
   M5** (does the ~4× hold on ARM?); if it doesn't, keep `q8`. If it does: change two lines
   (`tts-service.js`, `fetch-model.js`), eat **+70 MB** bundle, **bust the clip-cache key** (it lacks
   dtype), and re-run the **packaged-offline gate**. CPU-only → consistent with the logged decision.
   **No GPU.**
3. **User: listen + confirm (Phases 2, 2.5, 2.6 + Part B rewind).** Run the **fresh** packaged `.exe`
   (rebuilt today **19:11** — now includes the two bug fixes **and** the Part B prefetch/clip-cap wins;
   not an old Desktop/USB copy; rebuild with `npm run dist:win` if unsure), drag in your books, press
   Space, and walk the manual checklists in
   [`../HOW-TO-RUN.md`](../HOW-TO-RUN.md):
   - **Phase 2:** voice/sync, ¾-up scroll, rewind controls, cross-chapter, instant 2nd play, and
     **network-off in the packaged `.exe`**.
   - **Phase 2.5:** each curated voice via ▶ preview (esp. the US male voices, graded C+); picking a
     voice restarts the current sentence in it; the speed slider changes pace and restarts on release;
     the end-of-chapter pause waits the beat (and pausing during the beat cancels it).
   - **Phase 2.6:** no menu bar; Comfort/Voice popovers split cleanly; transport icons are crisp
     monochrome; play button is a clean circle; **headings are read aloud + highlighted**; and the two
     fixes — **`. . .` no longer glitches** and **skipping doesn't flip-then-snap-back** in
     single/two-page mode.
   (Mechanism is smoke-proven; only the *listening* / *by-eye* / *adapter-off* gestures can't be automated.)
4. **✅ Phase 3 — Library + auto-resume: BUILT, planner-verified & MERGED to `master`
   (2026-06-28; see "What's done").** 82/82 unit + 12 smoke green, package gate passed; merged via clean
   fast-forward and `phase-3-library` deleted (82/82 re-verified on the merged `master`). **Remaining
   user action:** a listen/by-eye confirm — **Add button + real cover extraction already confirmed by the
   user** on their own EPUBs (Dragonflight, Recursion). Still worth a pass on: click-to-resume lands on
   the right sentence *and page*, a finished book moves to **Finished** then restarts on reopen, remove
   works, and progress survives a quit+relaunch. (The shipped `dist/Reader-0.1.0-portable.exe` from
   2026-06-28 13:52 already contains the merged code.)
5. **✅ Phase 4 (part 1) — Markdown reading: BUILT, planner-verified & MERGED to `master`
   (2026-06-28).** 100/100 unit + smoke (machine-run) green, package gate passed; merged via clean
   fast-forward (`447b7b1` tip) and `phase-4-markdown` deleted. See the "What's done" Phase 4 entry above.
   **Remaining user action:** a listen-pass on a real `.md` draft (voice quality is ears-only).
   Still-deferred Phase 4 items: **pronunciation overrides** and **DOCX**.
6. **✅ Launch-speed: onnxruntime-node binary trim landed & verified (2026-06-28; `447b7b1`).** The
   portable `.exe` was slow to open because it self-extracts its payload on every cold launch, and
   `onnxruntime-node` shipped ~208 MB of all-platform native binaries (only the Win-x64 CPU one runs).
   Trimmed to the target binary → **`app.asar.unpacked` 231 MB → 39 MB** (~192 MB less to extract/scan
   per launch); offline-synth gate re-passed (`201644 bytes @ 24000 Hz`). See the onnxruntime gotcha for
   the exact `files` excludes. **Fresh `dist/Reader-0.1.0-portable.exe` rebuilt 2026-06-28 20:34 with the
   trim — replace any old Desktop/USB copies.** **Root cause not fully closed:** `portable` still
   re-extracts each launch; the structural fix (→ **NSIS installer**) is **deferred by user decision
   (2026-06-28)** — revisit only if launch still feels slow.
7. **✅ Voice variety: picker expanded 8 → ~22 English voices (2026-06-28; `7102f3d`).** User wanted
   more timbres. Restructured `VOICES` (`app.js`) into 4 groups (US/UK × Female/Male), best-first, **★ on
   the A/B standouts** (Heart, Bella, Nicole, Emma); `.voice-list` is now scrollable (`max-height:50vh`).
   English-only (non-English Kokoro voices mispronounce English); D/F-grade voices excluded. **Data + CSS
   only** — all 54 voices already ship bundled; cache/preview/persistence are already per-voice. New
   `test/unit/voices.test.js` asserts every curated id has a bundled `.bin`. 103/103 unit + smoke green.
   Design: [`plans/2026-06-28-voice-variety-design.md`](./plans/2026-06-28-voice-variety-design.md).
   **Remaining user action:** a **listen-pass** — which new C-grade voices actually sound good is
   ears-only (★s + best-first order + ▶ preview are the affordances). **Fresh
   `dist/Reader-0.1.0-portable.exe` rebuilt 2026-06-28 20:49** (packaged `app.js` confirmed to carry all
   22 ids) — replace old copies. *(US male is only 3 voices — an inherent Kokoro limit, recorded in the
   design.)*
8. **✅ Phase 4 (part 2) — DOCX reading: BUILT & planner-verified (2026-06-29; branch `phase-4-docx`,
   NOT merged).** 113/113 unit + smoke (machine-run) green, package gate passed (mammoth 198 entries, 0
   native binaries). See the "What's done" Phase 4 (part 2) entry above. **Remaining user action:** merge
   `phase-4-docx` → `master` + a listen-pass on a real `.docx` draft (voice quality is ears-only). The
   original planning docs (for reference):
   - [`plans/2026-06-28-docx-reading-design.md`](./plans/2026-06-28-docx-reading-design.md) — the
     decisions/why. **mammoth** (pure-JS) converts `.docx`→HTML, Word Heading 1–6 styles → `<h1–h6>`;
     reuse `htmlToBlocks`; **extract a shared `blocksToChapters` helper** from `markdown.js` that both
     parsers call; no cover → title-card; no reader/IPC/library changes (same `Document` shape, so
     resume/finished/remove/persist come free). `.docx` only (not legacy `.doc`); `core.xml` title
     deferred.
   - [`plans/phase-4-docx.md`](./plans/phase-4-docx.md) — the builder plan (8 tasks, TDD): add mammoth;
     extract+refactor `blocksToChapters` (Markdown tests are the regression net); a generated
     `sample.docx` fixture (script self-checks mammoth emits `<h1>`); `parseDocx`; dispatcher route;
     picker/copy; smoke line; package gate. Baseline **103 tests**; target ~113. **Hand to a fresh
     builder (Sonnet 4.6) on branch `phase-4-docx`.**
   - **Other still-open candidates** (all Windows; macOS still deferred): the **dtype follow-up** (HIGH
     VALUE latency win, plan ready, gated on an M5 measurement); **pronunciation overrides** (the other
     logged Phase 4 item); app **rename** (open question below); an NSIS installer if the launch trim
     wasn't enough.
9. **Only after the Windows version is finished: the macOS build** (deferred by user decision
   2026-06-27 — don't start it before then). On the M5 run `npm install` then `npm run dist:mac`,
   right-click→Open, drag in an EPUB, press Play. `onnxruntime-node` pulls the arm64 binary at
   `npm install`; the build lands the model at `Reader.app/Contents/Resources/assets/models` (matches
   `main.js`). **Note:** a *notarized* mac build must code-sign the unpacked `.node` or Gatekeeper
   blocks launch — out of scope, but a *loud* failure. Closes the last Phase 1 carryover.

> **Carry into Phase 3 (deferred items, by design):** per-book reading-position resume and **per-book
> voice/speed memory** (the clip cache is global/content-addressed today, now keyed by voice+speed —
> Phase 3 may add per-book folders); the in-memory clip cache cap is **48** (`player.js` `maxClips`,
> raised from 24 by the spike's Part B) — fine, revisit if needed. **Phase 4** is now being split:
> **part 1 = Markdown reading (builder working now)**; still owned/deferred under Phase 4 are
> **pronunciation overrides** and **DOCX**.
> (Voice-picker UI, reading-speed, and end-of-chapter pause were pulled forward into Phase 2.5 — done.
> The user's *selection* now flows from `state.voice`; but the **default-fallback literal `'af_heart'`
> still appears in ~4 files** (`clip-cache.js`, `tts-service.js`, `main.js`, `app.js`) as defensive
> defaults — fine, but changing the *default* voice means touching all of them, so centralize that
> literal if it ever becomes a real setting.) Also note:
> **manual nav while narrating is "voice leads"** — a TOC/keyboard jump is
> overridden by the next clip's `view.show`; confirm that's the desired UX or revisit in Phase 3/4.

---

## Decisions log (so they're not re-litigated)

- Local neural voice (Kokoro), not cloud — free/offline/private. Cloud premium voice deferred.
- Sentence-level highlighting (not word-level) → per-sentence clips → no alignment needed.
- Electron (not Tauri) → simplest path to all-JS, double-clickable, cross-platform.
- CPU (not GPU) → identical behavior on Win/Mac; model is fast enough **on the right dtype** (the
  spike found `q8` is a ~4× slow outlier — "fast enough" assumes fp16/q4f16; see findings + Next up).
- **GPU is a dead end on this stack — do not revisit (spike-found, builder-reported 2026-06-27; the
  planner re-ran the dtype sweep but not the GPU probe).** The user asked about
  running Kokoro on the NVIDIA GPU; the spike proved there is no working path: `onnxruntime-node`'s
  prebuilt Node binding ships only CPU + DirectML (no CUDA); **DirectML loads Kokoro then fails at the
  vocoder's ConvTranspose on first inference**; CoreML would be a separate Mac backend. Every GPU option
  is a new per-OS backend with a mandatory CPU-fallback, for **zero measured speedup** here. The lever is
  the CPU dtype, not the device. This **confirms** the CPU-only decision above.
- Library with covers + auto-resume from the start (Phase 3). Bookmarks/notes deferred.
- PDF out of scope.
- Three reading view modes: single page, two-page, continuous autoscroll (~¾-up highlight).
- Pronunciation overrides via "sounds-like" respelling, per-book + global.
- All work with Claude (no Codex).

---

## Open questions / things to revisit later

- App name — currently just "Reader" (working title). Pick a real one before Phase 3 polish.
  **Deferred 2026-06-27 — "rethink later."** Brainstormed direction: real, plain word in the
  *voice / being-read-to* lane; might be shared publicly (so distinctiveness + claimable
  handle/domain matter). Research outcome: the read-aloud/TTS namespace is **brutally saturated**.
  - **Taken / direct collisions (avoid):** *Aloud* (Aloud! TTS app), *Hark* (Hark Reader — a TTS
    device for blind/low-vision, our exact niche), *Recite* (**Recite Me** web-accessibility
    read-aloud tool — same space; also a podcast app, GitHub user, premium `.com`/`.app`), *Spoken*
    (AAC TTS app), *Murmur* (TTS extension w/ word highlighting), *Cadence* (voice apps + the EDA
    giant), *Lull* (sleep apps + LullaBook).
  - **Survivors with no competing software found (worth claimability check next time):**
    **Recital** (a reading performed aloud — leading candidate), **Hearken** (to listen), *Quoth*
    (only a defunct word game; obscure).
  - User leaned toward *Recite* but its handles/domains are all taken or premium → parked. Pick up
    from the survivors, or explore a fresh coined/compound option.
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

## Tech chosen in Phase 2 (the voice stack)

- **TTS = `kokoro-js@1.2.1` + `onnxruntime-node`, CPU**, run in an Electron **`utilityProcess`**
  (`src/main/tts-service.js`). Model `onnx-community/Kokoro-82M-v1.0-ONNX`, `dtype:'q8'`
  (→ `onnx/model_quantized.onnx`, ~88 MB), 24 kHz output. `onnxruntime-node` is a **native binary**
  (prebuilt, no compile) — the one non-pure-JS piece; it loads fine in Electron via N-API.
  - **⚠️ `q8` is the slow dtype (spike 2026-06-27).** On a fast desktop CPU q8 synth (~1.9 s) is ~4×
    slower than fp16/q4/q4f16/fp32 (~0.5 s) — int8 dequant overhead. A CPU-only swap to **fp16/q4f16**
    is the biggest available latency win (no per-OS divergence), but it's **+70 MB** and **untested on
    Mac/low-end** — scoped as a follow-up, not yet landed. See `plans/spike-voice-latency-findings.md`.
- **Model is fetched on build, NOT committed.** `assets/models/` is gitignored (~88 MB). Run
  `node scripts/fetch-model.js` once before `npm run dist`. Voices (`af_heart.bin` etc.) ship inside
  the npm package (`node_modules/kokoro-js/voices/*.bin`) and load via `fs` — no separate fetch.
- **Pure logic, dependency-injected:** `src/renderer/reading-cursor.js` (sentence navigation) and
  `src/renderer/player.js` (playback controller) are DOM/audio/model-free and unit-tested with fakes,
  mirroring `paginate.js`. Audio/IPC/model are the injected edges.
- **Audio path:** WAV bytes cross renderer↔main as a typed array over IPC (CSP unchanged, no
  `media-src`); the renderer decodes via `AudioContext.decodeAudioData`. Disk cache =
  `src/main/clip-cache.js` (content hash, atomic temp-write+rename).

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
- Keep the voice on **CPU** — do not "optimize" onto GPU; it reintroduces per-OS divergence, and the
  spike proved there's no working GPU path anyway (DirectML fails at ConvTranspose; CUDA absent from the
  Node binding — see Decisions log). The CPU **dtype** is the real perf lever, not the device.
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

### Phase 2 (voice) gotchas

- **The model must land LOOSE at `resources/assets/models`, not in the asar.** The plan assumed the
  `assets/**/*` glob would do it — **it doesn't** (that glob packs into `app.asar`, but `main.js`
  reads a loose `process.resourcesPath/assets/models`). Fixed in `package.json` with
  `extraResources` (copies it loose) **and** a `!assets/models/**/*` `files` exclude (so the 88 MB
  blob isn't also shipped inside the asar). Don't remove either.
- **`onnxruntime-node`'s `.node` must be `asarUnpack`ed** (`**/node_modules/onnxruntime-node/**`) —
  a native binary can't load from inside an asar. Made explicit (don't rely on auto-detect).
- **`onnxruntime-node` ships ALL platforms' binaries (~208 MB under `bin/napi-v3/`) — we trim to the
  target only (2026-06-28).** It bundles linux + darwin + win32 (x64 **and** arm64), each with the big
  `onnxruntime` lib, plus an 18 MB `DirectML.dll` per Windows arch. On a Win-x64 launch ~190 MB of that
  never runs. `package.json` `files` now excludes the dead set: `linux/**`, `win32/arm64/**`,
  `darwin/x64/**`, and **all `DirectML.dll`** (GPU is the spike-proven dead backend, CPU-only) at the top
  level, plus **platform-scoped** `win.files` drops `darwin/**` and `mac.files` drops `win32/**`. Result:
  **`app.asar.unpacked` 231 MB → 39 MB** — ~192 MB less to extract/Defender-scan on every cold launch of
  the portable `.exe`. **Verified:** rebuilt + `node test/manual/verify-packaged.js` → offline synth
  still `201644 bytes @ 24000 Hz` (win32/x64 `onnxruntime.dll` loads fine with DirectML absent). The
  platform-scoped `files` **merge** with the top-level list (don't replace) — confirmed src intact in the
  asar. **Don't widen these excludes to the asar JS deps** (`onnxruntime-web` 91 MB / `typescript` 23 MB /
  `@img`/sharp 20 MB are dead weight too, BUT `onnxruntime-web` is a **static `import`** in transformers'
  `backends/onnx.js` — removing it breaks the engine; left alone deliberately). **Launch root cause not
  fully fixed:** the `portable` target still re-extracts on every cold launch; the trim only makes each
  extraction lighter. The structural fix (deferred by user 2026-06-28) is switching `portable` → an
  **NSIS installer** (extract once at install) — revisit if launch still feels slow.
- **utilityProcess WAV transfer:** send the bytes **in the message body** (`postMessage({…, wav})`),
  **not** in a transfer list — Electron's utilityProcess uses structured clone; a `[wav.buffer]`
  transfer-list arg makes `msg.wav` arrive `undefined`. (This bit us; the plan's first draft had it.)
- **`kokoro-js` quirks:** `tts.list_voices()` returns **void** (it `console.table`s) — use
  `Object.keys(tts.voices)`. `RawAudio.toWav()` exists and returns an `ArrayBuffer` (24 kHz).
- **Offline config order is load-bearing:** import `@huggingface/transformers`, set
  `env.cacheDir` + `env.allowRemoteModels=false` (+ `allowLocalModels=true`), **then** import
  `kokoro-js` so it inherits the same transformers singleton. Reorder and it can hit the network.
- **The per-sentence highlight only toggles `.is-reading`** on the existing spans (the sacred DOM
  contract). Cross-chapter highlight goes through `ReaderView.show` → `goToChapter` first (only the
  current chapter is mounted). Keep `setView()` CSS-only — the spans must survive a mode switch.
- **AudioContext starts `suspended`** (autoplay policy) — `resumeAudio()` is called in the play /
  Space / sentence-click gesture paths or the first clip is silently muted. Don't remove it.
- **`#play-pause` is `.blur()`ed after click** so Space doesn't double-fire (focused-button native
  activation + the keydown handler). Keep it.
- **Clip cache key = `sha1("<voice> <text>")`** (voice-first). The in-memory decoded-clip Map is
  bounded (`player.js` `maxClips`, **48** since the spike's Part B; was 24); rewind beyond the cap
  re-synthesizes from the disk cache (fast). A synth failure mid-playback stops cleanly (`setPlaying(false)`) — a single Play
  retries (the poisoned clip promise self-evicts).
- **`goToPageContaining` paged-mode flip is not yet live-verified** — if a flip lands on the wrong
  page in single/two-page mode, add the `getBoundingClientRect` fallback (offsets can read
  pre-fragmentation on some engines). Scroll mode (the expected favorite) is fine.

### Phase 2.5 (voice/playback settings) gotchas

- **`clipKey` now includes speed:** `sha1("<voice> <speed> <text>")` (was `"<voice> <text>"`). All
  three of `get`/`put` and the `synthesize` IPC handler thread `speed`. Don't drop it — two speeds of
  the same sentence are different audio and must cache separately. Existing on-disk clips from before
  this change just become cold (re-synthesized once); they're never served wrong.
- **Voice/speed are read LIVE in the synth closure** (`{ voice: state.voice, speed: state.speed }`),
  so a change applies via `player.reload()` (clears the in-memory prefetch + re-seeks the current
  sentence) — **no `createPlayer` rebuild**. `reload()` replays if playing, re-shows if paused.
- **`applySettings()` sets voice/speed/pause directly, NOT via `setVoice`/`setSpeed`** — those call
  `reload()`+`saveSettings()`, which would be a needless storm during boot load (and there's no player
  yet). Keep the boot path side-effect-free. `buildVoiceList()` must run **before** `loadSettings()`
  so `markActiveVoice()` has buttons to mark.
- **Speed applies on the slider's `change` (release), not `input`** — `input` only updates the live
  label. Otherwise every drag tick re-synthesizes. Slider range is 0.7–1.5 in the UI;
  `tts-service.clampSpeed` defends a wider 0.5–2 at the engine.
- **End-of-chapter pause is a `setTimeout` in `onEnded`, cancelable by the token guard.** `pause()`/
  `seekTo` bump `token` via `stopInternal()`, so a beat in flight is dropped by the `mine === token`
  check when it fires. `endChapterPauseMs()` is injected and read **live** each crossing (a change
  applies on the next chapter boundary, no reload).
- **Unit-test trap (already handled):** with node `mock.timers` enabling `setTimeout`, a
  `setTimeout`-based flush helper can never resolve — the pause tests flush with **`setImmediate`** and
  advance the clock manually with `t.mock.timers.tick(ms)`. Don't "fix" them back to a `tick()` that
  awaits `setTimeout`.
- **Curated voices live in `VOICES` (app.js); IDs must exist in `node_modules/kokoro-js/voices/*.bin`**
  — 8 are wired (US/UK × m/f); all confirmed present (54 `.bin` files ship). Adding one = add a
  `{id,label}` row; the picker + preview pick it up automatically.

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

---

## Next up

**Phase 2 is built & planner-verified on Windows. Next: the user's manual gates, then Phase 3 (library + auto-resume).**

1. **User: listen + confirm offline.** Run `npm start`, drag in your books, press Space, and walk
   the **Phase 2 manual checklist** in [`../HOW-TO-RUN.md`](../HOW-TO-RUN.md): voice/sync good,
   ¾-up scroll, rewind controls, cross-chapter, instant 2nd play, and **network-off in the packaged
   `.exe`**. (The mechanism is smoke-proven; only the *listening* and the *adapter-off* gesture can't
   be automated.)
2. **User: confirm the Mac build.** On the M5 run `npm install` then `npm run dist:mac`, right-click→
   Open, drag in an EPUB, press Play. `onnxruntime-node` pulls the arm64 binary at `npm install`, and
   the build config lands the model at `Reader.app/Contents/Resources/assets/models` (matches
   `main.js`). **Note:** a *notarized* mac build must code-sign the unpacked `.node` or Gatekeeper
   blocks launch — signing/notarization is out of scope, but it's a *loud* failure, not a silent one.
   Closes the last Phase 1 carryover too.
3. **Then: Phase 3 — Library + auto-resume** (bookshelf with covers, drag-to-add, click-to-resume
   from the exact sentence). Recommended: **Sonnet 4.6, medium thinking** (standard UI/CRUD; design §9).

> **Carry into Phase 3 (deferred Phase-2 items, by design):** per-book reading-position resume
> (the clip cache is global/content-addressed today — Phase 3 may add per-book folders); the
> in-memory clip cache cap is 24 (`player.js` `maxClips`) — fine, revisit if needed. **Phase 4**
> owns: reading-speed control, a **voice-picker** UI (today `af_heart` is hardcoded in ~4 spots —
> centralize when the picker lands), end-of-chapter-pause control, pronunciation overrides, and
> Markdown/DOCX. Also note: **manual nav while narrating is "voice leads"** — a TOC/keyboard jump is
> overridden by the next clip's `view.show`; confirm that's the desired UX or revisit in Phase 3/4.

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

## Tech chosen in Phase 2 (the voice stack)

- **TTS = `kokoro-js@1.2.1` + `onnxruntime-node`, CPU**, run in an Electron **`utilityProcess`**
  (`src/main/tts-service.js`). Model `onnx-community/Kokoro-82M-v1.0-ONNX`, `dtype:'q8'`
  (→ `onnx/model_quantized.onnx`, ~88 MB), 24 kHz output. `onnxruntime-node` is a **native binary**
  (prebuilt, no compile) — the one non-pure-JS piece; it loads fine in Electron via N-API.
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

### Phase 2 (voice) gotchas

- **The model must land LOOSE at `resources/assets/models`, not in the asar.** The plan assumed the
  `assets/**/*` glob would do it — **it doesn't** (that glob packs into `app.asar`, but `main.js`
  reads a loose `process.resourcesPath/assets/models`). Fixed in `package.json` with
  `extraResources` (copies it loose) **and** a `!assets/models/**/*` `files` exclude (so the 88 MB
  blob isn't also shipped inside the asar). Don't remove either.
- **`onnxruntime-node`'s `.node` must be `asarUnpack`ed** (`**/node_modules/onnxruntime-node/**`) —
  a native binary can't load from inside an asar. Made explicit (don't rely on auto-detect).
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
  bounded (`player.js` `maxClips`, default 24); rewind beyond the cap re-synthesizes from the disk
  cache (fast). A synth failure mid-playback stops cleanly (`setPlaying(false)`) — a single Play
  retries (the poisoned clip promise self-evicts).
- **`goToPageContaining` paged-mode flip is not yet live-verified** — if a flip lands on the wrong
  page in single/two-page mode, add the `getBoundingClientRect` fallback (offsets can read
  pre-fragmentation on some engines). Scroll mode (the expected favorite) is fine.

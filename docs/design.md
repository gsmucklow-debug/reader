# Reader — Master Design Document

> **Status:** Design approved 2026-06-25. This is the north-star document. It changes rarely.
> For current build state and what to do next, see [`HANDOFF.md`](./HANDOFF.md).

---

## 1. Purpose

A calm, distraction-free reading app that **narrates books aloud in a warm, human-sounding
voice while highlighting the current sentence** in the text. Built for a user with MS,
brain fog, and memory difficulties: listening + reading together aids comprehension, and
the app removes the burden of "where was I?" entirely.

**Core promise:** Add a book → it reads to you with the spoken sentence highlighted →
it always remembers exactly where you stopped.

---

## 2. Who it's for / guiding constraints

These constraints override convenience. When a decision is unclear, favor these:

- **No terminal, ever.** Everything is double-clickable. No setup steps, no command line.
- **Cross-platform.** Must run identically on **Windows 11** (desktop PC, RTX 5070 Ti) and
  **macOS** (MacBook Pro M5, 24 GB unified memory). The Mac is the primary night-time device.
- **Calm and low-cognitive-load.** Distraction-free reading page; controls one tap away,
  never cluttering the screen. Big, easy-to-hit playback controls. Keyboard-drivable.
- **Never lose the user's place.** Auto-resume is a first-class feature.
- **Offline, free, private.** No accounts, no cloud, no per-use cost.

---

## 3. The voice (decided)

- **Engine: Kokoro** (82M-parameter neural TTS) running **fully in JavaScript inside the app**
  via the [`kokoro-js`](https://www.npmjs.com/package/kokoro-js) package + ONNX Runtime.
  No Python, no sidecar, no installs.
- **CPU, not GPU.** The model is tiny and already faster than real-time on CPU. Running on
  CPU means **Windows and Mac behave identically** — no GPU backend quirks (DirectML vs CoreML)
  to chase. The user's powerful GPU is deliberately *not* used.
- **Voice quality:** "very good audiobook." A notch below premium cloud voices (ElevenLabs)
  but free, unlimited, offline, private. A premium cloud voice could be added later as an
  optional toggle, but is explicitly out of scope for now.

---

## 4. Highlighting & sync (decided — the key architectural choice)

- **Granularity: sentence-level.** The current sentence gets a soft highlight that advances
  as the voice reads.
- **Mechanism: one audio clip per sentence.** Text is split into sentences; each sentence is
  synthesized as its own short audio clip. Highlight sentence *N* while clip *N* plays;
  advance when the clip ends.
- **Why this matters:** This collapses the hardest technical problem. There is **no forced
  alignment, no per-word timestamps, no whisper pass.** The rewind controls fall straight out:
  - **Back one sentence** = replay clip *N−1*.
  - **Back one paragraph** = jump to the first clip of the previous paragraph.
- **Pre-generation & caching:** The app pre-synthesizes the next few sentences so there's never
  a wait, and caches clips per book on disk so re-reading (and rewinding) is instant.

> Known non-trivial work items (named so they aren't mistaken as free):
> **EPUB reading-order extraction** (follow spine order; skip nav/headers/footers) and
> **sentence tokenization** (handle abbreviations like "Mr.", "e.g." so splitting doesn't break).

---

## 5. The reading experience

### View modes (switchable on the fly)
1. **Single page** — one clean column at a time.
2. **Two pages side-by-side** — like an open book; highlight flows from bottom-left to top-right.
   (Page breaks are computed from text size and shift when you zoom — this is expected and fine.)
3. **Continuous autoscroll** — text scrolls smoothly; the highlighted sentence is held about
   **¾ of the way up the screen** so the eyes rest in one spot. (Expected to be the favorite.)

### Comfort controls (behind one small "settings" button)
- Text size / zoom
- Max page width (so lines don't stretch too wide to track)
- Line spacing
- Light / dark mode
- Reading speed (narration faster/slower)
- **End-of-chapter pause** — adjustable beat (off / short / longer) before continuing.

### Playback controls (always visible, large, keyboard-mapped)
- Play / Pause (e.g. spacebar)
- Back one sentence
- Back one paragraph
- Forward one sentence / paragraph

### Pronunciation overrides
- Select a word and give a **"sounds-like" respelling** (e.g. *Hermione → "Her-my-oh-nee"*).
- The respelling is used **only for the voice**; the real word still shows on the page.
- Saved and reused — taught once, remembered. Works **per-book** (a name in your own novel)
  and **globally** (a term you want fixed everywhere).

---

## 6. Library & persistence

- **Bookshelf:** books shown as a grid of **covers**. Add by **dragging a file in** or an
  "Add" button. EPUB, Markdown, and DOCX all live together on one shelf.
  - EPUB covers are extracted from the file.
  - Markdown/DOCX (usually no cover) get a clean **generated cover** (title on a colored card).
- **Auto-resume:** each book remembers the exact sentence you stopped on; clicking it opens
  right there, ready to play.
- **Per-book memory:** view mode, text size, and pronunciation overrides are remembered per book.
- **Behind the scenes:** on add, a book is parsed once into chapters + sentences and stored;
  reopening is instant; previously-heard clips are cached.

---

## 7. Formats

- **In scope:** EPUB, Markdown, DOCX (all "clean" structured text).
- **Out of scope (deliberately):** PDF — designed for print, text comes out jumbled, scanned
  PDFs need OCR. Too much effort for too little reliability. May revisit much later.

---

## 8. Technical shape

- **Shell:** **Electron** desktop app (all-JavaScript). Chosen over alternatives because its
  all-JS story + mature packaging (`electron-builder` / Forge) is the lowest-friction route to
  **double-clickable builds on both OSes**. App weight is irrelevant on this hardware.
- **Voice:** `kokoro-js` + ONNX Runtime, in-process, CPU.
- **Parsing:** EPUB (spine-order extraction), DOCX, Markdown → normalized chapters + sentences.
- **Storage:** local app-data folder — library index, per-book progress/settings, cached audio,
  pronunciation dictionaries. No cloud, no accounts.

---

## 9. Build roadmap (phases)

Riskiest/most boring thing first (packaging), so nothing is built on sand. Voice comes early
because it's the magic. Each phase ends with something usable.

- **Phase 1 — Skeleton that proves it works.** Double-clickable Electron app, opens on Windows
  *and* Mac, drag in an EPUB, see text in the clean reading view (single-page + autoscroll).
  **No voice yet.** Proves the double-click / no-terminal / both-machines path.
- **Phase 2 — Voice + sentence highlighting.** Kokoro reading aloud, per-sentence clips, moving
  highlight, play/pause, back-a-sentence, back-a-paragraph. The heart of the app.
- **Phase 3 — Library + auto-resume.** Bookshelf with covers, drag-to-add, click-to-resume.
- **Phase 4 — Comfort + polish.** Light/dark, zoom, width, spacing, speed, two-page view,
  end-of-chapter pause, pronunciation overrides. Add Markdown + DOCX support.

---

## 10. Working method (how we collaborate)

- **All work done with Claude** in VS Code (no Codex).
- Three document types live in the repo as plain files:
  1. **This design doc** — north star, rarely changes.
  2. **`HANDOFF.md`** — the single living file with current state, handed to fresh sessions.
  3. **One plan per phase** in `docs/plans/` — focused, step-by-step, self-contained.
- **Separation of duties (strict):** A **builder/coder session executes a plan only**. It must
  **NOT edit any planning document** — not `HANDOFF.md`, not this design doc, not any plan file.
  When it finishes, it delivers a **self-contained written report** (what it built, how it
  verified, what's left, gotchas) back to the **planning session**. The planning session then
  **verifies the report's claims and is the sole author of `HANDOFF.md`** — so unverified
  self-claims never get recorded as fact and the planner keeps authorship of its control docs.
  Every phase plan must repeat this instruction at the top.
- Each plan names its recommended **model + thinking level** at the top.
- Recommended models per phase:
  - Phase 1: **Opus 4.8, high thinking** (packaging gotchas).
  - Phase 2: **Opus 4.8, high thinking** (core engine).
  - Phase 3: **Sonnet 4.6, medium thinking** (standard UI/CRUD).
  - Phase 4: **Sonnet 4.6, medium thinking** (settings/UI).
- No terminal and no git required of the user; work is delivered as openable files and a
  double-clickable app.

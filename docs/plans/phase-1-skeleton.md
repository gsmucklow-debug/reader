# Phase 1 Plan — The Skeleton That Proves It Works

> **Run this with:** Claude **Opus 4.8**, **high thinking**, in VS Code.
> **Hand-off note:** This plan is self-contained. Read it top to bottom. When done, update
> [`../HANDOFF.md`](../HANDOFF.md) ("What's done" / "Next up" / "Gotchas") before finishing.
> **Full context if needed:** [`../design.md`](../design.md).

---

## Goal of this phase

Prove the riskiest, most boring thing **before** any features are built: that we can ship a
**double-clickable, no-terminal, cross-platform** desktop app that opens a book and shows it
in a calm reading view. **No voice in this phase.**

By the end, the user can: double-click the app on **Windows** (and it's confirmed buildable for
**macOS**), drag in an **EPUB**, and read it in a clean view with **single-page** and
**continuous-autoscroll** modes, light/dark, and text zoom.

If this phase works, everything else is additive. If packaging is going to hurt, we find out now.

---

## Hard constraints (do not violate)

- **No terminal use required of the end user.** The deliverable is a double-clickable app.
  (You, the builder, may use the terminal to develop/build — the *user* never must.)
- **Cross-platform:** Windows 11 + macOS (Apple Silicon). Use only cross-platform libraries.
  No native modules that need per-OS compilation in this phase.
- **Calm, low-cognitive-load UI:** distraction-free reading page; large, obvious controls;
  keyboard-drivable. Nothing flashy.
- Keep the architecture ready for Phase 2 (per-sentence audio clips) — see "Set up for the
  future" below — but **do not build voice yet.**

---

## Tech choices (locked for this phase)

- **Electron** + **electron-builder** (or Electron Forge — builder preferred for simple
  double-click installers). Plain JavaScript (not TypeScript unless trivial to add).
- A light renderer: **plain HTML/CSS/JS** or a minimal framework. Do **not** pull in a heavy
  UI stack; this app must stay simple and legible. Vanilla or a tiny lib is fine.
- **EPUB parsing:** use a maintained library (e.g. `epubjs` for rendering *or* a parser like
  `@gxl/epub-parser` / `epub2` to extract spine-ordered text). **Recommendation:** extract
  text ourselves into our own normalized structure (see below) rather than embedding a 3rd-party
  reader, because Phase 2 needs our own per-sentence model and highlight control. Evaluate and
  pick; record the choice in HANDOFF.

---

## What to build

### 1. App skeleton
- Electron main process + a single renderer window.
- App launches to a near-empty **reading view** with a prompt: "Drag an EPUB here, or click Add."
- Window is resizable; remembers its size/position is a nice-to-have, not required.

### 2. Load an EPUB
- Accept a file via **drag-and-drop** onto the window **and** via an "Add / Open" button
  (native file picker).
- Parse the EPUB into a **normalized in-memory document** (this structure is the contract for
  Phase 2 — get it right):

```
Document {
  title: string,
  chapters: Chapter[]
}
Chapter {
  title: string | null,
  paragraphs: Paragraph[]
}
Paragraph {
  sentences: string[]      // split now, even though no audio yet
}
```

  - **Reading order:** follow the EPUB **spine** order. Skip nav documents, headers/footers,
    and non-content sections. Do not just concatenate all HTML.
  - **Sentence splitting:** split paragraphs into sentences with an approach that handles common
    abbreviations ("Mr.", "Mrs.", "Dr.", "e.g.", "i.e.", "St.", "vs.", initials). A good
    library (e.g. an Intl-segmenter-based or NLP sentence splitter) is fine; naive split on
    "." is **not** acceptable. The sentence array is what Phase 2 turns into audio clips.

### 3. Reading view
- Render the parsed document as clean, readable text.
- **Two view modes** in this phase (the other, two-page, comes in Phase 4):
  1. **Single page / single column** — readable column, paginated or simple scroll.
  2. **Continuous autoscroll layout** — one continuous column. (Auto-*scrolling* is driven by
     audio in Phase 2; for now just provide the continuous-column layout and manual scroll.)
- Each sentence should be a **separately addressable element** (e.g. wrapped span with an id /
  data-index keyed to chapter/paragraph/sentence). This is essential so Phase 2 can highlight
  per sentence with no re-architecting. **Do this even though nothing highlights yet.**
- **Comfort controls** (minimal, behind a small settings button):
  - Text zoom (size up/down)
  - Light / dark mode
  - Max page width
  - (Line spacing optional this phase.)

### 4. Set up for the future (stub, don't build)
- Leave a clear, documented seam where Phase 2 will: take `Paragraph.sentences`, synthesize a
  clip per sentence, play them in order, and toggle a `.is-reading` class on the matching
  sentence element. Add a code comment / short note marking this seam.

---

## Packaging & delivery (the actual point of this phase)

- Configure **electron-builder** to produce:
  - **Windows:** a double-clickable installer (NSIS) **or** portable `.exe`. Portable is
    friendliest for a no-terminal user — confirm which and document it.
  - **macOS:** a `.dmg` / `.app` for Apple Silicon (arm64). (Code-signing/notarization is **not**
    required for this phase — document that the user may need to right-click → Open the first
    time on macOS due to Gatekeeper.)
- Provide a simple **"how to run" note** in the repo (plain Markdown) describing exactly which
  file to double-click on each OS.

---

## Acceptance criteria (Phase 1 is done when…)

1. On **Windows 11**, the user can **double-click one file** to launch the app — no terminal.
2. The app builds for **macOS arm64** and launches on the M5 MacBook (right-click→Open allowed).
3. Dragging in an **EPUB** (or using Add) shows its text in the reading view, in **correct
   reading order**, split into sentences sensibly (spot-check: abbreviations don't break it).
4. **Single-page** and **continuous-autoscroll** layouts both work; user can switch between them.
5. **Text zoom** and **light/dark** work.
6. Each sentence is a distinct, addressable element in the DOM (verify in devtools).
7. No crash on a couple of real-world EPUBs of different structure.

---

## Out of scope for Phase 1 (do NOT build)

- Any voice / TTS / audio. (Phase 2.)
- Library / bookshelf / covers / auto-resume. (Phase 3.) For now, one book at a time in memory
  is fine; no persistence required.
- Two-page side-by-side view, reading speed, end-of-chapter pause, pronunciation, line spacing.
  (Phase 4.)
- Markdown and DOCX. (Phase 4.) **EPUB only** this phase.
- Code-signing / notarization.

---

## When finished

1. Confirm each acceptance criterion above with a quick manual check; note any that are partial.
2. Update [`../HANDOFF.md`](../HANDOFF.md):
   - Tick Phase 1 in "What's done."
   - Set "Next up" to Phase 2.
   - Add any **gotchas** discovered (packaging quirks, EPUB edge cases, the parsing library
     chosen and why).
3. Leave the normalized `Document` structure and the per-sentence DOM elements clearly in place —
   Phase 2 depends on them.

# Reader — How to run it

No terminal needed. Just open one file.

## Windows 11
1. Open the `dist` folder.
2. Double-click **`Reader-0.1.0-portable.exe`**.
3. The app opens. Drag an `.epub` book onto the window, or click **Add book**.

That single `.exe` is the whole app — nothing to install. You can copy it
anywhere (Desktop, a USB stick) and double-click it there.

## macOS (Apple Silicon — M-series)
> The Mac build has to be produced **on a Mac** (see HANDOFF for why), so it
> isn't in this `dist` folder yet.

Once built it will be **`Reader-0.1.0-arm64.dmg`**:
1. Double-click the `.dmg`, drag **Reader** into Applications.
2. The first time, macOS Gatekeeper may say it's from an unidentified
   developer (the app isn't code-signed yet). To open it:
   **right-click the Reader app → Open → Open.** You only do this once.
3. Drag an `.epub` onto the window, or click **Add book**.

## What works in this version (Phase 1)
- Opens **EPUB** books and shows them in a calm reading view.
- Two view modes: **Scroll** (one continuous column) and **Single page**.
- Comfort: text size (**Aa**), **Light / Dark**, page width.
- **No narration yet** — the voice arrives in Phase 2.

Markdown/DOCX, the library shelf, and the reading voice come in later phases.

## Phase 2 — manual listen check

The smoke test (`npm run smoke`) proves the narration *mechanism*: pressing Play
synthesizes the first sentence through the real engine, highlights it, and the
highlight advances to the next sentence on clip end. But Playwright can't *hear*
audio, so voice quality and sync must be judged by ear.

Drag in each of the 7 EPUBs (the 3 bundled Gutenberg fixtures + your 4 commercial
books), press Play, and confirm by listening:

- [ ] Voice is clear and warm (Kokoro `af_heart`); no garbled audio.
- [ ] Highlight matches the spoken sentence — no drift; they advance together.
- [ ] Scroll mode holds the reading line ~¾ up; paged modes flip with the reading.
- [ ] Back-a-sentence / back-a-paragraph / forward-a-sentence / forward-a-paragraph work and resume cleanly.
- [ ] Click any sentence to start reading there; Spacebar toggles play/pause.
- [ ] Reading crosses chapter boundaries without stalling.
- [ ] Second play of the same passage is instant (on-disk clip cache hit).
- [ ] **Offline** works in the packaged `.exe` with the network off (adapter off).

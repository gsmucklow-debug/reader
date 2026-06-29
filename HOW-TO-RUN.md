# Reader — How to run it

No terminal needed. Just open one file.

## Windows 11
1. Open the `dist` folder.
2. Double-click **`Reader-0.1.0-setup.exe`**.
3. Follow the short install wizard (you can pick a folder — no admin password needed).
4. Launch **Reader** from the **Desktop** shortcut or the **Start menu**, then drag an
   `.epub` book onto the window, or click **Add book**.

The first time Windows may show a SmartScreen warning (the app isn't code-signed):
click **More info → Run anyway**. You only do this once. Installing once means the app
opens fast every time after — it no longer unpacks itself on each launch.

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

## Phase 2.5 — voice, speed & end-of-chapter pause (manual listen check)

Open the **Aa** comfort popover. The smoke test proves the *mechanism* (a voice
switch re-synthesizes in the new voice, ▶ preview issues a synth, and voice/speed/
pause survive a restart), but ears must judge quality and feel:

- [ ] Each curated voice (US/UK × male/female) sounds right via its ▶ preview.
- [ ] Picking a voice restarts the current sentence in the new voice immediately.
- [ ] Speed slider changes pace (and restarts the current sentence on release); the
      label tracks the value as you drag.
- [ ] End-of-chapter pause: **Off** continues immediately; **Short** / **Longer** wait
      the beat when crossing into a new chapter; pausing during the beat cancels it.
- [ ] Voice / speed / pause survive an app restart.

## Phase 2.6 — UI polish & heading reading (manual check)

The smoke test proves the mechanism (popovers are mutually exclusive; a heading is a
narratable span; the play button toggles `.is-playing`). These last items are visual /
by-ear and want your eye:

- [ ] **No menu bar** at the top of the window (no File / Edit / View / Window / Help).
- [ ] **"Aa"** opens the **Comfort** popover (font, text size, theme, page width) and
      **"Voice"** opens the **Voice** popover (voice, reading speed, end-of-chapter pause);
      opening one closes the other; **Esc** or an outside click closes whichever is open.
- [ ] Transport icons are **monochrome** (no colored emoji), theme-aware, and crisp; the
      **play button is a clean circle** at every text size and in both themes, and its glyph
      toggles between a **play triangle** (paused) and **two bars** (playing).
- [ ] **Headings are read aloud and highlighted** — chapter titles, POV names like
      **BARRY**, and dates like **November 2, 2018** are spoken in reading order with the
      moving highlight, and there is **no duplicated, unread chapter title** on the page.

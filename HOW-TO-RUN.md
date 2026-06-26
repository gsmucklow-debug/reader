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

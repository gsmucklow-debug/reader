# Voice Cloning — Design (2026-07-01)

> Bring-your-own-reference voice cloning for the expressive GPU engine: pick a reference clip →
> name it → it becomes a selectable expressive voice. Decided with the user 2026-07-01.
> **Sequenced AFTER** the predefined-voice UI ([`phase-expressive-voice-ui.md`](./phase-expressive-voice-ui.md))
> lands and is planner-verified — both touch `app.js`/`index.html`/`main.js`, so don't build in parallel.

## Why + the one hard guardrail

The user cloned a voice via the server's Web UI and it sounded good; they want it inside Reader —
especially to hear their own drafts in a chosen voice. The cloning path is already proven on the
5070 Ti.

**Guardrail (locked):** cloning is **bring-your-own-reference only** — the app ships the *capability*,
never any bundled/celebrity voices. Cloned voices are the user's personal, local files on their own
server. If Reader is ever shared publicly, no cloned voices travel with it. (Context: the user's own
"personal only, not shipping" rule + the Scarlett-Johansson/OpenAI-"Sky" consent precedent.) A light
one-line hint in the Add-voice dialog — "Only add voices you have permission to use" — and nothing
heavier.

## Decisions (locked with the user)

- **Source:** **file picker only** (`.wav`/`.mp3`) for v1. In-app mic recording ("read in my own
  voice") is a compelling follow-up but deferred — a bigger build (mic permission + recording UI).
- **Where:** a **"My Voices"** group at the top of the Expressive voice list, with a **"＋ Add a
  voice"** button. Predefined voices (Male/Female) stay below it.
- **Global**, like the rest of the expressive settings.
- **Remove:** deferred for v1 — the server exposes no delete endpoint; managing/removing a reference
  is manual (delete the file in the server's `reference_audio/`) until we add it. Note it in the UI.

## Server contract (devnen Chatterbox-TTS-Server, confirmed 2026-07-01)

- **Upload:** `POST /upload_reference`, `multipart/form-data` (field `file`; `.wav`/`.mp3`).
- **List:** `GET /get_reference_files` → the cloned/reference voices (parallel to
  `/get_predefined_voices`).
- **Synthesize with a clone:** in the `/tts` body, `voice_mode: "clone"` +
  `reference_audio_filename: "<name>"` (instead of `predefined_voice_id`).
- Recommended reference clip: ~10–20 s of clean, single-speaker speech (surface as a hint).

## Architecture (extends the predefined UI, reuses existing patterns)

- **Voice list becomes hybrid:** static predefined (grouped Male/Female, our sex metadata) **+**
  dynamic **My Voices** fetched from the server via `GET /get_reference_files` on panel open. The
  static-array decision for predefined still holds; cloned voices are inherently server-held, so they
  must be listed live.
- **`src/main/expressive-tts.js`** gains **clone mode:** accept a `mode` ('predefined' | 'clone') and,
  for clone, send `voice_mode:'clone'` + `reference_audio_filename` instead of `predefined_voice_id`.
- **New IPC (main + preload):**
  - `expressive:references` → `GET {url}/get_reference_files` (list My Voices).
  - `expressive:uploadReference(bytes, fileName)` → proxies the multipart `POST /upload_reference`
    (Reader reads the picked file to bytes in the renderer, like `library:add`/drag-drop; main does
    the multipart POST — the renderer never touches the network).
- **Add-a-voice flow (renderer):** `reader.pickFileBytes()` (exists) → prompt for a display name →
  `expressive:uploadReference` → on success, refresh the My Voices list and select the new voice.
- **Selection persistence:** store the chosen voice **and its mode** — add `expressiveVoiceMode`
  ('predefined' | 'clone') to settings alongside `expressiveVoice`, so a persisted clone re-selects
  correctly. `synthOpts()` sends the mode; main routes it to `expressive-tts` accordingly.
- **Cache correctness:** the reference filename is the voice id and already folds into the clip-cache
  key via the existing `cacheVoice` string; include the mode in it too so a predefined and a cloned
  voice that happened to share a name can't collide. (Same-words-same-voice is still correct either way.)

## Tasks (TDD; sequenced after the predefined UI is merged/verified)

1. `expressive-tts.js`: add `mode` → clone vs predefined request shaping. Unit-test both bodies
   (mirrors the existing predefined test).
2. main + preload: `expressive:references` (list) and `expressive:uploadReference` (multipart proxy).
3. Renderer: "My Voices" group + "＋ Add a voice" (pick → name → upload → refresh → select), the
   consent hint, and the ~10–20 s guidance. Fetch references on panel open.
4. `synthOpts()` + settings: thread `expressiveVoiceMode`; persist it; `applySettings` reflects it.
5. Cache key: include mode. Regression: `npm test` green, `npm run smoke` **SMOKE OK** (default path
   untouched — cloning is entirely within the expressive branch).

## Acceptance

**Builder-verifiable:** tests + smoke green (default Kokoro path untouched; upload/list are behind the
expressive engine and a live server, so they're structurally covered + unit-tested, not smoke-driven).
The multipart body shaping and the clone `/tts` body are unit-tested with a fake fetch.

**User by-ear / live-server (the real gate):** add a reference clip → it appears in My Voices → select
it → narration reads your draft in that voice → persists across a restart.

## Out of scope (YAGNI)

- In-app mic recording (follow-up). Removing/renaming cloned voices in-UI (manual for v1; no server
  delete endpoint). Any bundling/shipping of cloned voices (forbidden by the guardrail). Per-book
  voice memory (global only). The M5/MLX runtime (later).

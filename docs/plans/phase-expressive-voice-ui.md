# Phase — Expressive Voice UI (in-app engine switch, voices, generation controls)

> Builds the in-Reader UI for the optional expressive GPU voice, on top of the spike wiring
> already on branch `spike/expressive-gpu-voice`. Design + decisions:
> [`2026-07-01-expressive-gpu-voice-design.md`](./2026-07-01-expressive-gpu-voice-design.md).
> Spike gate PASSED by ear (user tuned Chatterbox to a good config 2026-07-01).
>
> **Run with:** a fresh **Sonnet 5** builder (well-scoped TDD execution). Opus planned + verifies.
> **Branch:** continue on `spike/expressive-gpu-voice`.

## What already exists (spike — do not rebuild)

- `src/main/expressive-tts.js` — `synthesizeRemote({text, voice, params, url, fetchImpl})` → WAV.
  Posts to the Chatterbox server `/tts` (predefined-voice mode); sends only the generation params
  provided (`exaggeration`, `cfg_weight`, `temperature`, `speed_factor`). Unit-tested.
- `src/main/clip-cache.js` — `clipKey(text, voice, speed, engine)` is engine-aware (Kokoro key
  unchanged; other engines namespaced). Unit-tested.
- `src/main/main.js` — the `synthesize` handler currently routes to expressive **when the env var
  `READER_EXPRESSIVE_URL` is set** (spike gating), caches under `'chatterbox'`, folds all gen params
  into the cache key, and **falls back to Kokoro on any error**. Gen-param defaults are the user's
  tuned config.

**This phase replaces the env gate with a UI/settings-driven engine choice.**

## Decisions (locked with the user 2026-07-01)

- **Engine switch** in the Voice popover: `Offline (Kokoro)` ⇄ `Expressive (GPU)`. Kokoro stays the
  default; the app never depends on the server.
- **All 28 server voices**, grouped **Male / Female**, all **US English** (user confirmed they all
  sound US — no accent sub-grouping yet). Static list in the renderer (server gives no sex/accent
  metadata), mirroring the existing Kokoro `VOICES` array. Voice `id` = the server `filename`.
  - **Female (10):** Abigail, Alice, Cora, Elena, Emily, Gianna, Jade, Layla, Olivia, Taylor
  - **Male (18):** Adrian, Alexander, Austin, Axel, Connor, Eli, Everett, Gabriel, Henry, Ian,
    Jeremiah, Jordan, Julian, Leonardo, Michael, Miles, Ryan, Thomas
  - *(Taylor/Jordan classified by name — trivially movable if the user re-hears them.)*
- **Four generation sliders** (Chatterbox levers), defaults = the user's tuned config:
  `exaggeration 0.5`, `cfgWeight 0.3`, `temperature 0.75`, `speedFactor 1.0`.
- **Global** persistence (matches existing voice/speed model) — new `settings.json` keys.
- **Server unreachable** → the Expressive option is shown but disabled with a "Start the Voice
  Engine" hint. If the persisted engine is expressive but the server is down, narration still works
  (main falls back to Kokoro per-sentence) — just surface the status.

## Architecture — routing becomes opts-driven (not env)

The renderer sends the engine + params **per synthesize call** (matching the existing "synth closure
reads state live" pattern), so `main.js` stays stateless and a setting change takes effect via the
player's `reload()`.

- **Renderer** builds a `synthOpts()`:
  - Kokoro: `{ voice: state.voice, speed: state.speed }` (unchanged).
  - Expressive: `{ voice: state.voice, speed: state.speed, engine: 'expressive',
    expressiveVoice: state.expressiveVoice, exaggeration, cfgWeight, temperature, speedFactor }`.
    (`voice`/`speed` still sent so main's Kokoro fallback has them.)
- **main.js** `synthesize` handler: route on `engine === 'expressive'` (NOT the env var). URL =
  `serverUrl || process.env.READER_EXPRESSIVE_URL || 'http://localhost:8004'`. Keep the per-param
  cache key + Kokoro fallback. The env var survives only as the default URL / a dev override —
  **remove it as the routing trigger** so the smoke's default (kokoro) path is unaffected.

## Tasks (TDD; baseline 118 unit tests, smoke SMOKE OK)

1. **main.js routing → opts-driven.** Destructure `engine, expressiveVoice, exaggeration, cfgWeight,
   temperature, speedFactor, serverUrl` from the handler arg. Route when `engine === 'expressive'`.
   Merge each gen param with the tuned default (`opts.X ?? DEFAULT.X`). URL default `localhost:8004`.
   Verify the existing unit tests still pass; the default (no engine) path is unchanged.
2. **Health-check IPC.** `ipcMain.handle('expressive:health', (url))` → `{ ok }` by fetching
   `${url}/get_predefined_voices` with a short (~2 s) timeout; `ok:false` on any error/timeout.
   Add `expressiveHealth: (url) => ipcRenderer.invoke('expressive:health', url)` to preload.
3. **Settings schema.** Add to `SETTINGS_KEYS`: `ttsEngine, expressiveVoice, exaggeration, cfgWeight,
   temperature, speedFactor`. (save-settings whitelists; load-settings unchanged.)
4. **index.html — Voice panel.** At the top of `#voice-panel`, add a segmented `#engine-toggle`
   (`Offline` / `Expressive`). Wrap the existing Kokoro `#voice-list` in `#kokoro-voice-section`.
   Add `#expressive-voice-section` (hidden by default): an `#expressive-voice-list` + four labeled
   range sliders (`#exaggeration-range` 0.25–1.5, `#cfg-range` 0–1, `#temperature-range` 0.5–1,
   `#speedfactor-range` 0.5–1.5; step 0.05) each with a live `aria-live` label. Reuse existing
   `.setting` / `.segmented` / `.voice-list` styles.
5. **app.js — state + voices.** Add state defaults (`ttsEngine:'kokoro'`, `expressiveVoice:'Axel.wav'`,
   the four params). Add `EXPRESSIVE_VOICES` (grouped Female/Male). `buildExpressiveVoiceList()`
   mirroring `buildVoiceList()` (pick + ▶ preview per voice). Call it **before** `loadSettings()`.
6. **app.js — engine switch + sliders.** `setEngine('kokoro'|'expressive')`: toggle section
   visibility, mark, `state.player?.reload()`, `saveSettings()`. On panel open, call
   `reader.expressiveHealth()` and disable the Expressive segment + show the hint if down. Each slider:
   `input` → live label; `change` → set state + `reload()` + `saveSettings()`. `markActiveExpressiveVoice()`.
7. **app.js — synthOpts() + wiring.** Add `synthOpts()`; use it in the player synth closure and in
   previews. Expressive preview posts `{engine:'expressive', expressiveVoice: <that voice>, ...params}`.
8. **app.js — persistence.** Extend `gatherSettings()` (all six keys) and `applySettings()` (set state
   + reflect UI directly, NO reload during boot — mirror the existing voice/speed handling; then set
   the correct visible section from `ttsEngine`).
9. **Regression + package.** `npm test` (add pure tests where logic warrants — e.g. a `synthOpts`
   shape test if extracted; the routing is covered by existing expressive-tts/clip-cache tests).
   `npm run smoke` must stay **SMOKE OK** (default Kokoro path untouched).

## Acceptance criteria

**Builder-verifiable (must all hold):**
- `npm test` green (≥118), `npm run smoke` **SMOKE OK** — default Kokoro narration + all prior
  assertions unchanged (engine defaults to kokoro; no server in CI).
- Engine toggle renders; switching to Expressive shows the 28 grouped voices + four sliders; switching
  back shows the Kokoro list. Selections + slider values **persist across a restart** (settings.json).
- With no server reachable, the Expressive option is disabled with the hint and the app still runs.
- `main.js` no longer routes on the env var alone — only on `engine === 'expressive'`.

**User by-ear / by-eye (the real gate — cannot be automated):**
- Selecting a voice + adjusting the sliders changes narration to match (restart-on-change via reload).
- Previews play the right voice with the current params.
- The default (Axel + tuned params) sounds like the Web-UI tuning.

## Gotchas (from the codebase — respect these)

- **The sacred DOM contract:** never rebuild `readingEl.innerHTML` for a voice/engine change — only
  `reload()` (flush prefetch + replay current sentence). `setView()` stays CSS-only.
- **`buildExpressiveVoiceList()` before `loadSettings()`** so `applySettings`' mark step has buttons.
- **`applySettings` must NOT call `setEngine/setVoice/setSpeed`** (they `reload()`+`save()` — a boot
  storm, and there's no player yet). Set state + reflect UI directly, like the existing voice/speed path.
- **Slider apply on `change`, not `input`** (input only updates the label) — else every drag tick
  re-synthesizes. Same rule the speed slider already follows.
- **Cache correctness is already handled** (every gen param is in the clip-cache key) — just make sure
  the renderer actually sends the params so the key varies.
- **Do not touch** offline/CPU Kokoro, the utilityProcess, or the one-clip-per-sentence design.

## Out of scope (YAGNI)

- Voice cloning (later phase). The companion installer (Phase 2b — separate plan). Per-book voice
  memory (global only). Accent sub-grouping (all US for now). The M5/MLX runtime (later).

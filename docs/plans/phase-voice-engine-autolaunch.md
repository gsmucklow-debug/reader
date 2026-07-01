# Phase — Reader-managed Voice Engine (auto start/stop) — Design + Plan (2026-07-01)

> Reader launches the Chatterbox server itself when the user switches to the Expressive engine,
> and stops it on exit — no terminal, no icon. Decided with the user 2026-07-01 ("Fully automatic").
> A step toward the full companion installer (Phase 2b); the server is still separately installed,
> Reader just manages its lifecycle. **Windows-only** for now (the M5 runtime differs — deferred).
> Continues on branch `expressive-voice-cloning`.
>
> **Run with:** a fresh **Sonnet 5** builder (well-scoped). Opus planned + verifies.

## The proven launch command (validated via the Start Voice Engine.vbs)

```
<voiceEngineDir>\python_embedded\python.exe start.py --portable
```
cwd = `<voiceEngineDir>`, run **hidden** (`windowsHide: true`), Reader owns the child. `--portable`
skips the install-mode prompt (non-interactive). Readiness = `GET <url>/get_predefined_voices` returns
200 (same probe as `expressive:health`). Default `<url>` = `http://localhost:8004`.

## Decisions (locked with the user)

- **Fully automatic:** switching to Expressive starts the engine (if not already running); closing
  Reader stops it (only if Reader started it). No buttons.
- **Reuse:** before spawning, health-check — if the server is already up (user started it via the VBS
  or a terminal), just use it and mark it **external** (do NOT kill it on quit).
- **Engine folder:** a persisted setting `voiceEngineDir`. If unset the first time the user needs it,
  prompt once with a **folder picker** (validate it contains `python_embedded\python.exe` + `start.py`),
  then remember. Never hardcode a user path in shipped source.
- **Windows-only:** guard everything on `process.platform === 'win32'`. On other OSes (and until the
  M5 runtime exists) auto-launch is inert; the Expressive option falls back to its current
  "unreachable → disabled + hint" behavior.

## Architecture

**main.js — a small VoiceEngine lifecycle manager:**
- State: `child` (the spawned process or null), `startedByUs` (bool), `dir` (from settings).
- `engine:ensureRunning(url, dir)`:
  1. Health-check `url`. If up → return `{ ok: true, external: true }` (reuse; don't track).
  2. Else, need to spawn. If `dir` missing/invalid → return `{ ok: false, reason: 'no-dir' }` (renderer
     prompts to locate).
  3. Spawn `python_embedded\python.exe start.py --portable` (cwd=dir, `windowsHide:true`,
     `stdio:'ignore'`). Store `child`, `startedByUs=true`.
  4. Poll health every ~1.5s up to ~60s. On 200 → `{ ok: true, started: true }`. On timeout/spawn
     error → kill any child, `{ ok: false, reason: 'start-failed' }`.
  - Concurrency-guard: if a start is already in flight, return the same promise (no double-spawn).
- `engine:locate()` → folder picker (`openDirectory`), validate, persist `voiceEngineDir`, return the
  path or null.
- `engine:status()` → `{ running, startedByUs }` (quick health-check).
- **Stop on quit:** `app.on('before-quit')` (and `will-quit`) → if `startedByUs && child`, kill the
  **tree** (`spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'])`) — start.py spawns a child
  uvicorn, so `/T` is required. Guard against re-entry (quit can fire twice).
- Preload: `engineEnsureRunning`, `engineLocate`, `engineStatus`.

**Renderer (app.js) — auto-start on Expressive:**
- `setEngine('expressive')` (and boot restore when persisted engine is expressive): call
  `reader.engineEnsureRunning(url, dir)`. While awaiting, show a **"Starting Voice Engine…"** state on
  the engine toggle / hint. On `ok` → enable Expressive, refresh health, proceed. On `no-dir` → call
  `engineLocate()`; if the user picks a valid folder, retry; if they cancel, revert to Kokoro with the
  existing hint. On `start-failed` → show a gentle "Couldn't start the Voice Engine" message and keep
  Kokoro working (never break narration).
- The existing per-sentence Kokoro fallback stays — if the engine dies mid-read, narration continues on
  Kokoro.
- **Do not auto-start from the panel-open health probe** — only from an explicit switch to Expressive
  (or boot restore of a persisted Expressive engine). Panel-open just reflects status.

## Settings

Add `voiceEngineDir` (string path) to `SETTINGS_KEYS`. That's the only new persisted field.

## Tasks (TDD; baseline 133 unit tests, smoke SMOKE OK)

1. **VoiceEngine manager module** (`src/main/voice-engine.js`, extracted for testability like
   `expressive-tts.js`): pure-ish helpers — `engineCommand(dir)` (returns exe + args + cwd),
   `validateEngineDir(dir, fsExists)` (has python_embedded/python.exe + start.py), and a
   `pollUntilReady({healthFn, intervalMs, timeoutMs, sleepFn})` state machine. Unit-test all three
   (injected fakes: no real fs, no real spawn, no real timers). The actual `spawn`/`taskkill` glue lives
   in main.js and calls these.
2. **main.js IPCs** + lifecycle (ensureRunning/locate/status, before-quit kill). Reuse `expressive:health`.
3. **preload** additions.
4. **Settings** `voiceEngineDir`.
5. **Renderer** auto-start flow + "Starting…" / locate / error states; boot restore.
6. **Regression:** `npm test` green (add the task-1 unit tests). `npm run smoke` **SMOKE OK** — the smoke
   never sets `voiceEngineDir` and forces a dead port, so ensureRunning must **no-op/needs-dir without
   spawning any process** (assert the default path is untouched; do NOT let the smoke shell out to python).

## Acceptance

**Builder-verifiable:** unit tests for command/validate/poll; `npm test` ≥ (133 + new), `npm run smoke`
**SMOKE OK** with **no python spawned** in CI (voiceEngineDir unset → ensureRunning returns needs-dir).
Default Kokoro path untouched. Windows-guarded.

**User by-ear / live (the real gate — needs the machine):** switch to Expressive with the server DOWN →
Reader prompts to locate the folder (first time) → shows "Starting…" → server comes up (~15–30s) →
Expressive enables → narration plays. Close Reader → server stops (Task Manager: no lingering python on
:8004). Switch to Expressive when the server is ALREADY up (VBS-started) → Reader reuses it and does NOT
kill it on quit.

## Gotchas

- **Never hardcode the user's path** — it's a setting with a picker + a shipped default of none.
- **Kill the tree** (`taskkill /T /F`) — start.py's child uvicorn is the actual :8004 listener; killing
  only start.py orphans it.
- **Don't spawn in CI/smoke** — gate on a configured `voiceEngineDir`; the smoke leaves it unset.
- **Concurrency:** guard `ensureRunning` so a rapid double-toggle doesn't spawn two servers.
- **Reuse, don't hijack:** only kill a server Reader itself started (`startedByUs`).
- **Windows-only:** `process.platform === 'win32'` guard; inert elsewhere (M5 runtime is a later phase).
- Keep the existing "unreachable → disabled + hint" and per-sentence Kokoro fallback intact.

## Out of scope

- Bundling the server into Reader (full companion installer — later). The M5/MLX runtime. A manual
  Start/Stop button (user chose fully-automatic). Non-Windows auto-launch.

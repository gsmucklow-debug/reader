# Android Port — Design

> **Status:** Brainstormed & agreed with the user (2026-07-05). Voice spike is the go/no-go
> gate; nothing past it is built until the spike returns an acceptable number. No plan/code yet.
> **Target device:** Samsung Galaxy S24 Ultra (Snapdragon 8 Gen 3).

## Goal

Run Reader as a **full, offline app on Android** — add books, library, narration, and
sentence highlighting entirely on the phone, no PC and no cloud. Honors the same core
constraints as desktop: sentence-level one-clip-per-sentence sync, calm/low-load UI,
offline/free/private, auto-resume, no fiddly UX.

## The four load-bearing decisions

1. **Full app, offline** — on-device synthesis, no companion PC, no server-side voice.
2. **Capacitor shell** — a native APK whose one screen is a full-screen WebView running the
   *existing* renderer. Capacitor replaces Electron; the renderer doesn't know the difference.
   Chosen over PWA (weak background audio / file access / offline model storage on Android) and
   over a React-Native rewrite (throws away the vanilla-JS renderer).
3. **Voice spike first** — the on-device voice is the only real unknown; measure it on the real
   S24 before building anything else (mirrors how the desktop voice was de-risked).
4. **Spike delivered as a sideloaded APK** — truest to the final WebView environment (no
   Chrome-vs-WebView proxy gap). User taps to install like any downloaded app; no terminal on
   the user's side.

## Architecture — the reuse map

Capacitor project, one WebView screen loading today's renderer HTML/CSS/JS. Code splits three ways:

**Ports unchanged (~90%):**
- Renderer: DOM, per-sentence highlight, popovers, three view modes, pagination.
- Parsers: `epub.js` (`jszip`+`cheerio`), `markdown.js` (`marked`), `docx.js` (`mammoth`).
- Pure modules: `split-sentences`, `reading-cursor`, `player`, `paginate`, `pronounce`,
  `word-at-offset`, `tts-normalize`, plus `library.js`'s pure logic (idempotent-by-hash,
  resume address, finished-split).

**Rewritten as Capacitor plugins — the three native edges:**
- **TTS** — replaces the Electron `utilityProcess` + `onnxruntime-node`. Backed by the
  spike-chosen engine (WASM-in-WebView or native plugin). Hides behind the existing
  `reader.synthesize(text, opts)` seam — the renderer's only voice touchpoint.
- **File import** — replaces desktop drag-drop / OS dialog with Android's document picker
  (Capacitor Filesystem). Read bytes → same `parseDocument` dispatcher.
- **Storage** — replaces desktop `userData/` (library index, copied originals, covers, clip
  cache, `settings.json`) with the app's private Android storage. Data shapes identical, so
  auto-resume / finished / remove / per-book progress come free.

**Dropped on Android (by design):**
- Electron main process + IPC.
- The entire Chatterbox / expressive-GPU path — desktop-NVIDIA-only. **Kokoro-CPU is the phone
  voice**, which is the desktop default anyway. Android's Voice panel = Kokoro voices + speed +
  end-of-chapter pause only.

The clean seam that makes this work already exists: the renderer only ever calls
`reader.synthesize(text, opts)`. On Android that routes to the new engine instead of IPC —
same contract, new backend.

## The voice spike (the go/no-go gate)

A throwaway, but delivered as a real sideloaded APK so the WebView environment is authentic.

**What it is:** a minimal Capacitor app — one page, a text box pre-filled with short/medium/long
sentences, a "Read this" button, an on-screen readout. Bundles the Kokoro model as an app asset
and runs `kokoro-js` via **`onnxruntime-web`** in the WebView. No library, no parsing, no polish.

**Spike prerequisites (fold into scope — these decide whether the number is truthful):**
- **Run inference in a Web Worker**, not on the WebView main thread. This is the phone's
  equivalent of the desktop `utilityProcess`: ORT inference is synchronous and will otherwise
  freeze highlighting/scroll during every ~1–4 s synth *and* fight audio during prefetch (which
  synths a clip while another plays). Main-thread inference would make WASM look unusable when
  the real fix is "move to a worker."
- **Model + voice `.bin` loading flips `fs` → `fetch`.** The Node build loads `voices/*.bin` via
  `fs` and the Hugging Face fetch branch is unreachable there; in a WebView there is no `fs`, so
  the fetch branch is the *only* path. Repackage both the model and the voice `.bin`s as
  WebView-fetchable local assets (relative URL, `allowRemoteModels=false` pointed at the bundle,
  `allowLocalModels=true`). This is the most likely day-one "voice not found" failure.
- **Start from a known-working in-browser Kokoro demo** (kokoro-js / transformers.js has WASM +
  WebGPU browser examples), then point it at the S24 — collapses phonemization-in-browser, voice
  asset loading, and WASM execution into a proven baseline instead of re-discovering all three by
  porting the Node path blind.

**What it measures (per sentence):**
- **Cold synth latency** — the felt gap on a jump to an un-cached sentence (desktop q8 ≈ 1.7 s).
- **Realtime factor** (synth ÷ audio duration) — under ~0.7× means continuous play stays ahead
  via prefetch and never stutters; only discontinuous jumps are felt.
- **Quality by ear** — does Kokoro on the phone sound like Kokoro on the desktop.
- **Keep-screen-awake sanity check** — audio + highlight survive the display timeout while playing.

**Two variables it sweeps** (both are wins we already care about):
- **dtype** — q8 vs q4f16 vs fp16. The desktop spike found q8 a ~4× slow outlier; on a phone CPU
  this could be 4 s vs 1 s. This finally runs the parked dtype measurement, on the device that
  matters, and also shrinks the bundled model.
- **Execution provider** — WASM (baseline), multi-threaded WASM (needs cross-origin isolation /
  SharedArrayBuffer — may need WebView header config), and WebGPU/WebNN if the S24 exposes them.

**The decision it produces:**
- WASM-in-WebView good enough → build the full app around maximum reuse.
- Too slow → escalate to a native `onnxruntime-mobile` Capacitor plugin.
- Kokoro itself too slow/bad on-device → fall back to Android's built-in TextToSpeech (last resort).

## The three native edges — detail

**TTS backend.** `reader.synthesize(text, opts)` routes to the spike-chosen engine returning WAV
bytes; `player.js` (play clip N, highlight, prefetch ±, rewind-by-replay) is untouched. The
**clip cache** stays — content-addressed `sha1("<voice> <speed> <text>")`, written to Android
storage instead of `userData/clips`; cached rewinds/re-reads stay instant (matters *more* on a
phone where cold synth is slower). Pronunciation overrides + `tts-normalize` still run before the
cache key.

**File import.** "Add book" → Android document picker → read bytes → same `parseDocument`
dispatcher (`.epub`/`.md`/`.docx`). Copy into app storage exactly like desktop `library.js`
(hash-keyed folder + `document.json` + cover).

**Storage.** Everything under desktop `userData/` moves to app-private Android storage via
Capacitor Filesystem. `library.js` logic is pure and ports directly; only paths + read/write
calls change.

## Screen / background audio

User is a **read-along** user (watching the highlighting). But Android's display timeout sleeps
the screen on *touch* inactivity, not on your eyes — and a sleeping WebView can suspend the
`AudioContext` and kill narration. Decision:

- **Now: keep-screen-awake while narrating** — a small Capacitor plugin, screen-on-flag held
  during playback, released on pause. Screen stays lit, highlight scrolls, audio continues.
- **Later (seam left, not built): screen-off / pocket listening** — foreground service +
  media-session (lock-screen controls). Bigger lift; its own phase if the user ever wants it.

## Phasing (each gate passes before the next)

0. **Toolchain check** — verify Android Studio + SDK + JDK + Gradle exist on the Windows dev box
   (unverified prerequisite; the genuine first action). Optional cheap pre-flight: a mobile-Chrome
   smoke of the spike page on the S24 to confirm the kokoro-js/WASM JS stack loads + phonemizes +
   produces audio at all, *before* sinking a day into Android Studio. (Chrome is only a pre-flight;
   the APK remains the measurement vehicle.)
1. **Voice spike** → the go/no-go number. Nothing else built until the user is happy with it.
2. **Capacitor skeleton + silent reading** → renderer + parsers + file import + storage; books
   read *silently* on the phone (proves the 90% reuse + library/resume port).
3. **Wire the voice** → drop the spike-chosen engine behind `reader.synthesize`; add
   keep-screen-awake. Now it reads aloud.
4. **Delivery** → signed APK to sideload; decide later whether Play Store is worth it.

## Risks named up front

- **Main-thread WASM jank** → mitigated by the Web Worker requirement (spike scope).
- **`fs` → `fetch` asset loading** → spike prerequisite #1; likely first failure if missed.
- **Threaded WASM cross-origin isolation** (SharedArrayBuffer) → may need WebView header config;
  spike surfaces it.
- **Model size in the APK** — the ~88 MB q8 model as a bundled asset makes a chunky APK; a smaller
  dtype (q4f16) helps size *and* speed (why the spike sweeps it).
- **AudioContext suspend on screen sleep** → keep-screen-awake for the read-along case.
- **Dev toolchain** — Android Studio/Gradle unverified on this PC. No-terminal holds for the
  *user* (tap-to-install only); the builds run on the dev box.

## Constraints carried intact

Sentence-level one-clip-per-sentence sync · calm/low-load UI · offline/free/private · auto-resume ·
no fiddly UX. None change on Android. Expressive/Chatterbox is desktop-GPU-only and explicitly out
of scope for the phone.

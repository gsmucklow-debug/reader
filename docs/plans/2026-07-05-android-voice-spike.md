# Android On-Device Voice Spike — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Measure whether Kokoro TTS runs acceptably **on-device** in an Android WebView on the
Samsung Galaxy S24 Ultra — a throwaway spike that returns a go/no-go number (cold synth latency +
realtime factor + quality by ear) before any real port work begins.

**Architecture:** A minimal Capacitor app: one WebView page that runs `kokoro-js` via
`onnxruntime-web`, with **inference in a Web Worker** (the phone's equivalent of the desktop
`utilityProcess`) and the **model + voices bundled as WebView-fetchable local assets** (`fs` →
`fetch`). Delivered as a sideloaded APK. It is disposable — its only output is measurements written
back into the Reader repo.

**Tech Stack:** Capacitor 6/7, `kokoro-js`, `onnxruntime-web` (via `@huggingface/transformers`),
a Web Worker, Android Studio toolchain (Gradle wrapper).

**Why this shape (do not skip):** see the design doc
[`2026-07-05-android-port-design.md`](./2026-07-05-android-port-design.md). The three prerequisites
(Web Worker, `fs→fetch` asset loading, start-from-a-working-demo) are what make the measured number
*truthful*. A main-thread port of the Node path would make WASM look unusable for the wrong reason.

**This is a SPIKE, not a feature.** There are no unit tests to write — the "verification" at each
gate is an observed measurement or a working page. Keep it disposable; do not wire it into the
Reader app. Findings land in `docs/plans/2026-07-05-android-voice-spike-findings.md`.

**Location:** build the spike project in a **sibling** folder, `f:/Coding Projects/reader-android-spike/`,
to keep the Reader repo clean. Only the findings doc is written into the Reader repo.

**Prerequisite:** Android Studio installed (Standard setup → SDK + platform-tools + bundled JBR JDK +
Gradle). Re-run the toolchain check before starting Task 3.

---

## Phase A — De-risk the JS stack in desktop Chrome first (before Android Studio)

> Collapses the three JS-stack risks (phonemization-in-browser, offline voice/model loading, WASM
> execution) into a proven baseline on a fast machine, so the Android build isn't the place you
> discover a `kokoro-js` API mismatch. Chrome here is only a pre-flight; the APK is the real
> measurement vehicle.

### Task 1: Bare browser Kokoro page loading from the network (known-working baseline)

**Files:**
- Create: `f:/Coding Projects/reader-android-spike/web/index.html`
- Create: `f:/Coding Projects/reader-android-spike/web/main.js`
- Create: `f:/Coding Projects/reader-android-spike/package.json`

**Step 1: Scaffold and install.**

```bash
cd "f:/Coding Projects"
mkdir reader-android-spike && cd reader-android-spike
npm init -y
npm install kokoro-js
```

**Step 2: Write `web/main.js`** — start from the official kokoro-js browser example (confirmed API):

```javascript
import { KokoroTTS } from "kokoro-js";

const model_id = "onnx-community/Kokoro-82M-v1.0-ONNX";
const $ = (id) => document.getElementById(id);

let tts = null;

async function load(dtype, device) {
  const t0 = performance.now();
  tts = await KokoroTTS.from_pretrained(model_id, { dtype, device });
  return performance.now() - t0;
}

async function synth(text, voice) {
  const t0 = performance.now();
  const audio = await tts.generate(text, { voice });   // RawAudio
  const ms = performance.now() - t0;
  const wav = audio.toWav();                            // ArrayBuffer (24 kHz)
  const durationSec = audio.audio.length / audio.sampling_rate; // confirm field names vs the demo
  return { ms, wav, durationSec };
}

window.__spike = { load, synth };  // driven from the page buttons (Task 2)
```

**Step 3: Write `web/index.html`** — dtype/device dropdowns, three pre-filled sentences
(short ≈5 words / medium ≈20 / long ≈40), a "Load" button, a "Read each" button, and a results
`<pre>`. Play the WAV via `new Audio(URL.createObjectURL(new Blob([wav],{type:'audio/wav'})))`.

**Step 4: Serve and open in desktop Chrome.**

```bash
npx vite web --open    # or any static server that supports ES modules
```

Expected: model downloads once from HF, then a synth of each sentence logs `{ms, durationSec}` and
plays audible Kokoro speech. **This is the baseline — confirm the API field names against what the
demo actually returns and fix the snippet before proceeding.**

**Step 5: Commit.**

```bash
cd "f:/Coding Projects/reader-android-spike"
git init && git add -A && git commit -m "spike: baseline browser kokoro-js page (network model)"
```

---

### Task 2: Move inference into a Web Worker

> ORT inference is synchronous; on the main thread it freezes the UI during synth and fights audio
> during prefetch. The worker is the phone's `utilityProcess`. Prove it here where it's easy to see.

**Files:**
- Create: `f:/Coding Projects/reader-android-spike/web/tts-worker.js`
- Modify: `f:/Coding Projects/reader-android-spike/web/main.js`

**Step 1: Move `load` + `synth` into `tts-worker.js`** (a module worker). The worker owns `tts`;
`main.js` posts `{type:'load',dtype,device}` / `{type:'synth',text,voice}` and gets back
`{ms, durationSec}` + the WAV bytes (transfer the ArrayBuffer).

**Step 2: Prove non-blocking.** Add a CSS spinner that animates continuously. Trigger a synth;
confirm the spinner **keeps spinning** during synth (it would stall if inference were on the main
thread).

**Step 3: Commit** `spike: run inference in a Web Worker (non-blocking)`.

---

### Task 3: Serve model + voices from LOCAL assets (`fs` → `fetch`, offline)

> The Node build loads `voices/*.bin` via `fs`; that branch does not exist in a WebView, so the
> `fetch` branch is the only path. This is the most likely day-one "voice not found" failure. Prove
> offline loading works in Chrome (DevTools → Network → Offline) before packaging.

**Files:**
- Create: `f:/Coding Projects/reader-android-spike/web/assets/` (bundled model + voices)
- Modify: `f:/Coding Projects/reader-android-spike/web/tts-worker.js`

**Step 1: Copy the model locally.** Reuse the Reader repo's downloader output — the model already
lives at `f:/Coding Projects/Reader/assets/models/...` after `node scripts/fetch-model.js`. Copy the
`onnx-community/Kokoro-82M-v1.0-ONNX` tree (config + the needed `onnx/*.onnx` dtype files) into
`web/assets/models/`.

**Step 2: Copy the voices.** The voice `.bin`s ship in `Reader/node_modules/kokoro-js/voices/*.bin`.
Copy the curated set into `web/assets/voices/`.

**Step 3: Point transformers.js at the local tree, network off.** In the worker, before importing
`kokoro-js`, configure the transformers env (load-order matters — mirror the desktop
`tts-service.js`):

```javascript
import { env } from "@huggingface/transformers";
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = new URL("./assets/models/", import.meta.url).href;
// then import kokoro-js so it inherits this transformers singleton
const { KokoroTTS } = await import("kokoro-js");
```

**Step 4: Resolve the voice path.** `kokoro-js` fetches voice data by URL in the browser. **Verify
against the kokoro-js source how it builds that URL** and override it to point at
`web/assets/voices/` (this is the spike's #1 setup gotcha — expect to spend time here). Confirm a
non-default voice (e.g. `bf_emma`) loads, not just `af_heart`.

**Step 5: Prove offline.** DevTools → Network → **Offline**, reload, load + synth. Expected: audio
still generates with **zero network requests**. Commit `spike: model+voices from local assets, offline`.

---

## Phase B — Package as a Capacitor APK and measure on the S24

> Re-run the toolchain check (JDK via Android Studio JBR, `%LOCALAPPDATA%/Android/Sdk`, `adb`) and
> confirm it resolves before this phase.

### Task 4: Wrap the web page in a Capacitor project

**Files:**
- Modify: `f:/Coding Projects/reader-android-spike/package.json`
- Create: Capacitor config + `android/` project (generated)

**Step 1: Add Capacitor and initialise.**

```bash
cd "f:/Coding Projects/reader-android-spike"
npm install @capacitor/core @capacitor/cli
npx cap init reader-voice-spike com.reader.voicespike --web-dir=dist
```

**Step 2: Build the web assets to `dist/`** (bundle the worker + assets; ensure the `.onnx`, `.bin`,
and `ort-*.wasm` files are emitted and referenced by relative URLs). A single `vite build` with the
assets under `web/assets/` copied into `dist/` is enough — the point is *relative* fetchable paths.

**Step 3: Add the Android platform and copy.**

```bash
npm install @capacitor/android
npx cap add android
npx cap copy android
```

**Step 4: Commit** `spike: wrap page in Capacitor + add android platform`.

### Task 5: Enable threaded WASM (cross-origin isolation) — best-effort

> Multi-threaded WASM needs `SharedArrayBuffer`, which needs COOP/COEP (cross-origin isolation).
> In a Capacitor WebView the app is served from a local scheme; set the isolation headers via the
> server config / a WebView response-header tweak. If it won't isolate, fall back to single-thread
> WASM — **measure both** so we know the cost.

**Step 1:** Configure `capacitor.config` server headers (or the Android `WebViewClient`) to send
`Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`. Verify
`self.crossOriginIsolated === true` and `typeof SharedArrayBuffer !== 'undefined'` in the WebView.

**Step 2:** In the worker, set ORT threads (e.g. `ort.env.wasm.numThreads = navigator.hardwareConcurrency`)
when isolated, else `1`. Commit `spike: threaded WASM when cross-origin isolated`.

### Task 6: Add the measurement UI + dtype/EP/keep-awake controls

**Files:**
- Modify: `web/index.html`, `web/main.js`

**Step 1: Build a small results grid.** For each combination the tester picks — **dtype** ∈
{q8, q4f16, fp16} × **execution provider** ∈ {WASM-1-thread, WASM-multi, WebGPU (if
`navigator.gpu`)} — run all three sentence lengths and record: load ms, per-sentence synth ms,
audio duration, and **realtime factor = synth ÷ duration**. Show a copyable text table.

> Note: for `device:"webgpu"`, kokoro-js recommends `dtype:"fp32"` — treat WebGPU as its own row,
> not a dtype sweep.

**Step 2: Keep-awake sanity.** Add `@capacitor-community/keep-awake` (or the WebView
`FLAG_KEEP_SCREEN_ON`); hold it during a synth loop. Manually confirm the screen does not sleep and
audio continues through what would have been the display timeout.

**Step 3: Commit** `spike: measurement grid + dtype/EP sweep + keep-awake`.

### Task 7: Build, sideload, measure on the real S24 Ultra

**Step 1: Build the debug APK.**

```bash
cd "f:/Coding Projects/reader-android-spike/android"
./gradlew assembleDebug
# APK at android/app/build/outputs/apk/debug/app-debug.apk
```

**Step 2: Get it onto the phone (no-terminal for the user).** Either `adb install app-debug.apk`
(USB, developer mode) *or* hand the `.apk` file to the user to tap-install (enable "install from this
source" once). The user taps to install.

**Step 3: Measure.** On the S24: run the full dtype × EP sweep across all three sentence lengths.
Record every number. **Listen** to each dtype/voice and rate quality vs desktop Kokoro. Note whether
threaded WASM / WebGPU actually engaged (or silently fell back).

**Step 4: Commit** any spike-code tweaks needed to get it running on-device.

---

## Phase C — Decide

### Task 8: Write the findings + recommendation

**Files:**
- Create: `f:/Coding Projects/Reader/docs/plans/2026-07-05-android-voice-spike-findings.md`

**Record (mirror the desktop `spike-voice-latency-findings.md` style):**
- A table: dtype × execution provider × sentence length → load ms, synth ms, realtime factor.
- The best (dtype, EP) combo on the S24, and its cold-synth latency + realtime factor.
- Quality-by-ear notes per dtype/voice.
- Whether threaded WASM / WebGPU worked in the WebView, and cross-origin-isolation outcome.
- Keep-awake result.
- APK size per bundled dtype (feeds the model-size risk).

**The recommendation must answer:**
1. **Go / no-go on full-offline on-device voice** — is cold latency + realtime factor acceptable
   (realtime factor < ~0.7 means continuous play never stutters; only cold jumps are felt)?
2. **WASM-in-WebView vs native `onnxruntime-mobile` plugin** — is the WebView path good enough, or
   must we escalate to native?
3. **Which dtype** to ship on Android (also settles the parked desktop dtype question on ARM).
4. If Kokoro-on-device is unacceptable at any dtype/EP: fall back to Android built-in TTS (last
   resort, documented).

**Step: Commit the findings into the Reader repo** and update `docs/HANDOFF.md` (What's done +
Next up) with the outcome.

```bash
cd "f:/Coding Projects/Reader"
git add docs/plans/2026-07-05-android-voice-spike-findings.md docs/HANDOFF.md
git commit -m "docs(android): voice spike findings + go/no-go recommendation"
```

---

## Notes for the executor

- **Keep it disposable.** Do not import Reader app code or wire the spike into the app. The only
  durable artifacts are the findings doc + HANDOFF update in the Reader repo.
- **When the API doesn't match the snippet, trust the running demo, not this plan** — the field
  names (`audio.audio`, `audio.sampling_rate`, the voice-URL resolution) must be confirmed against
  the actual `kokoro-js` version installed. This plan's code is representative.
- **Do not "fix" WASM by moving inference back to the main thread** to make something work — that
  invalidates the whole measurement (see design doc).
- **No GPU rabbit-holes on desktop** — WebGPU here is only the *phone's* GPU via the WebView; the
  desktop DirectML dead-end is unrelated.

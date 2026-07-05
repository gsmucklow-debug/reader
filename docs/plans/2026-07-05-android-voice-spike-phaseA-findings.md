# Android Voice Spike — Phase A findings (desktop pre-flight)

> **Scope:** Phase A of [`2026-07-05-android-voice-spike.md`](./2026-07-05-android-voice-spike.md) —
> the desktop pre-flight that de-risks the kokoro-js / ORT-web JS stack **before** building the APK.
> **This is NOT the go/no-go gate.** The real speed answer needs the APK on the S24 Ultra (Phase B);
> these numbers are desktop, single-thread WASM, and only prove the stack *works*, loads *offline*,
> and doesn't *block*. Spike project: `f:/Coding Projects/reader-android-spike/` (separate git repo).
> Driven headless via the Playwright MCP browser (Chromium — same engine class as the Android WebView).

## What was proven (all three Phase A questions: YES)

1. **The stack runs in a browser engine.** kokoro-js's web build (`dist/kokoro.web.js`, self-contained
   2 MB ESM exporting `KokoroTTS`/`TextSplitterStream`/`env`) + `onnxruntime-web` WASM loads the
   Kokoro-82M model, phonemizes, and emits valid 24 kHz WAV audio (byte lengths track durations).
2. **Inference is non-blocking in a Web Worker.** Ran synth in a module worker while a main-thread
   20 ms tick meter watched for freezes: **max gap 33 ms across ~19 s of synth** (would be ~12,000 ms
   if inference ran on the main thread). Verdict **NON-BLOCKING** — the worker is the phone's
   equivalent of the desktop `utilityProcess`; highlighting/scroll/audio stay smooth during synth+prefetch.
3. **Fully offline from local bundled assets (`fs`→`fetch` closed).** The web build hardcodes HF URLs
   for voices (`…/resolve/main/voices/${v}.bin`) and transformers.js fetches the model from the hub —
   no `fs` path exists in a WebView. A worker-side `fetch` rewrite maps those URLs to local `/assets/`,
   and `env.wasmPaths` points ORT at a local wasm copy. **With `transformers-cache` + `kokoro-voices`
   Cache Storage CLEARED, a non-default voice (`bf_emma`) still loaded + synthesized with 0 remote
   fetches** — proving the bytes come from bundled assets, not warm cache. (Production should ship this
   rewrite as a **Service Worker**; the web build doesn't expose transformers' `localModelPath`.)

## Numbers (desktop Chromium, single-thread WASM, af_heart, medium+long)

Steady-state realtime factor (RTF = synth ÷ audio duration; <1.0 means continuous play stays ahead):

| dtype | synth (long, ~14 s audio) | RTF (long) | model download | note |
|-------|---------------------------|------------|----------------|------|
| q8    | 10.4 s | 0.72 | 89 MB | already local; the current desktop default |
| q4f16 | 7.9 s  | 0.55 | ~40 MB | |
| fp16  | 7.5 s  | 0.52 | ~160 MB | biggest bundle |

- **First-inference warm-up** is real: the first (short) synth of a session pays extra (RTF 1.0–1.2);
  it settles after. Wire a silent warm-up synth at load (desktop already does this in `main.js`).
- **"Load" times are download+init, not a dtype cost.** q8 3.7 s (network) vs 0.9 s (local) vs fp16
  12.8 s (bigger download). In the bundled app the model is local — load is ~sub-second. Ignore the
  download component when reasoning about the shipped app.

## The dtype finding — a NEW datapoint, not a contradiction

The parked desktop dtype work found **q8 ~4× slower** than fp16/q4f16. That was measured on
`onnxruntime-**node**` (native CPU kernels, full-width SIMD, strong int8 dequant). **In WASM
(`onnxruntime-web`) the gap is only ~1.4×** (q8 0.72 vs fp16 0.52 RTF). Different execution engines
with genuinely different int8 characteristics — so **the native decision is untouched; this is a
WASM-specific datapoint for the path Android actually uses.**

**Implication runs opposite to desktop:** since q8 is already local, the smallest onnx file, and only
~1.4× slower in WASM, **q8 is a strong candidate for the Android bundle** — the reverse of the native
call. This is a *desktop-WASM hypothesis*; the S24 is a third backend (ARM, different SIMD) — **Phase B
confirms which dtype to ship.**

## Quality-by-ear samples (for the user to listen — the stack emitting WAV ≠ it sounding right)

`f:/Coding Projects/reader-android-spike/samples/` (same medium sentence throughout):
- `af_heart_q8.wav` · `af_heart_q4f16.wav` · `af_heart_fp16.wav` — **compare dtype quality by ear**
  (does q8 sound as good as fp16? if yes, q8's smaller/local bundle wins on Android).
- `bf_emma_q8.wav` (UK female) · `am_michael_q8.wav` (US male, C+) — voice spot-check.

## Honest caveats — why this is NOT a "go"

- **Desktop, not the phone.** RTF 0.5–0.7 here; the S24's Snapdragon is materially slower for
  sustained WASM SIMD. A desktop long-sentence RTF 0.72 could land **>1.0** on the phone, which breaks
  *continuous* play (not just cold jumps). **Speed is unqualified until Phase B.**
- **Single-thread WASM only.** `crossOriginIsolated`/threading was **not** confirmed engaged (native
  was 0.41; these 0.5–0.7 say single-thread). Multi-threaded WASM (needs COEP/SharedArrayBuffer in the
  WebView) may be load-bearing on the phone and is still unproven there.
- **Cold single-sentence latency is the felt cost**: medium ~3–5 s, long ~8–12 s cold *on desktop*.
  Continuous play hides it via prefetch; an arbitrary jump pays one synth. Phone will be worse.

## Recommendation for Phase B (the real gate)

Package this exact stack (web build + worker + offline rewrite/SW + local q8 assets) as the Capacitor
APK, sideload to the S24, and sweep dtype × execution provider (incl. threaded-WASM once COEP is set,
and WebGPU if `navigator.gpu` is exposed in the WebView). Decide go/no-go on the **phone's** RTF +
cold latency + ear quality. Ship the dtype that wins there (q8 is the front-runner on bundle+WASM-speed
grounds; validate).

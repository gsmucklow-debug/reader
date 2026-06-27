# Follow-up — Validate the CPU dtype on the M5, then maybe swap off `q8`

> **This is a gated change, not a sure thing.** The decision is made by **data from the MacBook Pro
> M5** (the user's primary reading device). If the win doesn't hold on the M5, **stop and keep `q8`**.
>
> **Run with:** Opus 4.8 (perf/native nuance). **Most of this must run ON the M5** (the gating
> measurement is ARM); the Windows side is small.
>
> **Context:** [`spike-voice-latency-findings.md`](./spike-voice-latency-findings.md) (the numbers +
> the dtype sweep), [`../HANDOFF.md`](../HANDOFF.md) (Phase 2 voice stack, the CPU-only decision),
> `src/main/tts-service.js`, `scripts/fetch-model.js`, `src/main/clip-cache.js`.

## Why

The voice-latency spike found the **dominant** cost is one uncached sentence synth, and that the
shipping **`q8` dtype is ~4× slower** than `fp16`/`q4`/`q4f16`/`fp32` on CPU (planner-verified on
Windows x64). Dropping `q8` is the single biggest latency lever — **CPU-only, zero per-OS divergence**,
so it honors the logged "CPU only → identical Win/Mac" decision. **But every spike number is
Windows-x64; the M5 (ARM) was never measured.** Quantization speedups are hardware-specific; we must
confirm the win survives on the actual primary device before paying the costs (below).

## The gate (do this first — it decides everything)

1. On the **M5**: `npm install` (pulls the arm64 `onnxruntime-node`), then
   `node test/manual/spike-dtype-sweep.js`. Capture the table (size / load / synth median per dtype).
2. **Decision:**
   - If `fp16`/`q4f16` is **meaningfully faster than `q8` on the M5** (say ≥1.5×) → proceed to the swap.
   - If the gap is small or **inverted** on ARM (int8 can *help* on some CPUs) → **STOP. Keep `q8`**
     (it's the smallest bundle). Record the M5 numbers in the findings file and close this out. No swap.
3. Sanity-check on Windows too (re-run the sweep here): the swap ships **one** dtype to **both** OSes,
   so the chosen precision must be acceptable on Windows *and* the M5. Pick the dtype that's fast on
   both — `fp16` (163 MB) is the safe default; `q4f16` (~155 MB) only if it's as fast **and** sounds
   identical (it's 4-bit — **listen** for quality loss before choosing it over fp16).

## The swap (only if the gate passes)

Keep it on a branch; it changes shipped behavior and bundle size.

1. **`src/main/tts-service.js:23`** — `dtype: 'q8'` → the chosen dtype (`'fp16'` or `'q4f16'`).
2. **`scripts/fetch-model.js:16`** — same dtype, so the build fetches the matching `onnx/model_*.onnx`
   (q8 = `model_quantized.onnx`; fp16 = `model_fp16.onnx`; q4f16 = `model_q4f16.onnx`). Re-fetch the
   model (`node scripts/fetch-model.js`); the loose blob at `assets/models` grows **~+70 MB** (q8 92 MB
   → fp16 163 MB). `assets/models` is gitignored — not committed; this is a build-time fetch.
3. **⚠️ Clip-cache staleness (must handle).** `clipKey(text, voice, speed)` in
   `src/main/clip-cache.js:10` **does not include dtype**. A user upgrading keeps their old `q8` clips
   on disk; the same voice/speed/text is a **cache hit → serves the old-dtype audio forever** (mixed
   quality, never the new dtype). Pick one:
   - **Add dtype to the key** (`sha1("<voice> <speed> <dtype> <text>")`) — clean cache-bust; old clips
     go cold and re-synthesize once. Thread `dtype` through `get`/`put` and the `synthesize` IPC handler
     (mirror how `speed` was threaded in Phase 2.5). **Recommended.**
   - Or clear `userData/clips` once on dtype change. Simpler but loses warm cache.
   (Correctness isn't broken either way — it's the same words in the same voice — but the key fix makes
   the new speed/quality actually take effect.)

## Verify (the model blob changed — re-prove the gate that protects it)

- `npm test` and `npm run smoke` green.
- **Packaged-offline gate:** `npm run dist:win` (and `dist:mac` on the M5), launch the packaged build,
  confirm `reader.synthesize` returns a valid WAV with the model loaded from
  `resources/assets/models` and **no network** (this is the gate `test/manual/verify-packaged.js`
  guards — the whole point of bundling). The dtype change alters which `.onnx` ships, so re-run it.
- **By ear:** the new dtype should *sound* the same (esp. if you chose `q4f16`) and the skip/jump/
  voice-switch delay should be visibly shorter.

## Done = a recommendation + (maybe) the swap

- The **M5 dtype table** recorded in the findings file.
- Either: "swap to `<dtype>` — landed on branch `<x>`, verified packaged-offline on both OSes, clip
  cache busted," **or** "M5 says no meaningful win — kept `q8`, here are the numbers."
- HANDOFF + Decisions log updated with the final dtype choice (planning session records).

## Out of scope

- GPU (a dead end on this stack — see the Decisions log). Any per-device dtype divergence (the whole
  point is **one** dtype on both OSes). Re-architecting the cache beyond the dtype key.

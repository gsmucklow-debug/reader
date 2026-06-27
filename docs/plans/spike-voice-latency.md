# Spike — Voice latency: measure, cheap wins, GPU feasibility

> **This is an investigation, not a shipping feature.** Output = a **written report with numbers +
> a recommendation**, so we decide the GPU question with data instead of guessing. The cheap
> no-divergence wins MAY be landed if clearly beneficial and low-risk (say so in the report and
> keep them on a branch); **do NOT add a GPU backend in this spike** — that's a follow-up decided
> from these findings.
>
> **Run this with:** **Opus 4.8 high** (perf reasoning + native/EP nuance).
>
> **STRICT — separation of duties:** builder/spike session. Do **NOT** edit planning docs
> (`HANDOFF.md`, `design.md`, the plans). Report in chat; the planning session records findings.
>
> **Context:** [`2026-06-27-ui-polish-and-headings-design.md`](./2026-06-27-ui-polish-and-headings-design.md),
> [`../HANDOFF.md`](../HANDOFF.md) (esp. the Phase 2 voice stack + the CPU decision/gotcha),
> `src/main/tts-service.js`, `src/main/main.js`, `src/renderer/player.js`.

## Why

The user feels a **delay** when skipping sentences, jumping chapters, and switching voice, and asked
whether running Kokoro on the **GPU** would help. This **overrides a logged decision** ("CPU only →
identical Win/Mac; do not optimize onto GPU — it reintroduces per-OS divergence"). Before paying that
complexity, measure where the time actually goes and whether GPU is even available/worth it here.

## Background (current behavior — confirm, don't assume)

- Kokoro (`kokoro-js` + `onnxruntime-node`, **CPU**, `dtype:'q8'`) runs in an Electron
  `utilityProcess`, forked **lazily on first synth/ping** (`src/main/main.js` `getTtsChild`).
- Per-sentence clips are cached on disk (`clip-cache.js`, keyed by voice+speed+text) and prefetched
  ahead (`player.js` `prefetchAhead` default 2; in-memory `maxClips` default 24).
- A voice/speed change calls `player.reload()` → **flushes the in-memory prefetch and re-synthesizes
  the current sentence** in the new params (new audio — some re-synth is unavoidable).

## Part A — Measure where the delay is (required)

Instrument timing (temporary logs / a throwaway harness; don't ship the logs). Capture, in ms, on a
warm and a cold run:
1. **Cold model load** — first `getTTS()` / first synth after launch (one-time).
2. **Single-sentence synth latency** (cache miss) — average over ~20 varied sentences; note the
   spread (short vs long sentences).
3. **Cache hit latency** — disk read + `decodeAudioData` for an already-synthesized clip.
4. **Seek/skip to an uncached sentence** — the user-felt gap from click → audio.
5. **Voice change** — `reload()` → first audio in the new voice (includes one synth).
6. **Chapter jump** — mount + first sentence (note if `goToChapter` work dominates vs synth).

Report a small table. Identify the dominant cost(s). (Hypothesis to confirm: cold load + uncached
synth dominate; cache hits are already fast — Phase 2 measured ~250× on a hit.)

## Part B — Cheap, zero-divergence wins (try + measure)

For each, measure the before/after on the Part A numbers. Keep them isolated (separate commits on a
branch) so we can choose per-item:
1. **Warm the model at launch** — fork the utilityProcess and send `ping` (already supported) shortly
   after the window loads, so the first *real* play isn't a cold start. Watch for: don't jank
   startup; it's CPU work in a child so it shouldn't block the UI.
2. **Wider prefetch** — raise `prefetchAhead` (e.g. 2 → 3–4) and/or prefetch a couple *behind* the
   cursor so a back-a-sentence is instant. Measure CPU cost vs responsiveness.
3. **Larger in-memory clip cap** — raise `maxClips` (24 → e.g. 48) so more rewind targets stay
   decoded. Measure memory.
4. **(Investigate, optional)** speculative synth of the next chapter's first sentence near chapter
   end, so a chapter jump has audio ready.

Note any win that materially closes the felt gap **without** GPU — those are the safe wins.

## Part C — GPU feasibility (probe only; do NOT wire into the app)

Answer, with evidence, for the user's **Windows / NVIDIA** box:
1. Can `onnxruntime-node` use the GPU at all here — which execution provider is available (CUDA?
   DirectML?), and does the installed package include it or need a different build/flag?
2. Does `kokoro-js` / the underlying transformers `from_pretrained` accept a device/EP that routes to
   GPU in **Node** (not webgpu-in-browser)? If kokoro-js can't pass it through, note exactly what
   would have to change.
3. If you can get a GPU run at all (even a standalone script, outside Electron), measure the
   **single-sentence synth speedup** vs CPU `q8`. Note model-load time on GPU too.
4. **Cross-platform reality:** what the macOS M5 path would be (CoreML/Metal EP) and that it's a
   *separate* backend. Sketch the **CPU-fallback** shape any GPU option must have.

**Do not** add a GPU dependency to `package.json` or change the shipping `tts-service.js` device in
this spike. A standalone probe script under `test/manual/` (gitignored or clearly throwaway) is the
right tool.

## Deliverable (report in chat)

- The Part A timing table + the dominant cost(s).
- Part B: which cheap wins helped, by how much, and your recommendation on landing each.
- Part C: is GPU available on this machine? measured speedup? what code/deps a real GPU option needs;
  the CPU-fallback + per-OS shape; and a **clear recommendation** — "the cheap wins are enough" vs
  "GPU is worth a follow-up phase, here's the scope/cost."
- Anything you changed, on a branch, clearly labeled (so the planning session can choose what to keep).

## Out of scope

- Shipping a GPU backend; changing the default device; any UI for device selection. (All decided
  later from this report.)
- The Phase 2.6 UI/heading work (separate plan).

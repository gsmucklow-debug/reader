# Spike findings — Voice latency (recorded by the planning session, 2026-06-27)

> Companion to [`spike-voice-latency.md`](./spike-voice-latency.md) (the brief). The builder ran the
> spike on branch `spike/voice-latency` (3 commits + 4 throwaway harnesses); **nothing shipped**. This
> file is the durable record of the numbers + decisions so the brief's tables aren't lost. Findings are
> **builder-reported** unless marked planner-verified.

**Hardware:** Windows x64, AMD Ryzen 7 9800X3D, RTX 5070 Ti. ⚠️ This is a **fast desktop CPU** — the
magnitude of the dtype finding below is hardware-dependent (see caveats).

**⚠️ Primary reading device is the MacBook Pro M5 (24 GB), not this box (user, 2026-06-27).** Most real
use will be on the M5 — which is **ARM and was never touched by this spike**. So the dtype win below is
**unvalidated on the actual primary target**; re-measuring on the M5 is the *gating* step before any
swap, not optional polish.

---

## Part A — Where the delay is

| # | Measurement | Result | Notes |
|---|---|---|---|
| A1 | Cold model load (one-time) | ~550 ms load + ~900 ms first inference ≈ **1.45 s** to first audio | q8, CPU |
| A2 | Single-sentence synth (cache miss) | median **~1.7 s**; short ~0.5 s; long (110–160 ch) ~3–4 s | scales w/ tokens; **0.41× realtime** |
| A3 | Cache hit (disk read + IPC) | **2 ms** | the ~250× Phase-2 win confirmed |
| A3 | `decodeAudioData` per clip | 5 ms | negligible |
| A4 | Seek/skip to uncached sentence | = one uncached synth (~1.7 s typ., ~3 s long) + 5 ms decode | nothing else material |
| A5 | Voice change (`reload()` → first audio) | = one uncached synth; flush is a `Map.clear()` (instant) | new audio unavoidable |
| A6 | Chapter jump | DOM mount + paginate = **6 ms**; felt gap = first sentence's synth | `goToChapter` does **not** dominate |

**Dominant cost: uncached single-sentence synth.** Everything else — cache hits, decode, DOM mount,
even cold load — is negligible by comparison. Continuous playback never stutters (synth at 0.41×
realtime keeps ahead); only **discontinuous jumps to a cold sentence** are felt.

## Headline finding — the shipping `q8` model is the slowest dtype (CPU dtype sweep, warm cache)

| dtype | size | load | synth median |
|---|---|---|---|
| fp32 | 326 MB | 510 ms | 493 ms |
| fp16 | 163 MB | 641 ms | 492 ms |
| **q8 (shipping)** | **92 MB** | 416 ms | **1878 ms** |
| q4 | 305 MB | 398 ms | 458 ms |
| q4f16 | 155 MB | 654 ms | 502 ms |

**q8 is the sole outlier — every other precision is ~4× faster.** On this CPU the int8 dequant
overhead outweighs its benefit. Dropping q8 cuts the **dominant** Part-A cost ~4× (≈1.9 s → ≈0.5 s),
CPU-only, **zero per-OS divergence** — far larger than any prefetch tuning, and exactly the kind of
win the spike was hunting. **This is the spike's highest-value result — bigger than all of Part B and
the entire GPU question combined.**

**✅ Planner-verified — independently re-ran `spike-dtype-sweep.js` on the same box (2026-06-27),
reproducing the builder's table within noise:**

| dtype | size | load | synth median (planner re-run) | (builder) |
|---|---|---|---|---|
| fp32 | 326 MB | 544 ms | 503 ms | 493 |
| fp16 | 163 MB | 683 ms | 497 ms | 492 |
| **q8** | 92 MB | 435 ms | **1954 ms** | 1878 |
| q4 | 305 MB | 458 ms | 471 ms | 458 |
| q4f16 | 155 MB | 748 ms | 495 ms | 502 |

The q8 ~4× penalty is real and reproducible. **But this is still a Windows-x64 / fast-desktop number —
the M5 (the primary device) remains the open question.**

**But it is gated — do NOT just swap the model:**
- **Magnitude is hardware-dependent.** 9800X3D is among the fastest consumer CPUs. On a weak laptop
  int8 may actually help; the 4× could shrink or invert. (Matters only for low-end / public distribution.)
- **Mac is completely untested.** All numbers are Windows x64; M-series is ARM. Re-measure on the M5
  before assuming the gain holds — this is the one genuine unknown for *this* user's targets.
- **Real costs:** +70 MB bundle (q8 92 MB → fp16 163 MB), re-triggers the packaged-offline synth gate
  (`verify-packaged.js`) + a fresh model download/bundle. q8 was likely chosen deliberately for size.

**Recommendation:** treat **fp16** (or **q4f16**, ~155 MB) as a scoped **follow-up** to validate on the
M5 (and a low-end laptop only if shipping publicly), then swap if it holds. Best speed/size trade-off of
the fast options. Not a change to land from this spike.

## Part B — Cheap, zero-divergence wins

| Item | Status | Verdict |
|---|---|---|
| 1. Warm model at launch | **Already wired** (`main.js:159` fires `ping` in `app.whenReady`). Cold load ~1.45 s is hidden behind the user opening a book. *Confirmed by reading, not re-measured.* | Keep as-is |
| 2. Wider prefetch + behind (`be3615d`) | ahead 2→3, behind 1. At 0.41× realtime, 3 stays ahead; behind-1 makes back-a-sentence an instant 2 ms cache hit instead of ~1.7 s synth. | **Mild but real (rewind).** Smoke + 68 unit tests pass |
| 3. Larger clip cap (`56da475`) | `maxClips` 24→48 (~18 MB). More rewind targets stay decoded. | Marginal; harmless |
| 4. Speculative next-chapter synth | Mostly already covered — `aheadFrom` walks `nextAddress` across chapter boundaries, so prefetch=3 already warms the next chapter's opening during continuous play. Only unpredictable TOC jumps stay cold. | Not worth dedicated code |

**Honest framing:** Part B helps rewind + continuous reading at the margins but **cannot close the
dominant felt gap** — an arbitrary jump to a cold sentence still pays one full synth. Only faster synth
(dtype) or speculative synth of *predicted* targets fixes that; the dtype lever is ~4× for one line.

## Part C — GPU feasibility (probed; nothing wired in)

- **`onnxruntime-node` (1.21.0) bundles exactly `cpu` + `dml` (DirectML)** — confirmed via
  `listSupportedBackends()`. **CUDA is not in the prebuilt Windows Node binding** (Linux-x64-only in the
  prebuilt table). The box has an RTX 5070 Ti, but the only available GPU EP is DirectML.
- **kokoro-js routes a device cleanly:** `KokoroTTS.from_pretrained(..., {device})` passes through to
  transformers.js, which maps `'dml'` → DirectML EP. **No code changes needed to attempt it.**
- **Measured GPU speedup: none.** Every DML cell (fp32/fp16/q8) **fails on first inference** at the
  vocoder's **ConvTranspose** node: `...DmlExecutionProvider... The parameter is incorrect.` The model
  loads onto DML then errors the moment it runs. **No working GPU path on this machine/stack.**
- **Cross-platform reality + fallback shape:**
  - **macOS M5** would need CoreML/Metal(MPS) EP — also not in the prebuilt `onnxruntime-node` binding; a
    **separate** backend, separately built/bundled.
  - **CUDA on Windows** would require a custom `onnxruntime-node` build + bundling CUDA/cuDNN DLLs —
    heavy, and reintroduces the per-OS divergence the logged decision avoids.
  - **Mandatory CPU fallback:** the ConvTranspose failure proves a GPU EP can load fine then fail at
    runtime on the first real sentence. Any GPU option must try the EP, catch first-inference failure,
    and fall back to CPU, per-OS — real branching complexity for, here, **zero benefit**.

## Recommendation (builder + planner agree)

1. **The cheap wins are enough; do NOT pursue a GPU backend.** GPU is a dead end on this hardware/stack
   (DirectML can't execute Kokoro; CUDA absent from the Node binding; CoreML a separate Mac backend).
   Each path is a new per-OS backend with mandatory CPU-fallback, for no measured speedup. This
   **strengthens** the logged CPU-only decision rather than overturning it.
2. **The real lever is the dtype, not the device** — drop q8 → ~4× synth cut, CPU-only, no divergence,
   on the *dominant* cost (planner-verified on Windows x64). Scope a small follow-up to validate
   fp16/q4f16 **on the M5 — the primary reading device, and the one genuinely untested target** (+ a
   low-end laptop only if distributing publicly), re-run the packaged-offline gate, account for +70 MB,
   then swap if it holds. The M5 measurement is the **gate**, not a formality.
3. **Part B commits (`be3615d`, `56da475`) are safe to keep** for the rewind/continuous polish; not
   load-bearing.

## Disposition (decided by the planning session, 2026-06-27)

- **Part B landed on master** — `be3615d`/`56da475` cherry-picked as **`85da182`** (prefetch ahead 3 +
  behind 1) and **`a525940`** (clip cap 24→48); 68/68 unit tests green after the pick. Shipped `.exe`
  reflects them only after a rebuild (`npm run dist:win`).
- **`test/manual/spike-dtype-sweep.js` committed to master** — retained as the tool for the M5 dtype
  follow-up (header updated; it's not packaged).
- **The other three harnesses** (`spike-synth-timing.js`, `spike-gpu-probe.js`, `spike-app-felt-gap.js`)
  stay on branch `spike/voice-latency` only — not brought to master; they die with the branch when the
  builder deletes it.
- Builder did not edit HANDOFF/design/plans (separation of duties); pre-existing untracked
  `test/manual/verify-*.js` were left untouched.

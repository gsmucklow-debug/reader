# Expressive GPU Voice — Design (2026-07-01)

> An **optional** expressive narrator backed by a GPU model (Chatterbox-class), for
> listening to your own drafts on the Windows/NVIDIA writing station. Default stays
> **Kokoro-CPU, offline** — this is purely opt-in. Brainstormed + decided with the user
> 2026-07-01. **Spike-gated:** the polished installer is not built until the voice proves
> itself by ear on the user's own prose.

## Why (and the honest scope)

The itch: **Kokoro's prosody is flat** (the weak `?` intonation, even delivery) — fine for
book reading, less good when listening back to your *own writing* to hear how it lands.
Kokoro sits at the **expressiveness ceiling of the CPU/ONNX/JS class** (researched
2026-07-01: everything smaller — Piper, KittenTTS — is *more* robotic; Supertonic is faster
but flatter; only 0.5B–2B GPU-class models are audibly more expressive). So real
expressiveness **requires leaving the CPU box** — a GPU model.

**Scope, named plainly (accepted by the user 2026-07-01):** the answer is a separate
**multi-GB CUDA companion app** (Python + PyTorch + Chatterbox), Windows-first, with a
voice-cloning roadmap, and eventually a **different runtime** (MLX/CoreML) for the M5. This
is a deliberate step up from "tweak a voice." The user picked it knowingly for the
own-writing listen loop.

## The unproven premise (this is the gate, not a footnote)

We have **not** proven Chatterbox is audibly better **on flat narration of the user's own
drafts**. It's marketed on emotive demo clips; on plain expository prose the gain can shrink.
It's an autoregressive LLM-based model with a known tendency to **occasionally hallucinate /
run away**, and per-sentence latency on the 5070 Ti is **plausible-but-unmeasured** (expected
sub-second, "keeps ahead" — to be confirmed, not asserted). **If it isn't clearly better to
the user's ear on the user's text, we stop and keep Kokoro.** This mirrors how the project
killed GPU-for-Kokoro (a spike) and gated the dtype swap (a measurement).

## Architecture (both phases share this)

Reader stays **all-JS, Kokoro-CPU by default**. The expressive voice is an **alternate
backend behind the existing voice-agnostic seam** — `reader.synthesize(text, {voice, speed})`
over IPC, today handled in `src/main/tts-service.js` (a `utilityProcess`). The GPU model runs
in a **separate local process** exposing an HTTP endpoint on `localhost`; `tts-service.js`
gains a second code path that **POSTs text → gets WAV back** when expressive mode is on and
the server is reachable, and **falls back to Kokoro** otherwise. Reader itself never touches
Python, CUDA, or the GPU — it just talks to a local port.

This is what sidesteps the logged `onnxruntime-node` GPU dead-end: that failure was the Node
binding's DirectML at the vocoder's ConvTranspose — **irrelevant to a separate CUDA process**
that runs PyTorch directly.

**Decisions locked with the user:**

| Decision | Choice |
|---|---|
| Model | **Chatterbox Original 0.5B** (best expressiveness; the 5070 Ti / 16 GB eats it — no need for Turbo) |
| GPU / device (phase 1) | **Windows desktop, RTX 5070 Ti 16 GB, CUDA** |
| Deployment (destination) | **Companion installer** — a second double-clickable install, bundled Python+CUDA+Chatterbox, background `localhost` server. Keeps the main app clean + honors "no terminal". |
| Voices | **Curated set** of bundled reference clips → several expressive voices in the Voice panel (like today's Kokoro picker). **Cloning deferred** to a later phase. |
| Expressive-mode scope | **Global** setting (like current voice/speed), not per-book |
| Default behavior | **Unchanged** — Kokoro-CPU-offline unless the user turns on expressive mode *and* the server is present |

## Build order — spike BEFORE the installer

**Phase 1 — Spike (a day; the value gate).** Do *not* build a custom server or installer yet.
- Run the **existing off-the-shelf `devnen/Chatterbox-TTS-Server`** (OpenAI-compatible, already
  exists) by hand on the 5070 Ti. (Blackwell/sm_120 needs CUDA 12.8+ / PyTorch cu128 — note it,
  don't polish it.)
- Add the alternate backend behind the `reader.synthesize` seam pointing at `localhost`; wire the
  **cache-key change** (below) and the **Kokoro fallback**.
- **Listen to the user's own drafts.** Measure per-sentence latency; watch for hallucinations.
- **Gate:** clearly better to the user's ear on the user's text, acceptable latency, no runaway
  generations → proceed. Otherwise stop, keep Kokoro, record the finding.

**Phase 2 — Companion installer (only if the gate passes).** Design + build the bundled
"Reader Voice Engine (GPU)" installer, curated voices in the Voice panel, auto-detect + graceful
absence, background-server lifecycle. Written as its own plan after the spike.

## Cache correctness (must handle in the spike)

The clip cache key is `sha1("<voice> <speed> <text>")` (`src/main/clip-cache.js`). Chatterbox
audio for the same `(voice, speed, text)` is **different audio** from Kokoro's — it must not
collide. **Add a backend/engine tag to the key** (e.g. `sha1("<engine> <voice> <speed> <text>")`),
threaded through `get`/`put` and the `synthesize` IPC handler — mirroring how `speed` was threaded
in Phase 2.5. Old Kokoro clips go cold once and re-cache; they're never served as the wrong engine.

## The M5 later (different runtime, NOT a port)

The Mac version shares **only the localhost HTTP contract**. The engine underneath is different
tech — **MLX or CoreML on Apple Silicon**, not CUDA/PyTorch. "Port later" means *re-implement the
server on a Mac runtime*, gated behind the same by-ear test on the M5. Also blocked on the Mac
build existing at all (still deferred). Do not conflate with a cheap recompile.

## Verification plan

**Spike (Phase 1):**
- Regression nets stay green: `npm test`, `npm run smoke` (Kokoro default path untouched).
- The seam falls back to Kokoro cleanly when the server is down (no crash, no hang).
- **By ear (the gate):** the user listens to their own draft(s) via the GPU voice — clearly more
  expressive than Kokoro, latency keeps ahead, no hallucinations. Numbers + verdict recorded in a
  findings file.

**Installer (Phase 2):** its own plan — offline/no-network for the *default* app preserved, GPU
server lifecycle, package gates. Deferred until the spike passes.

## Out of scope (YAGNI)

- **Voice cloning** — deferred to a post-installer phase (curated voices first).
- **The M5 / MLX-CoreML runtime** — later, gated on the Mac build + its own by-ear test.
- **Cloud/remote/streaming voice** — this path is *local GPU only*; the "serve over wifi"
  open-question is not part of this.
- **Streaming partial audio** — keep the one-clip-per-sentence design invariant untouched.
- **Exposing Chatterbox's exaggeration/CFG knobs** — fix a sensible default for the spike; a
  slider is a later polish decision, not a v1 requirement.
- **Replacing Kokoro** — Kokoro stays the offline default forever; this only ever adds an option.

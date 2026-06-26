# Phase 2 Plan — Voice + Sentence Highlighting

> **Run this with:** Claude **Opus 4.8**, **high thinking**, in VS Code. (Core engine — design.md §9.)
>
> **STRICT — separation of duties (see [`../design.md`](../design.md) §10):**
> You are a **builder session. Execute this plan only.** Do **NOT** edit any planning
> document — not `HANDOFF.md`, not `design.md`, not this plan, not anything in `docs/`.
> When you finish, **deliver a self-contained written report** back in chat (what you built,
> how you verified each acceptance criterion with real output, what's left/partial, and any
> gotchas). The planning session verifies your report and is the **sole author** of `HANDOFF.md`.
>
> **Full context if needed:** [`../design.md`](../design.md) (esp. §3 voice, §4 sync, §5 reading
> experience), [`../HANDOFF.md`](../HANDOFF.md), [`phase-1.5-pagination-chapters-fonts.md`](./phase-1.5-pagination-chapters-fonts.md).
> The Electron shell, EPUB parser, reading view, and pagination already exist and pass **31 unit
> tests + a Playwright-Electron smoke** — don't rebuild them. This phase fills in the two Phase 2
> seams left in `src/renderer/app.js`: `highlightSentence(ci, pi, si)` and `goToPageContaining()`.

---

## Goal of this phase

Make the book **read itself aloud in a warm neural voice while the spoken sentence is highlighted**,
with calm play/pause and rewind controls. This is the heart of the app (design.md §1, §4).

The architecture collapses the hard problem (design.md §4): **one audio clip per sentence.**
No forced alignment, no word timestamps, no Whisper. Highlight sentence *N* while clip *N* plays;
when the clip ends, advance to *N+1*. Rewind = replay an earlier clip.

**In scope:** Kokoro TTS running offline/in-process/CPU; per-sentence synthesis; a moving
highlight that scrolls/flips into view; play/pause; back-a-sentence; back-a-paragraph;
forward-a-sentence/paragraph; click-a-sentence-to-start-there; prefetch of upcoming clips so
there's no wait; on-disk clip cache so rewind/re-read is instant; automatic continue across
chapter boundaries.

**Explicitly NOT this phase** (later, to avoid scope creep): a reading-**speed** control, a
**voice-picker** UI, the **end-of-chapter-pause** *control*, **pronunciation** overrides
(all Phase 4); library / covers / auto-resume-on-launch (Phase 3); Markdown / DOCX. See
"Out of scope" at the end.

---

## The voice engine, decided (read before coding)

Per design.md §3 and confirmed with the user: **Kokoro-82M via `kokoro-js`, CPU, offline,
in-process** — and built **voice-agnostic** so a premium cloud voice can drop in later without
touching the player. Concretely:

- **Where it runs:** an Electron **`utilityProcess`** (a Node child process), *not* the main
  process and *not* the renderer.
  - **Why not main:** `onnxruntime-node` inference is **synchronous** — running it on the main
    thread would block IPC and jank the UI while prefetching clips.
  - **Why not the renderer:** the renderer's CSP is `default-src 'none'` and it loads over
    `file://`; loading the model there means proxying bytes through IPC anyway. Node's
    transformers.js local-model path is mature and trivial. (wasm-in-renderer is the documented
    *fallback* if Task 0 shows `onnxruntime-node` won't load in Electron — not the default.)
- **The seam (voice-agnostic boundary):** the renderer only ever calls
  `reader.synthesize(text, opts) → { wav: ArrayBuffer, sampleRate }`. It has **no idea** Kokoro
  is behind it. Swapping engines later = rewriting one file (`src/main/tts-service.js`), nothing
  else. This same seam is where Phase 4 pronunciation respelling will hook in.
- **Offline:** the model is **bundled** under `assets/models/…` and loaded with transformers.js
  configured `env.allowRemoteModels = false`. **Nothing fetches from Hugging Face at runtime.**
- **Model / dtype / voice:** `onnx-community/Kokoro-82M-v1.0-ONNX`, `dtype: "q8"`,
  `device: "cpu"`, default voice **`af_heart`** (Grade-A). These are the values to *verify* in
  Task 0; if the API or a filename differs, Task 0 is where you find out and adjust.

---

## Hard constraints / invariants (do not violate)

- **The per-sentence DOM contract is sacred.** The reading view renders every sentence as
  `<span class="sentence" data-chapter data-paragraph data-sentence>` keyed to
  `doc.chapters[ci].paragraphs[pi].sentences[si]`. **Highlighting only toggles a class on these
  spans.** Never restructure the DOM to highlight. (`render.js` and `app.js` already guarantee
  this; keep it.)
- **Only the current chapter is mounted.** Pagination mounts one chapter at a time. A highlight
  in another chapter must first `goToChapter(ci)` so the span exists, *then* highlight. (See the
  Phase 2 seam comment in `app.js:497`.)
- **No model load on the main thread; no synchronous TTS on the main thread.** Engine lives in the
  `utilityProcess`. The renderer↔engine boundary stays **async IPC**.
- **Offline / free / private.** No network at runtime. The model ships in the package. CSP is not
  loosened — audio reaches the renderer as **bytes over IPC**, decoded via Web Audio
  (`AudioContext.decodeAudioData`), so no `media-src`/`file://` change is needed.
- **CPU only.** `device: "cpu"`. Do not "optimize" onto GPU — it reintroduces per-OS divergence
  (design.md §3).
- **Pure logic stays pure and tested.** The cursor/advance state machine and the cache key are
  DOM-free, audio-free, model-free modules — unit-tested like `paginate.js`. Audio/model/IPC are
  pushed to the edges and verified by smoke + manual listen, **not** mock-heavy "unit" tests.
- **Don't regress.** All existing 31 unit tests and the smoke must stay green.

---

## Architecture at a glance

```
 renderer (app.js)                 main process (main.js)          utilityProcess (tts-service.js)
 ────────────────                  ──────────────────────          ───────────────────────────────
 player.js (controller) ── IPC ──► ipc 'synthesize' ─ cache? ─┐    KokoroTTS.from_pretrained(local)
   reading-cursor.js (pure)         hit → return cached wav   └─►  generate(text,{voice}) → WAV bytes
   AudioContext (decode/play)       miss→ ask utilityProcess  ◄───  postMessage({wav, sampleRate})
   highlight + scroll/flip          write cache, return bytes
```

- **`reading-cursor.js`** (renderer + node) — *pure*: turns the `Document` into an ordered
  sentence sequence and answers "next / prev / start-of-paragraph / previous-paragraph / N-ahead."
- **`player.js`** (renderer) — the controller. Dependency-injected (`synth`, `makeClip`, `view`)
  so it's unit-testable with fakes. Owns: current address, playing state, the prefetch map, and
  the advance-on-clip-end loop.
- **`tts-service.js`** (utilityProcess) — the Kokoro engine behind the `synthesize` boundary.
- **`main.js`** — spawns the utilityProcess, owns the **disk clip cache**, bridges IPC.
- **`app.js`** — exposes a small `window.ReaderView` API (wrapping the existing seams) and wires
  the controls; instantiates the real player.

---

# TASK 0 — GATING SPIKE: prove offline synthesis works inside Electron

> **This is the Phase-2 risk-first task (the analog of Phase 1's packaging risk). Do NOT start
> Tasks 1+ until this passes.** It de-risks three things that would otherwise be discovered three
> tasks deep: (a) `onnxruntime-node` is a **native binary** — it usually loads in Electron via
> N-API, but Electron native-module loading has surprised people; (b) **voice data loads
> separately from the model**, so a check that only loads the model passes, then `generate()`
> fails offline fetching the voice; (c) the exact `kokoro-js` API/filenames on the installed
> version. **Success = a real WAV of recognizable speech, produced with the network adapter off,
> from inside Electron's Node context.**

**Files:**
- Modify: `package.json` (add dependency)
- Create: `scripts/fetch-model.js`
- Create: `assets/models/` (populated by the fetch script — the model files)
- Create: `src/main/tts-service.js` (minimal first version)
- Create: `test/manual/spike-synthesize.js` (throwaway harness; can be deleted after)

**Step 0: Repo / checkpoint setup (one-time)**

This repo is **not** a git repository, and the user never needs git (design.md §10). The
`git commit` steps at the end of each task below are **optional checkpoints** for you, the builder.
If you want them, initialize once:

```bash
git init   # optional — only so the per-task commits work as save points
```

If you'd rather not use git, **skip every `git add`/`git commit` step** — they are not load-bearing
and nothing in the app depends on them.

**Step 1: Install the engine**

```bash
npm install kokoro-js
```

`kokoro-js` pulls in `@huggingface/transformers`, which uses `onnxruntime-node` under
`device: "cpu"`. Confirm `node_modules/onnxruntime-node` exists after install.

**Step 2: Fetch + bundle the model for offline use**

Write `scripts/fetch-model.js`. The robust, low-guessing approach: let `from_pretrained` download
into a **local folder we control**, then point the app at that folder forever after. Run it once
*online* (developer machine), and the model is then committed/bundled for all users.

```js
'use strict';
// One-time developer script: download the Kokoro model into assets/models so the
// app can run fully offline. Run with: `node scripts/fetch-model.js`. NOT shipped/run by users.
const path = require('node:path');

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const OUT = path.join(__dirname, '..', 'assets', 'models');

(async () => {
  const { env } = await import('@huggingface/transformers');
  // Download into our bundled location; allow remote ONLY for this fetch step.
  env.cacheDir = OUT;            // transformers.js caches the repo under OUT/<org>/<repo>/...
  env.allowRemoteModels = true;
  const { KokoroTTS } = await import('kokoro-js');
  console.log('Downloading', MODEL_ID, '→', OUT);
  const tts = await KokoroTTS.from_pretrained(MODEL_ID, { dtype: 'q8', device: 'cpu' });
  // Force the default voice to download too (voices load lazily/separately).
  await tts.generate('Bundling check.', { voice: 'af_heart' });
  console.log('Done. Voices:', tts.list_voices().slice(0, 8), '…');
})().catch((e) => { console.error(e); process.exit(1); });
```

Run it:

```bash
node scripts/fetch-model.js
```

Expected: it prints "Done." and `assets/models/` now contains the model repo (an
`onnx-community/Kokoro-82M-v1.0-ONNX/` tree with `config.json`, an `onnx/*.onnx` weights file,
and the voice data). **Record the exact directory layout it produced** — Task 2 must point
`env.localModelPath` / `env.cacheDir` at it precisely. (If `kokoro-js`'s loader expects a
different env var or path shape than `cacheDir`, discover it here and note it in your report.)

> **Offline-load fallback (try in this order if loading fails):** the `cacheDir` layout above is
> URL-ish (`…/<org>/<repo>/resolve/main/…`) and easy to mis-copy. If `cacheDir` +
> `allowRemoteModels=false` won't resolve offline, switch to the documented transformers.js
> pattern: `env.localModelPath = <dir>` with a **flat** `<dir>/onnx-community/Kokoro-82M-v1.0-ONNX/…`
> layout (flatten the downloaded repo into that shape), keep `allowRemoteModels=false`. Lock in
> whichever resolves offline and use the **same** env config in Task 0's `tts-service.js` and the
> production path in Task 2.

**Step 3: Minimal `tts-service.js` that loads from the bundle, offline**

Create `src/main/tts-service.js` as a utilityProcess entry that loads the **local** model
(no network) and synthesizes on request. First version only needs to synthesize one clip.

```js
'use strict';
// Kokoro TTS engine, run in an Electron utilityProcess (a Node child). Loads the
// BUNDLED model with no network access and answers { type:'synthesize' } messages
// with WAV bytes. This file is the voice-agnostic seam: swap it to change engines.
const path = require('node:path');

let ttsPromise = null;

async function getTTS() {
  if (ttsPromise) return ttsPromise;
  ttsPromise = (async () => {
    const { env } = await import('@huggingface/transformers');
    // Bundled model dir. In dev this is the repo's assets/models; in the packaged
    // app it's resolved from process.resourcesPath (passed in via the spawn args).
    const modelsDir = process.env.READER_MODELS_DIR
      || path.join(__dirname, '..', '..', 'assets', 'models');
    env.cacheDir = modelsDir;
    env.allowRemoteModels = false;   // HARD offline. Never hit the network at runtime.
    env.allowLocalModels = true;
    const { KokoroTTS } = await import('kokoro-js');
    return KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
      dtype: 'q8', device: 'cpu',
    });
  })();
  return ttsPromise;
}

// RawAudio → 16-bit PCM WAV bytes. kokoro-js exposes audio.toWav()/toBlob(); use
// toWav() if present, else build the header from audio.audio (Float32) + sampling_rate.
function toWavBytes(audio) {
  if (typeof audio.toWav === 'function') return new Uint8Array(audio.toWav());
  return encodeWav(audio.audio, audio.sampling_rate);
}

async function synthesize({ text, voice }) {
  const tts = await getTTS();
  const audio = await tts.generate(text, { voice: voice || 'af_heart' });
  return { wav: toWavBytes(audio), sampleRate: audio.sampling_rate };
}

// utilityProcess message protocol: { id, type:'synthesize', text, voice }.
process.parentPort.on('message', async (e) => {
  const msg = e.data;
  if (msg.type === 'synthesize') {
    try {
      const { wav, sampleRate } = await synthesize(msg);
      process.parentPort.postMessage({ id: msg.id, ok: true, sampleRate }, [wav.buffer]);
    } catch (err) {
      process.parentPort.postMessage({ id: msg.id, ok: false, error: String(err) });
    }
  } else if (msg.type === 'ping') {
    try { await getTTS(); process.parentPort.postMessage({ id: msg.id, ok: true }); }
    catch (err) { process.parentPort.postMessage({ id: msg.id, ok: false, error: String(err) }); }
  }
});

// Minimal PCM16 WAV encoder (fallback if audio.toWav() is unavailable).
function encodeWav(float32, sampleRate) {
  const n = float32.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data');
  dv.setUint32(40, n * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    dv.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

module.exports = { synthesize, toWavBytes, encodeWav };
```

**Step 4: Prove it — inside Electron, network OFF**

Write `test/manual/spike-synthesize.js` that launches the utilityProcess from Electron's main and
writes one WAV to disk. Keep it tiny — it's a throwaway gate.

```js
'use strict';
// Throwaway spike: run with `npx electron test/manual/spike-synthesize.js`.
// Spawns the TTS utilityProcess, synthesizes one sentence, writes spike.wav.
const { app, utilityProcess } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

app.whenReady().then(() => {
  const child = utilityProcess.fork(path.join(__dirname, '..', '..', 'src', 'main', 'tts-service.js'));
  // The WAV rides back as msg.wav (a Uint8Array; structured-cloned, not transferred).
  child.on('message', (m) => {
    if (m.id !== 1) return;
    if (!m.ok) { console.error('SYNTH FAILED:', m.error); app.exit(1); return; }
    fs.writeFileSync(path.join(__dirname, 'spike.wav'), Buffer.from(m.wav.buffer || m.wav));
    console.log('WROTE spike.wav', m.wav.length, 'bytes @', m.sampleRate, 'Hz');
    app.exit(0);
  });
  child.postMessage({ id: 1, type: 'synthesize', text:
    'The quick brown fox jumps over the lazy dog.', voice: 'af_heart' });
});
```

> **Transfer note to resolve in this task:** Electron's `utilityProcess` message channel does
> *not* use the renderer's `MessagePort` transfer-list semantics the same way. Confirm how to send
> the WAV bytes from `tts-service.js` to the parent — likely include `wav` directly in the message
> object (structured-clone copies the typed array) rather than a transfer list. Adjust
> `postMessage({ id, ok, sampleRate, wav })` accordingly and update the snippet in Step 3. This is
> exactly the kind of detail Task 0 exists to nail down.

Run with the network adapter **disabled**:

```bash
npx electron test/manual/spike-synthesize.js
```

Expected: `WROTE spike.wav … bytes @ 24000 Hz` (Kokoro is 24 kHz). **Open `spike.wav` and listen.**

**Step 5: Gate check + report-in-place**

- ✅ A `spike.wav` of clear, recognizable speech was produced **with the network off, inside
  Electron**. → Proceed to Task 1.
- ❌ `onnxruntime-node` fails to load in Electron, or the model won't load offline. → **STOP.**
  Write up the exact error and switch the architecture to **wasm-in-renderer** (onnxruntime-web,
  `device: "wasm"`, model bytes proxied from main over IPC, CSP `script-src` gains
  `'wasm-unsafe-eval'`). Re-run this gate under that approach before continuing.

**Step 6: Commit**

```bash
git add package.json package-lock.json scripts/fetch-model.js src/main/tts-service.js
git commit -m "feat(tts): offline Kokoro synthesis spike — gating Task 0"
```

> Note: `assets/models/` is large (~80–90 MB). Commit it (the app must ship it), or if the repo
> shouldn't carry binaries, document that `node scripts/fetch-model.js` must be run before
> `npm run dist`. State which you chose in your report.

---

# TASK 1 — Pure reading-cursor module (the sentence sequence)

The controller needs to walk sentences in reading order and answer rewind questions. Keep it
**pure** (no DOM, no audio) — exactly like `paginate.js` — so it's fully unit-testable in node.

**Files:**
- Create: `src/renderer/reading-cursor.js`
- Test: `test/unit/reading-cursor.test.js`

An **address** is `{ ci, pi, si }` into `doc.chapters[ci].paragraphs[pi].sentences[si]`.

**Step 1: Write the failing tests**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('../../src/renderer/reading-cursor');

// 2 chapters; ch0: 2 paragraphs (2 + 1 sentences); ch1: 1 paragraph (2 sentences).
const doc = {
  chapters: [
    { paragraphs: [{ sentences: ['a0', 'a1'] }, { sentences: ['b0'] }] },
    { paragraphs: [{ sentences: ['c0', 'c1'] }] },
  ],
};
const A = (ci, pi, si) => ({ ci, pi, si });

test('firstAddress is the very first sentence', () => {
  assert.deepStrictEqual(C.firstAddress(doc), A(0, 0, 0));
});

test('nextAddress walks within a paragraph, across paragraphs, across chapters', () => {
  assert.deepStrictEqual(C.nextAddress(doc, A(0, 0, 0)), A(0, 0, 1));
  assert.deepStrictEqual(C.nextAddress(doc, A(0, 0, 1)), A(0, 1, 0)); // next paragraph
  assert.deepStrictEqual(C.nextAddress(doc, A(0, 1, 0)), A(1, 0, 0)); // next chapter
  assert.strictEqual(C.nextAddress(doc, A(1, 0, 1)), null);           // end of book
});

test('prevAddress is the exact inverse', () => {
  assert.deepStrictEqual(C.prevAddress(doc, A(1, 0, 0)), A(0, 1, 0));
  assert.deepStrictEqual(C.prevAddress(doc, A(0, 1, 0)), A(0, 0, 1));
  assert.strictEqual(C.prevAddress(doc, A(0, 0, 0)), null);           // start of book
});

test('backParagraph: mid-paragraph jumps to its own start', () => {
  assert.deepStrictEqual(C.backParagraph(doc, A(0, 0, 1)), A(0, 0, 0));
});

test('backParagraph: at a paragraph start jumps to the previous paragraph start', () => {
  assert.deepStrictEqual(C.backParagraph(doc, A(0, 1, 0)), A(0, 0, 0));
  assert.deepStrictEqual(C.backParagraph(doc, A(1, 0, 0)), A(0, 1, 0)); // across chapters
});

test('backParagraph at the very first sentence stays put', () => {
  assert.deepStrictEqual(C.backParagraph(doc, A(0, 0, 0)), A(0, 0, 0));
});

test('aheadFrom returns up to N upcoming addresses (for prefetch)', () => {
  assert.deepStrictEqual(C.aheadFrom(doc, A(0, 0, 1), 2), [A(0, 1, 0), A(1, 0, 0)]);
  assert.deepStrictEqual(C.aheadFrom(doc, A(1, 0, 0), 5), [A(1, 0, 1)]); // clamps at book end
});

test('key/eq round-trip', () => {
  assert.strictEqual(C.key(A(1, 0, 1)), '1.0.1');
  assert.ok(C.eq(A(1, 0, 1), A(1, 0, 1)));
  assert.ok(!C.eq(A(1, 0, 1), A(1, 0, 0)));
});
```

**Step 2: Run, watch them fail**

```bash
npm test -- --test-name-pattern="cursor"
```
Expected: FAIL ("Cannot find module reading-cursor" / functions undefined).

**Step 3: Implement `reading-cursor.js`**

```js
'use strict';
// Pure, DOM-free, audio-free navigation over a parsed Document. An "address" is
// { ci, pi, si } into doc.chapters[ci].paragraphs[pi].sentences[si]. Mirrors the
// paginate.js pattern: pure functions, dual-mode export, unit-tested in node.

function firstAddress(doc) {
  if (!doc || !doc.chapters || doc.chapters.length === 0) return null;
  return { ci: 0, pi: 0, si: 0 };
}

function nextAddress(doc, a) {
  if (!a) return null;
  const ch = doc.chapters[a.ci];
  const para = ch.paragraphs[a.pi];
  if (a.si + 1 < para.sentences.length) return { ci: a.ci, pi: a.pi, si: a.si + 1 };
  if (a.pi + 1 < ch.paragraphs.length) return { ci: a.ci, pi: a.pi + 1, si: 0 };
  if (a.ci + 1 < doc.chapters.length) return { ci: a.ci + 1, pi: 0, si: 0 };
  return null;
}

function prevAddress(doc, a) {
  if (!a) return null;
  if (a.si > 0) return { ci: a.ci, pi: a.pi, si: a.si - 1 };
  if (a.pi > 0) {
    const p = doc.chapters[a.ci].paragraphs[a.pi - 1];
    return { ci: a.ci, pi: a.pi - 1, si: p.sentences.length - 1 };
  }
  if (a.ci > 0) {
    const ch = doc.chapters[a.ci - 1];
    const pi = ch.paragraphs.length - 1;
    return { ci: a.ci - 1, pi, si: ch.paragraphs[pi].sentences.length - 1 };
  }
  return null;
}

// "Back one paragraph": mid-paragraph → this paragraph's first sentence; already at
// a paragraph start → the previous paragraph's first sentence; book start → stay.
function backParagraph(doc, a) {
  if (!a) return null;
  if (a.si > 0) return { ci: a.ci, pi: a.pi, si: 0 };
  const prev = prevAddress(doc, a);            // first sentence of the previous paragraph
  return prev ? { ci: prev.ci, pi: prev.pi, si: 0 } : { ...a };
}

// The next up-to-n addresses after `a` (for clip prefetch). Excludes `a` itself.
function aheadFrom(doc, a, n) {
  const out = [];
  let cur = a;
  for (let i = 0; i < n; i++) {
    cur = nextAddress(doc, cur);
    if (!cur) break;
    out.push(cur);
  }
  return out;
}

const key = (a) => `${a.ci}.${a.pi}.${a.si}`;
const eq = (a, b) => !!a && !!b && a.ci === b.ci && a.pi === b.pi && a.si === b.si;
const textAt = (doc, a) => doc.chapters[a.ci].paragraphs[a.pi].sentences[a.si];

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { firstAddress, nextAddress, prevAddress, backParagraph, aheadFrom, key, eq, textAt };
} else {
  globalThis.ReaderCursor = { firstAddress, nextAddress, prevAddress, backParagraph, aheadFrom, key, eq, textAt };
}
```

**Step 4: Run, watch them pass**

```bash
npm test -- --test-name-pattern="cursor"
```
Expected: all cursor tests PASS. Then run the full suite — nothing else should break:
```bash
npm test
```

**Step 5: Load it in the renderer**

In `src/renderer/index.html`, add the script **before** `app.js` (alongside `render.js`/`paginate.js`):
```html
<script src="reading-cursor.js"></script>
```

**Step 6: Commit**

```bash
git add src/renderer/reading-cursor.js test/unit/reading-cursor.test.js src/renderer/index.html
git commit -m "feat(player): pure reading-cursor sentence navigation + tests"
```

---

# TASK 2 — Wire the TTS service into main + expose `reader.synthesize`

Take the Task-0 `tts-service.js` from spike to production: spawn it from main, bridge an IPC
`synthesize` call to the renderer, and resolve the bundled-model path correctly in **both** dev
and the packaged app.

**Files:**
- Modify: `src/main/main.js`
- Modify: `src/main/preload.js`
- Modify: `src/main/tts-service.js` (finalize the message protocol from Task 0)

**Step 1: Spawn the utilityProcess + an id-keyed request map in `main.js`**

Add near the top of `main.js`:

```js
const { utilityProcess } = require('electron'); // add to the existing require

let ttsChild = null;
let ttsSeq = 0;
const ttsPending = new Map(); // id -> { resolve, reject }

function modelsDir() {
  // Packaged: resources/assets/models (assets ships via build.files). Dev: repo assets.
  return app.isPackaged
    ? path.join(process.resourcesPath, 'assets', 'models')
    : path.join(__dirname, '..', '..', 'assets', 'models');
}

function getTtsChild() {
  if (ttsChild) return ttsChild;
  ttsChild = utilityProcess.fork(path.join(__dirname, 'tts-service.js'), [], {
    env: { ...process.env, READER_MODELS_DIR: modelsDir() },
  });
  ttsChild.on('message', (msg) => {
    const p = ttsPending.get(msg.id);
    if (!p) return;
    ttsPending.delete(msg.id);
    if (msg.ok) p.resolve(msg);
    else p.reject(new Error(msg.error || 'TTS failed'));
  });
  ttsChild.on('exit', () => {
    ttsChild = null;
    for (const p of ttsPending.values()) p.reject(new Error('TTS process exited'));
    ttsPending.clear();
  });
  return ttsChild;
}

function ttsRequest(payload) {
  const id = ++ttsSeq;
  return new Promise((resolve, reject) => {
    ttsPending.set(id, { resolve, reject });
    getTtsChild().postMessage({ id, ...payload });
  });
}
```

**Step 2: The `synthesize` IPC handler (cache wiring comes in Task 3)**

```js
// Synthesize one sentence → { wav: ArrayBuffer, sampleRate }. (Task 3 adds the disk cache
// in front of this.) Returns the raw bytes; the renderer decodes with Web Audio.
ipcMain.handle('synthesize', async (_evt, { text, voice }) => {
  const res = await ttsRequest({ type: 'synthesize', text, voice });
  return { wav: res.wav, sampleRate: res.sampleRate };
});
```

> `res.wav` is the typed array carried in the utilityProcess message (per the Task-0 transfer
> note). Return it as-is; Electron structured-clones it across the renderer IPC boundary.

**Step 3: Expose it in `preload.js`**

```js
// add to the contextBridge.exposeInMainWorld('reader', { ... }) object:
  // Renderer calls reader.synthesize(text, { voice }); we send ONE object so the
  // main handler can destructure { text, voice } — keep this arg shape everywhere.
  synthesize: (text, opts) => ipcRenderer.invoke('synthesize', { text, ...(opts || {}) }),
```

> **Single-object arg shape — keep it consistent.** Preload sends `{ text, voice }`; the main
> handler (Step 2, and the Task-3 cached version) destructures `{ text, voice }`. Do **not** switch
> to positional args in one place and an object in the other — that mismatch silently synthesizes
> `undefined`.

**Step 4: Optional warm-up so the first Play isn't slow**

After `createWindow()` in `app.whenReady()`, kick a `ping` so the model loads in the background:
```js
ttsRequest({ type: 'ping' }).catch(() => {}); // model warm-up; ignore failures (offline-safe)
```

**Step 5: Clean shutdown**

```js
app.on('will-quit', () => { if (ttsChild) ttsChild.kill(); });
```

**Step 6: Manual verify in the running app**

```bash
npm start
```
Open DevTools console and run:
```js
const { wav, sampleRate } = await window.reader.synthesize('Hello from Reader.', { voice: 'af_heart' });
console.log(wav.byteLength || wav.length, sampleRate); // expect >0 bytes, 24000
```
Expected: nonzero byte length, `24000`. (No book needed.)

**Step 7: Commit**

```bash
git add src/main/main.js src/main/preload.js src/main/tts-service.js
git commit -m "feat(tts): spawn TTS utilityProcess and expose reader.synthesize over IPC"
```

---

# TASK 3 — On-disk clip cache (instant rewind / re-read)

Design.md §4: cache clips on disk so re-reading and rewinding are instant. Cache in **main**
(it has `fs` + the userData path). Key by a content hash so identical text+voice dedupes
naturally and survives restarts.

**Files:**
- Create: `src/main/clip-cache.js` (pure key fn + thin fs cache)
- Test: `test/unit/clip-cache.test.js`
- Modify: `src/main/main.js` (use the cache in the `synthesize` handler)

**Step 1: Write the failing test for the pure key fn**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { clipKey } = require('../../src/main/clip-cache');

test('clipKey is stable and depends on text + voice', () => {
  const a = clipKey('Hello world.', 'af_heart');
  assert.strictEqual(a, clipKey('Hello world.', 'af_heart'));      // stable
  assert.notStrictEqual(a, clipKey('Hello world.', 'bf_emma'));    // voice matters
  assert.notStrictEqual(a, clipKey('Goodbye world.', 'af_heart')); // text matters
  assert.match(a, /^[0-9a-f]{16,}\.wav$/);                          // filename-safe
});
```

**Step 2: Run it, watch it fail**

```bash
npm test -- --test-name-pattern="clipKey"
```

**Step 3: Implement `clip-cache.js`**

```js
'use strict';
// Content-addressed clip cache. Key = sha1(text|voice).wav, so identical sentences
// (incl. rewind/re-read) reuse one file. Lives under userData/clips. Phase 3 may
// formalize per-book folders; a global content hash is correct and dedupes for now.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

function clipKey(text, voice) {
  const h = crypto.createHash('sha1').update(`${voice || 'af_heart'} ${text}`).digest('hex');
  return `${h}.wav`;
}

function makeCache(dir) {
  let ready = null;
  const ensure = () => (ready ||= fs.mkdir(dir, { recursive: true }));
  return {
    async get(text, voice) {
      try { return await fs.readFile(path.join(dir, clipKey(text, voice))); }
      catch { return null; }
    },
    async put(text, voice, bytes) {
      await ensure();
      await fs.writeFile(path.join(dir, clipKey(text, voice)), Buffer.from(bytes));
    },
  };
}

module.exports = { clipKey, makeCache };
```

**Step 4: Run it, watch it pass + full suite**

```bash
npm test
```

**Step 5: Use the cache in `main.js`'s `synthesize` handler**

```js
const { makeCache } = require('./clip-cache'); // add near the other requires
let clipCache = null; // lazily created after app is ready (needs userData path)

// replace the Task-2 synthesize handler body with (same { text, voice } arg shape):
ipcMain.handle('synthesize', async (_evt, { text, voice }) => {
  voice = voice || 'af_heart';
  clipCache ||= makeCache(path.join(app.getPath('userData'), 'clips'));
  const hit = await clipCache.get(text, voice);
  if (hit) return { wav: hit, sampleRate: 24000 }; // Kokoro is fixed 24 kHz
  const res = await ttsRequest({ type: 'synthesize', text, voice });
  const bytes = res.wav;
  await clipCache.put(text, voice, bytes);
  return { wav: bytes, sampleRate: res.sampleRate };
});
```

> Returning a Node `Buffer` over IPC is fine — the renderer receives it as a `Uint8Array`.
> Decode it with `AudioContext.decodeAudioData(uint8.buffer.slice(...))` in the player.

**Step 6: Manual verify the cache works**

```bash
npm start
```
In DevTools, synthesize the same sentence twice; the second call should be near-instant. Confirm a
`.wav` appears under `userData/clips` (Win: `%APPDATA%/Reader/clips`).

**Step 7: Commit**

```bash
git add src/main/clip-cache.js test/unit/clip-cache.test.js src/main/main.js
git commit -m "feat(tts): content-addressed on-disk clip cache"
```

---

# TASK 4 — Playback controller (`player.js`) with injected edges

The heart of the phase. A controller that, given an injected `synth`, `makeClip`, and `view`,
runs the advance-on-clip-end loop, prefetches ahead, and drives the highlight. Dependency
injection keeps it **unit-testable with fakes** (the advisor's point: don't mock-test real audio —
inject fakes for the *logic*, verify real audio by smoke + listen).

**Files:**
- Create: `src/renderer/player.js`
- Test: `test/unit/player.test.js`

**Step 1: Write the failing tests (with fake synth + fake clips)**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
require('../../src/renderer/reading-cursor'); // not needed for require path; see note
const { createPlayer } = require('../../src/renderer/player');

const doc = {
  chapters: [
    { paragraphs: [{ sentences: ['a0', 'a1'] }, { sentences: ['b0'] }] },
    { paragraphs: [{ sentences: ['c0'] }] },
  ],
};

// A fake clip whose .play(onEnded) we fire manually so tests control timing.
function fakeDeps() {
  const shown = [];          // addresses the view was asked to show, in order
  const synthed = [];        // texts synthesized, in order (prefetch visible here)
  let pendingEnded = null;   // onEnded of the currently "playing" clip
  const deps = {
    doc,
    synth: async (text) => { synthed.push(text); return { wav: new Uint8Array(1), sampleRate: 24000 }; },
    makeClip: async () => ({
      play: (onEnded) => { pendingEnded = onEnded; },
      stop: () => { pendingEnded = null; },
    }),
    view: { show: (a) => shown.push(`${a.ci}.${a.pi}.${a.si}`) },
  };
  return { deps, shown, synthed, endCurrent: () => { const f = pendingEnded; pendingEnded = null; f && f(); } };
}

test('play highlights the first sentence and advances on clip end', async () => {
  const { deps, shown, endCurrent } = fakeDeps();
  const p = createPlayer(deps);
  await p.play();
  await Promise.resolve();
  assert.strictEqual(shown[0], '0.0.0');
  endCurrent(); await tick();           // clip 0 ends → advance
  assert.strictEqual(shown[shown.length - 1], '0.0.1');
});

test('reads across paragraph and chapter boundaries to the end of the book', async () => {
  const { deps, shown, endCurrent } = fakeDeps();
  const p = createPlayer(deps);
  await p.play(); await tick();
  for (let i = 0; i < 4; i++) { endCurrent(); await tick(); }
  assert.deepStrictEqual(shown, ['0.0.0', '0.0.1', '0.1.0', '1.0.0']);
  assert.strictEqual(p.isPlaying(), false); // stopped at book end
});

test('back one sentence replays the previous clip', async () => {
  const { deps, shown, endCurrent } = fakeDeps();
  const p = createPlayer(deps);
  await p.play(); await tick();
  endCurrent(); await tick();           // now at 0.0.1
  await p.backSentence(); await tick();
  assert.strictEqual(shown[shown.length - 1], '0.0.0');
});

test('back one paragraph jumps to the paragraph start', async () => {
  const { deps, shown, endCurrent } = fakeDeps();
  const p = createPlayer(deps);
  await p.play(); await tick();
  endCurrent(); await tick(); endCurrent(); await tick(); // at 0.1.0
  await p.backParagraph(); await tick();
  assert.strictEqual(shown[shown.length - 1], '0.0.0'); // prev paragraph start
});

test('prefetch synthesizes upcoming sentences ahead of playback', async () => {
  const { deps, synthed } = fakeDeps();
  const p = createPlayer({ ...deps, prefetchAhead: 2 });
  await p.play(); await tick();
  // current + 2 ahead requested up front: a0, a1, b0
  assert.deepStrictEqual(synthed.slice(0, 3), ['a0', 'a1', 'b0']);
});

test('pause stops the current clip and play does not double-advance', async () => {
  const { deps, shown, endCurrent } = fakeDeps();
  const p = createPlayer(deps);
  await p.play(); await tick();
  p.pause();
  endCurrent(); await tick();           // a stale ended must NOT advance while paused
  assert.strictEqual(shown[shown.length - 1], '0.0.0');
});

const tick = () => new Promise((r) => setTimeout(r, 0));
```

> Note: in node, `player.js` must be able to reach the cursor. Have `player.js` `require()` the
> cursor in CommonJS mode and read `globalThis.ReaderCursor` in the browser (dual-mode, like the
> other files).

**Step 2: Run, watch them fail**

```bash
npm test -- --test-name-pattern="player|clip end|paragraph|prefetch|pause"
```

**Step 3: Implement `player.js`**

```js
'use strict';
// Playback controller. Pure-ish: all impure edges are injected (synth, makeClip, view),
// so the advance/rewind/prefetch logic is unit-tested with fakes. Production wiring
// (AudioContext, reader.synthesize, the DOM view) lives in app.js.
//
//   deps = {
//     doc,                          parsed Document
//     synth(text) -> {wav,sampleRate}
//     makeClip(wav,sampleRate) -> { play(onEnded), stop() }
//     view.show(addr)              mount chapter if needed + highlight + scroll/flip into view
//     prefetchAhead = 2
//   }

const Cursor = (typeof require !== 'undefined') ? require('./reading-cursor') : globalThis.ReaderCursor;

function createPlayer(deps) {
  const { doc, synth, makeClip, view } = deps;
  const prefetchAhead = deps.prefetchAhead ?? 2;

  let addr = null;            // current sentence address
  let playing = false;
  let activeClip = null;
  let token = 0;             // invalidates in-flight async work on pause/seek
  const clips = new Map();   // key -> Promise<{ play, stop }>

  function clipFor(a) {
    const k = Cursor.key(a);
    if (!clips.has(k)) {
      clips.set(k, synth(Cursor.textAt(doc, a)).then((r) => makeClip(r.wav, r.sampleRate)));
    }
    return clips.get(k);
  }

  function prefetch(a) {
    clipFor(a);
    for (const ahead of Cursor.aheadFrom(doc, a, prefetchAhead)) clipFor(ahead);
  }

  async function playCurrent() {
    if (!addr) { stopInternal(); return; }
    const my = ++token;
    view.show(addr);
    prefetch(addr);
    let clip;
    try { clip = await clipFor(addr); }
    catch { return; }                 // synth failed; leave highlight, don't crash
    if (my !== token || !playing) return; // paused or seeked while synthesizing
    activeClip = clip;
    clip.play(() => onEnded(my));
  }

  function onEnded(my) {
    if (my !== token || !playing) return; // stale end (paused/seeked) — ignore
    const next = Cursor.nextAddress(doc, addr);
    if (!next) { playing = false; activeClip = null; return; } // end of book
    addr = next;
    playCurrent();
  }

  function stopInternal() {
    token++;
    if (activeClip) activeClip.stop();
    activeClip = null;
  }

  async function play() {
    if (playing) return;
    if (!addr) addr = Cursor.firstAddress(doc);
    if (!addr) return;
    playing = true;
    await playCurrent();
  }

  function pause() { playing = false; stopInternal(); }

  async function seekTo(a) {
    if (!a) return;
    stopInternal();
    addr = a;
    if (playing) await playCurrent();
    else view.show(addr); // show the highlight even when paused
  }

  return {
    play, pause,
    toggle: () => (playing ? pause() : play()),
    backSentence: () => seekTo(Cursor.prevAddress(doc, addr) || addr),
    forwardSentence: () => seekTo(Cursor.nextAddress(doc, addr) || addr),
    backParagraph: () => seekTo(Cursor.backParagraph(doc, addr)),
    forwardParagraph: () => {
      // first sentence of the next paragraph (or next chapter)
      let n = Cursor.nextAddress(doc, addr);
      while (n && n.si !== 0) n = Cursor.nextAddress(doc, n);
      return seekTo(n || addr);
    },
    jumpTo: (a) => { playing = true; return seekTo(a); }, // clicking a sentence starts playback there
    isPlaying: () => playing,
    current: () => addr,
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { createPlayer };
else globalThis.ReaderPlayer = { createPlayer };
```

> Design choice: **clicking a sentence starts playback there** (design.md §5 — listening is the
> primary mode). `jumpTo` sets `playing` true then seeks. If you'd rather click-only-highlights,
> change `jumpTo`. Confirm the behavior in your report.

**Step 4: Run, watch them pass + full suite**

```bash
npm test
```
Expected: all player tests PASS; total now 31 + cursor + clipKey + player tests, all green.

**Step 5: Commit**

```bash
git add src/renderer/player.js test/unit/player.test.js
git commit -m "feat(player): playback controller (advance/rewind/prefetch) with injected edges"
```

---

# TASK 5 — Wire the real edges in `app.js` (audio, view, controls)

Connect the controller to real Web Audio, the existing highlight/scroll seams, and on-screen
controls. No new pure logic here — it's integration.

**Files:**
- Modify: `src/renderer/index.html` (control buttons + script tag)
- Modify: `src/renderer/styles.css` (control styling; ¾-up highlight already has `.is-reading`)
- Modify: `src/renderer/app.js` (ReaderView API, real audio backend, instantiate player, controls)

**Step 1: Add playback controls to the bottom bar (index.html)**

Insert into `#bottom-bar` (left of the chapter/page controls), large and calm (design.md §5):

```html
<button type="button" id="back-para" aria-label="Back one paragraph" title="Back a paragraph">⏮</button>
<button type="button" id="back-sent" aria-label="Back one sentence" title="Back a sentence (←)">↶</button>
<button type="button" id="play-pause" class="play" aria-label="Play" title="Play / Pause (Space)">▶</button>
<button type="button" id="fwd-sent" aria-label="Forward one sentence" title="Forward a sentence">↷</button>
```

And load the new scripts before `app.js`:
```html
<script src="reading-cursor.js"></script>
<script src="player.js"></script>
```

**Step 2: A real audio backend (`makeClip`) in app.js**

```js
// --- Audio playback backend (Web Audio; decodes WAV bytes from the engine) -----
let audioCtx = null;
function getAudioCtx() { return (audioCtx ||= new (window.AudioContext || window.webkitAudioContext)()); }
// An AudioContext starts `suspended` under the autoplay policy — the FIRST clip
// plays silently (no error!) unless resumed inside a user gesture. Call this from
// the play/click/space handlers (all real gestures).
async function resumeAudio() { const c = getAudioCtx(); if (c.state === 'suspended') await c.resume(); }

// makeClip: WAV bytes -> a clip object the controller can play()/stop().
async function makeClip(wav, _sampleRate) {
  const ctx = getAudioCtx();
  // decodeAudioData wants an ArrayBuffer it can detach; copy out of the IPC view.
  const bytes = wav instanceof Uint8Array ? wav : new Uint8Array(wav);
  const buf = await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  let src = null;
  return {
    play(onEnded) {
      src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.onended = () => onEnded();
      src.start();
    },
    stop() { if (src) { src.onended = null; try { src.stop(); } catch (_) {} src = null; } },
  };
}
```

**Step 3: The `ReaderView` adapter (wraps the existing seams)**

This is the single call the controller uses to put a sentence on screen — it mounts the right
chapter, highlights, and brings the span into view (¾-up in scroll mode, flip in paged modes).

```js
// view.show(addr): make sentence (ci,pi,si) visible + highlighted, mounting its
// chapter first (only one chapter is mounted at a time — see app.js Phase 2 seam).
const ReaderView = {
  show(addr) {
    const { ci, pi, si } = addr;
    if (ci !== state.ci) goToChapter(ci);          // mount the target chapter first
    const el = highlightSentence(ci, pi, si);       // existing seam (toggles .is-reading)
    if (!el) return;
    if (currentView() === 'continuous') scrollSentenceThreeQuarters(el);
    else goToPageContaining(el);                    // existing seam (flips to its page)
  },
};

// design.md §5: in scroll mode hold the highlighted line ~¾ up so the eyes rest.
function scrollSentenceThreeQuarters(el) {
  const vpRect = viewport.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  const target = viewport.scrollTop + (elRect.top - vpRect.top) - vpRect.height * 0.25;
  viewport.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
}
```

> `goToPageContaining` already handles paged modes via the span's `offsetLeft`. The HANDOFF gotcha
> warns offsets can read pre-fragmentation on some engines — if a flip lands on the wrong page in
> testing, add a `getBoundingClientRect`-based fallback inside `goToPageContaining` (it's already
> flagged there). Note any such fix in your report.

**Step 4: Instantiate the player when a book loads**

In `showDocument()`, after `paginate()`, create the player for this doc:

```js
  // Phase 2: build the narrator for this book.
  state.player = ReaderPlayer.createPlayer({
    doc,
    synth: (text) => window.reader.synthesize(text, { voice: 'af_heart' }),
    makeClip,
    view: ReaderView,
    prefetchAhead: 2,
  });
  updatePlayButton();
```

Add `player: null` to the `state` object, and a tiny helper:
```js
function updatePlayButton() {
  const btn = document.getElementById('play-pause');
  const on = state.player && state.player.isPlaying();
  btn.textContent = on ? '⏸' : '▶';
  btn.setAttribute('aria-label', on ? 'Pause' : 'Play');
}
```

**Step 5: Wire the control buttons + keyboard**

```js
const P2 = () => state.player;
document.getElementById('play-pause').addEventListener('click', async () => { await resumeAudio(); await P2()?.toggle(); updatePlayButton(); });
document.getElementById('back-sent').addEventListener('click', () => P2()?.backSentence());
document.getElementById('fwd-sent').addEventListener('click', () => P2()?.forwardSentence());
document.getElementById('back-para').addEventListener('click', () => P2()?.backParagraph());

// Click a sentence to start reading there.
readingEl.addEventListener('click', async (e) => {
  const span = e.target.closest('.sentence');
  if (!span || !P2()) return;
  await resumeAudio();
  P2().jumpTo({ ci: +span.dataset.chapter, pi: +span.dataset.paragraph, si: +span.dataset.sentence });
  updatePlayButton();
});
```

Add to the existing `keydown` handler (spacebar = play/pause — note `←/→` already flip pages, so
keep sentence-rewind on the buttons to avoid clashing with page flip):
```js
    case ' ':
    case 'Spacebar':
      if (P2()) { resumeAudio().then(() => { P2().toggle(); updatePlayButton(); }); } e.preventDefault(); break;
```

> The controller calls `view.show`, which may `goToChapter` — that re-renders the chapter and the
> highlight is re-applied by the same `show`. Good. But `updatePlayButton()` should also be called
> when playback **auto-stops at book end**; add a tiny `onStateChange` callback to the player
> options if you want the button to flip without a user action, or poll it in `view.show`. Keep it
> simple; note your choice.

**Step 6: Style the controls (styles.css)**

Make `#play-pause` the large primary control; size all four for easy hitting (design.md §2 "big,
easy-to-hit"). Match the existing bottom-bar button styling. (No code mandated — follow the calm
visual language already in `styles.css`.)

**Step 7: Manual verify end-to-end**

```bash
npm start
```
Drag in `test/fixtures/alice.epub`. Press Space. Expected: you **hear** narration; the spoken
sentence is **highlighted**; in scroll mode it rides ~¾ up; in single/two-page it flips pages as
it reads; ↶ replays the previous sentence; ⏮ jumps to the paragraph start; clicking a sentence
starts there; at a chapter's end it continues into the next chapter automatically.

**Step 8: Commit**

```bash
git add src/renderer/index.html src/renderer/styles.css src/renderer/app.js
git commit -m "feat(player): wire audio, highlight, scroll/flip, and playback controls"
```

---

# TASK 6 — Cross-chapter continuation, ¾-up, and edge cases (verify + harden)

Most of this is already wired (the controller advances across chapters; `view.show` mounts the
target chapter; `scrollSentenceThreeQuarters` handles ¾-up). This task is to **verify the seams
behave** under real layout and fix the rough edges, since these are the bugs that only show up
live.

**Files:**
- Modify: `src/renderer/app.js` (only if fixes are needed)

**Verify / harden checklist:**

1. **Cross-chapter roll while playing:** start near a chapter's end; on the last sentence's clip
   end, the player advances to the next chapter — confirm `goToChapter` fires, the new chapter
   mounts, and its first sentence highlights and plays **without a gap that loses the highlight**.
2. **¾-up in scroll mode:** confirm the highlighted line settles ~¾ up and doesn't jump jarringly
   (smooth scroll). Long sentences spanning a page boundary in paged mode: confirm the flip lands
   on the page where the sentence *starts*.
3. **Book end:** last sentence of last chapter ends → playback stops cleanly, play button resets,
   no error.
4. **Pause/resume mid-sentence:** pause stops audio immediately; resume re-plays the current
   sentence from its start (acceptable for sentence-level; note it).
5. **Rewind past a chapter start:** ↶ on the first sentence of a chapter → previous chapter's last
   sentence (mounts that chapter). ⏮ likewise.
6. **Prefetch across a chapter boundary** doesn't force a premature chapter mount — prefetch only
   *synthesizes* (audio), it must **not** call `view.show`/`goToChapter`. Confirm in code:
   `prefetch()` calls `clipFor` only. (It does — keep it that way.)

**Step: Commit any fixes**

```bash
git add src/renderer/app.js
git commit -m "fix(player): harden cross-chapter continuation and highlight reveal"
```

---

# TASK 7 — Packaging: ship the model + native binary, prove offline in the .exe

**Files:**
- Modify: `package.json` (`build` block)

**Step 1: Ensure the model ships and the native ORT binary is unpacked**

`assets/**/*` already ships the model (Phase 1.5 confirmed fonts ship via that glob — the model
rides the same glob). The new requirement: `onnxruntime-node`'s native `.node` binary lives in
`node_modules` and **must be `asarUnpack`ed** (a native binary can't be loaded from inside an
asar). Add to `build`:

```json
    "asarUnpack": [
      "**/node_modules/onnxruntime-node/**"
    ]
```

> electron-builder often auto-detects `.node` files, but **make it explicit** so it's not
> version-dependent. Also confirm `@huggingface/transformers` and `kokoro-js` are NOT excluded by
> the `files` globs (they're in `node_modules`, included by default — just don't add an exclude).

**Step 2: Build the Windows portable exe**

```bash
npm run dist:win
```
Expected: `dist/Reader-<version>-portable.exe` is produced.

**Step 3: Prove offline synthesis in the PACKAGED app**

- Disable the network adapter.
- Launch the `dist/Reader-<version>-portable.exe` just built (double-click — no terminal).
- Drag in an EPUB, press Play.

Expected: **narration plays with the network off**, from the packaged exe. This is the real
acceptance gate — it proves the model is bundled, the path resolves under `process.resourcesPath`,
and the native binary loaded from the unpacked location.

> Verify the model is actually inside the package: check `dist/win-unpacked/resources/assets/models/`
> exists and is populated, and `dist/win-unpacked/resources/app.asar.unpacked/node_modules/onnxruntime-node/`
> contains the `.node` binary. Report both.

**Step 4: Commit**

```bash
git add package.json
git commit -m "build: unpack onnxruntime-node native binary; ship Kokoro model offline"
```

> **macOS:** still build-on-the-Mac only (Phase 1 carryover). `onnxruntime-node` installs the
> arm64 binary on `npm install` on the M5, so `npm run dist:mac` there will bundle the right one.
> Not verified this round — Windows focus, consistent with prior phases.

---

# TASK 8 — Smoke test extension + manual-listen checklist

Audio can't be "heard" by Playwright, and real synthesis is slow, so the smoke proves the
**mechanism** (highlight engages and advances) while the **voice quality** is a manual listen.

**Files:**
- Modify: `test/smoke/launch.smoke.js`

**Step 1: Extend the smoke to assert the highlight advances**

After the existing book-load assertions, add a block that drives playback through the **real**
IPC + engine but asserts on the DOM, not audio:

```js
  // --- Phase 2: narration highlights a sentence and advances -----------------
  // Press play; the engine synthesizes the first sentence (real IPC), it plays,
  // and .is-reading lands on the first sentence, then advances to the next.
  await win.click('#play-pause');
  await win.waitForSelector('.sentence.is-reading', { timeout: 60000 }); // first clip can be slow (model warm-up)
  const firstKey = await win.evaluate(() => {
    const el = document.querySelector('.sentence.is-reading');
    return `${el.dataset.chapter}.${el.dataset.paragraph}.${el.dataset.sentence}`;
  });
  // Wait for the highlight to move to a DIFFERENT sentence (clip ended → advanced).
  await win.waitForFunction((prev) => {
    const el = document.querySelector('.sentence.is-reading');
    return el && `${el.dataset.chapter}.${el.dataset.paragraph}.${el.dataset.sentence}` !== prev;
  }, firstKey, { timeout: 120000 });
  await win.click('#play-pause'); // pause
  console.log('  ✓ narration highlight advanced past the first sentence');
```

> If real synthesis proves too slow/flaky for the smoke gate, fall back to asserting the first
> highlight appears (proves IPC + engine + decode + highlight) and move the "advances" assertion
> to the manual checklist. State which you did.

**Step 2: Run the smoke**

```bash
npm run smoke
```
Expected: PASS, including the new narration assertion. (Allow a long timeout for first-clip model
load.)

**Step 3: Manual-listen checklist (record results in your report)**

Drag in each of the **7 EPUBs** used before (3 Gutenberg fixtures + the user's 4 commercial books)
and confirm, by listening:
- [ ] Voice is clear and warm (Kokoro `af_heart`); no garbled audio.
- [ ] Highlight matches the spoken sentence (no drift — they advance together).
- [ ] Scroll mode holds the line ~¾ up; paged modes flip with the reading.
- [ ] Back-a-sentence / back-a-paragraph / forward work and resume cleanly.
- [ ] Crosses chapter boundaries without stalling.
- [ ] Second play of the same passage is instant (cache hit).
- [ ] **Offline** (adapter off) in the packaged exe.

**Step 4: Commit**

```bash
git add test/smoke/launch.smoke.js
git commit -m "test(smoke): assert narration highlight engages and advances"
```

---

## Acceptance criteria (this phase is done when…)

1. **It reads aloud.** Pressing Play (or Space) narrates the book in Kokoro's voice, **offline**,
   from the **packaged `.exe`** with the network off.
2. **The spoken sentence is highlighted** and stays in sync (one clip per sentence; advance on
   clip end). Highlight only toggles `.is-reading` on the existing spans — the DOM contract holds
   in all three view modes.
3. **The highlight is brought into view:** ~¾ up in scroll mode; the correct page in single/two-
   page mode.
4. **Controls work:** Play/Pause, back-a-sentence, back-a-paragraph, forward-a-sentence; Space =
   play/pause; **clicking a sentence starts there.**
5. **Reading continues across chapters** automatically (mounts the next chapter, keeps the
   highlight), and **stops cleanly at the end of the book.**
6. **Prefetch** keeps playback gapless (next 2 sentences synthesized ahead); **rewind/re-read is
   instant** via the on-disk clip cache.
7. **Voice-agnostic seam intact:** the renderer only calls `reader.synthesize`; swapping the
   engine means editing only `tts-service.js`.
8. **Engine is off the main thread** (utilityProcess) and **CPU-only**; the UI doesn't jank while
   prefetching.
9. **Tests:** all prior 31 unit tests stay green; new `reading-cursor`, `clip-cache`, and `player`
   unit tests pass; the extended smoke passes; the manual-listen checklist is recorded.
10. No crash narrating across the same 7 EPUBs.

---

## Testing summary

- **Unit (`npm test`, pure logic only):** `reading-cursor` (next/prev/back-paragraph/prefetch/
  bounds), `clip-cache` (`clipKey` stability), `player` (advance-on-end, cross-chapter, rewind,
  prefetch, pause race) — all via injected fakes, **no real audio/model in unit tests.**
- **Smoke (`npm run smoke`):** real IPC + engine + decode + highlight; assert `.is-reading`
  appears and advances. Long timeout for first-clip model load.
- **Manual:** the listen checklist (voice quality + sync can only be judged by ear), and the
  **offline-in-packaged-exe** gate.

---

## Out of scope for Phase 2 (do NOT build)

- **Reading-speed** control, **voice-picker** UI, **end-of-chapter-pause** *control*,
  **pronunciation** overrides → **Phase 4.** (The `synthesize` seam already takes `opts` so these
  slot in later without a rewrite. Voice is fixed `af_heart`, speed fixed 1.0 this phase.)
- **Library / covers / drag-to-add shelf / auto-resume-on-launch** → **Phase 3.** (The clip cache
  here is content-addressed and global; Phase 3 may formalize per-book folders + resume.)
- **Markdown / DOCX** → Phase 4. EPUB only, still.
- **GPU**, word-level highlighting, forced alignment, Whisper — explicitly rejected (design.md §4).
- **macOS build verification** — Windows focus; just don't break cross-platform (CPU + local model
  keep behavior identical).
- **Code-signing / notarization.**

---

## When finished

1. Confirm each acceptance criterion with a real check; note any partial.
2. **Do NOT edit `HANDOFF.md`, `design.md`, or any doc.** Write a **report in chat** covering:
   what you built; per-criterion verification **with actual output** (test counts, smoke result,
   the offline-in-exe result, the manual-listen results); the **Task-0 findings** (exact
   `kokoro-js` API/version, model file layout, the utilityProcess transfer mechanism, whether
   node/ORT loaded in Electron or you fell back to wasm); whether `assets/models/` was committed or
   is fetch-on-build; any `electron-builder` changes; and new gotchas (esp. ORT-in-Electron,
   offline path resolution, the WAV transfer detail, any `goToPageContaining` offset fix). The
   planning session verifies it and records `HANDOFF.md`.
3. Leave the voice-agnostic `reader.synthesize` seam, the pure `reading-cursor`, and the injected
   player edges clearly in place — Phase 3/4 build on them.

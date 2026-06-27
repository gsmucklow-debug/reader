# Phase 2.5 Plan — Voice & Playback Settings (voice picker, speed, end-of-chapter pause)

> **Run this with:** Claude **Sonnet 4.6, medium thinking** is fine (this is mostly settings/UI
> wiring) — but two spots are subtle and must be tested carefully: the **cancelable end-of-chapter
> pause** and the **cache-key / prefetch-flush on a voice/speed change**. If you prefer, **Opus 4.8
> high** for safety.
>
> **STRICT — separation of duties (see [`../design.md`](../design.md) §10):**
> You are a **builder session. Execute this plan only.** Do **NOT** edit any planning document —
> not `HANDOFF.md`, not `design.md`, not this plan, not anything in `docs/`. When you finish,
> **deliver a self-contained written report** in chat (what you built, how you verified each
> acceptance criterion with real output, what's left/partial, gotchas). The planning session
> verifies your report and is the **sole author** of `HANDOFF.md`.
>
> **Full context if needed:** [`../design.md`](../design.md) (§3 voice, §5 comfort controls),
> [`../HANDOFF.md`](../HANDOFF.md), [`phase-2-voice-highlighting.md`](./phase-2-voice-highlighting.md).
> Phase 2 (voice + highlighting) is **built and verified**: 52 unit tests + a smoke test green; the
> book narrates with a moving highlight, fully offline. This phase **exposes settings** the engine
> already supports — it does not change the core narration architecture.

---

## Goal of this phase

Let the user **change the narrator's voice, adjust reading speed, and set an end-of-chapter pause**,
all from the existing "Aa" comfort popover, saved globally. Pulls these comfort/voice items forward
from Phase 4 (design.md §5) because the engine already supports them — Kokoro ships ~54 voices and a
`speed` param, and `reader.synthesize` already takes an `opts` object.

**In scope:** a curated **voice picker** (best US/UK male+female English voices) each with a **▶
preview** button; a **reading-speed** slider; an **end-of-chapter pause** control (Off / Short /
Longer); all **global**, persisted in the existing `settings.json`. A voice or speed change
**restarts the current sentence immediately** in the new setting.

**Explicitly NOT this phase:** per-book voice memory (needs Phase 3's library/per-book store);
non-English / other-language voices; pronunciation overrides (Phase 4); Markdown/DOCX. Default stays
`af_heart` at `1.0×` with pause `off` — an existing user sees no change until they touch a control.

---

## Hard constraints / invariants (do not violate)

- **Keep the voice-agnostic seam.** The renderer still only calls `reader.synthesize(text, opts)`.
  We're widening `opts` from `{voice}` to `{voice, speed}` — that's it. No engine swap, no new IPC
  surface beyond what exists.
- **Offline / CPU / utilityProcess unchanged.** No network; Kokoro stays on CPU in the
  `utilityProcess`. Voices already ship in the package (`node_modules/kokoro-js/voices/*.bin`).
- **The per-sentence DOM contract is untouched.** Highlighting still only toggles `.is-reading`.
  This phase changes *what audio* a sentence gets, never *how it's highlighted*.
- **The on-disk clip cache must stay correct under multiple voices/speeds.** Switching voice must
  NOT corrupt or wipe existing cached clips — each (voice, speed, text) combination caches
  independently. (You're adding `speed` to the key; `voice` is already there.)
- **Don't regress Phase 2.** All 52 unit tests + the smoke stay green. The player's token-guard,
  poison-eviction, bounded clip cache, and book-end button reset all keep working.
- **Calm, low-load UI.** Controls live in the one comfort popover, clearly labeled, keyboard/click
  friendly. Don't scatter new controls around the screen.

---

## How it fits together (read before coding)

```
 settings popover (app.js)         player.js (controller)            engine
 ─────────────────────────         ──────────────────────            ──────
 voice list + ▶preview      ┌─────► synth(text) reads LIVE  ──IPC──► tts-service.generate(text,
 speed slider (on release)  │       voice+speed at call time           { voice, speed })
 pause Off/Short/Longer      │       reload() on voice/speed change
   └── on change ────────────┘         = flushPrefetch + restart current sentence
   persisted in settings.json          onEnded waits endChapterPauseMs() when crossing a chapter
```

- **Live params, not a rebuilt player:** the injected `synth` closure reads the *current* voice and
  speed from app state each call, so a change takes effect by (a) flushing the player's in-memory
  prefetch and (b) restarting the current sentence — no `createPlayer` rebuild.
- **Cache:** `clipKey(text, voice, speed)` → distinct files per combo; rewind stays instant; nothing
  is invalidated on a switch.

---

# TASK 1 — Engine accepts `speed`; cache key includes `speed`; verify the real voice IDs

**Files:**
- Modify: `src/main/tts-service.js`
- Modify: `src/main/clip-cache.js`
- Modify: `src/main/main.js`
- Test: `test/unit/clip-cache.test.js`

**Step 1: Verify the actual installed voice IDs + grades (grounds the curated list in Task 4).**

Quick throwaway probe (the curated list in Task 4 must use IDs that actually exist). Run a tiny
Node script (or reuse the spike pattern) that loads the model and prints the voices:

```bash
node -e "(async()=>{const {KokoroTTS}=await import('kokoro-js');const {env}=await import('@huggingface/transformers');env.cacheDir='assets/models';env.allowRemoteModels=false;const t=await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX',{dtype:'q8',device:'cpu'});console.log(Object.keys(t.voices));console.log(t.voices)})().catch(e=>{console.error(e);process.exit(1)})"
```
(If `ELECTRON_RUN_AS_NODE` is set, `node` is unaffected — that var only changes the `electron` binary.)
**Record the exact American (`af_*`,`am_*`) and British (`bf_*`,`bm_*`) IDs and any grade metadata.**
Task 4's curated list must only use IDs that appear here. Report the list.

**Step 2 (TDD): cache key includes speed — write the failing test.**

In `test/unit/clip-cache.test.js`, extend/replace the clipKey test:

```js
test('clipKey depends on text, voice, AND speed', () => {
  const base = clipKey('Hello world.', 'af_heart', 1);
  assert.strictEqual(base, clipKey('Hello world.', 'af_heart', 1)); // stable
  assert.notStrictEqual(base, clipKey('Hello world.', 'bf_emma', 1)); // voice
  assert.notStrictEqual(base, clipKey('Goodbye world.', 'af_heart', 1)); // text
  assert.notStrictEqual(base, clipKey('Hello world.', 'af_heart', 1.25)); // speed
  assert.match(base, /^[0-9a-f]{16,}\.wav$/);
});
```
Run `npm test -- --test-name-pattern="clipKey"` → FAIL (speed not in key yet).

**Step 3: Add `speed` to `clipKey`.**

```js
function clipKey(text, voice, speed) {
  const v = voice || 'af_heart';
  const s = Number.isFinite(speed) ? speed : 1;
  const h = crypto.createHash('sha1').update(`${v} ${s} ${text}`).digest('hex');
  return `${h}.wav`;
}
```
Update `makeCache`'s `get`/`put` to take and forward `speed`:
`get(text, voice, speed)` / `put(text, voice, speed, bytes)` — thread `speed` through to `clipKey`.
Run the test → PASS. Then `npm test` (all green).

**Step 4: `tts-service.js` passes `speed` to Kokoro.**

In the `synthesize` handler, accept `speed` and pass it:
```js
async function synthesize({ text, voice, speed }) {
  const tts = await getTTS();
  const audio = await tts.generate(text, { voice: voice || 'af_heart', speed: clampSpeed(speed) });
  return { wav: toWavBytes(audio), sampleRate: audio.sampling_rate };
}
function clampSpeed(s) { const n = Number(s); return Number.isFinite(n) ? Math.min(2, Math.max(0.5, n)) : 1; }
```
(Kokoro's `generate` accepts `speed`. Clamp defensively.)

**Step 5: `main.js` handler threads `speed` (and keys the cache by it).**

The handler already destructures `{ text, voice }` — add `speed`:
```js
ipcMain.handle('synthesize', async (_evt, { text, voice, speed }) => {
  voice = voice || 'af_heart';
  clipCache ||= makeCache(path.join(app.getPath('userData'), 'clips'));
  const hit = await clipCache.get(text, voice, speed);
  if (hit) return { wav: hit, sampleRate: 24000 };
  const res = await ttsRequest({ type: 'synthesize', text, voice, speed });
  await clipCache.put(text, voice, speed, res.wav);
  return { wav: res.wav, sampleRate: res.sampleRate };
});
```
(`preload.js` already sends `{ text, ...opts }`, so `{voice, speed}` flows with no preload change —
confirm this.)

**Step 6: Commit.**
```bash
git add src/main/tts-service.js src/main/clip-cache.js src/main/main.js test/unit/clip-cache.test.js
git commit -m "feat(tts): thread reading speed through synth + cache key"
```
Trailer on every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

# TASK 2 — Player: `reload()` (flush + restart) and a cancelable end-of-chapter pause

**Files:**
- Modify: `src/renderer/player.js`
- Test: `test/unit/player.test.js`

The player already injects its edges and is unit-tested with fakes. Add two capabilities, keeping
everything pure/injected.

**Step 1 (TDD): write the failing tests.**

Add to `test/unit/player.test.js`. The pause test uses **node's mock timers** (no real waiting):

```js
test('reload() flushes prefetch and restarts the current sentence when playing', async () => {
  const { deps, shown, synthed, endCurrent } = fakeDeps();
  const p = createPlayer({ ...deps, prefetchAhead: 0 });
  await p.play(); await tick();              // 0.0.0 playing, synthed: ['a0']
  await p.reload(); await tick();            // restart current sentence in new params
  assert.strictEqual(shown[shown.length - 1], '0.0.0'); // re-shown (restarted), not advanced
  assert.deepStrictEqual(synthed, ['a0', 'a0']); // re-synthesized (prefetch was flushed)
});

test('reload() while paused only flushes (does not start playing)', async () => {
  const { deps, endCurrent } = fakeDeps();
  const p = createPlayer({ ...deps, prefetchAhead: 0 });
  await p.play(); await tick(); p.pause();
  await p.reload(); await tick();
  assert.strictEqual(p.isPlaying(), false);
});

test('end-of-chapter pause defers the cross-chapter advance and is cancelable', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { deps, shown, endCurrent } = fakeDeps();
  // doc: ch0 has 0.0.0 then 0.1.0; ch1 has 1.0.0 (see the test doc at top of file)
  const p = createPlayer({ ...deps, prefetchAhead: 0, endChapterPauseMs: () => 1500 });
  await p.play(); await tick();              // 0.0.0
  endCurrent(); await tick();                // → 0.1.0 (same chapter, no pause)
  assert.strictEqual(shown[shown.length - 1], '0.1.0');
  endCurrent(); await tick();                // crossing into ch1 → should WAIT
  assert.strictEqual(shown[shown.length - 1], '0.1.0'); // not advanced yet (paused beat)
  t.mock.timers.tick(1500); await tick();    // beat elapses
  assert.strictEqual(shown[shown.length - 1], '1.0.0'); // now advanced into ch1
});

test('end-of-chapter pause is cancelled by pause() during the beat', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { deps, shown, endCurrent } = fakeDeps();
  const p = createPlayer({ ...deps, prefetchAhead: 0, endChapterPauseMs: () => 1500 });
  await p.play(); await tick(); endCurrent(); await tick(); // at 0.1.0
  endCurrent(); await tick();                // crossing → beat starts
  p.pause();                                 // cancel during the beat
  t.mock.timers.tick(1500); await tick();
  assert.strictEqual(shown[shown.length - 1], '0.1.0'); // never advanced into ch1
  assert.strictEqual(p.isPlaying(), false);
});
```
Run `npm test` → the new tests FAIL.

**Step 2: implement in `player.js`.**

Add an injected pause getter near the other deps:
```js
const endChapterPauseMs = deps.endChapterPauseMs || (() => 0); // live: ms to wait crossing a chapter
```

Add `reload()` and route the controls object to expose it:
```js
// Apply a voice/speed change: drop the now-stale prefetch (synthesized with the
// old params) and restart the current sentence so the change is heard immediately.
// Paused: just flush; the next play() re-synthesizes with the new params.
function reload() {
  clips.clear();
  if (addr) return seekTo(addr); // seekTo replays if playing, re-shows if paused
}
```
(Add `reload` to the returned object.)

Make `onEnded` honor the cross-chapter beat (cancelable via the existing token):
```js
function onEnded(my) {
  if (my !== token || !playing) return;
  const next = Cursor.nextAddress(doc, addr);
  if (!next) { setPlaying(false); activeClip = null; return; }
  const crossing = next.ci !== addr.ci;
  addr = next;
  activeClip = null;
  const waitMs = crossing ? endChapterPauseMs() : 0;
  if (waitMs > 0) {
    const mine = my; // token is unchanged until the next playCurrent; a pause/seek bumps it
    setTimeout(() => { if (mine === token && playing) playCurrent(); }, waitMs);
  } else {
    playCurrent();
  }
}
```
Note: `pause()`/`seekTo` call `stopInternal()` which bumps `token`, so a beat in flight is
cancelled by the `mine === token` check. Run `npm test` → all green (56-ish tests).

**Step 3: Commit.**
```bash
git add src/renderer/player.js test/unit/player.test.js
git commit -m "feat(player): reload() for live voice/speed change + cancelable end-of-chapter pause"
```

---

# TASK 3 — Renderer state + wiring (live voice/speed/pause; restart-on-change)

**Files:**
- Modify: `src/renderer/app.js`

No UI yet (Task 4) — just the state, the live synth params, and the player wiring.

**Step 1: hold the live settings in `state`.**
```js
// add to the `state` object:
  voice: 'af_heart',
  speed: 1,
  endChapterPause: 'off', // 'off' | 'short' | 'longer'
```
Add a map from the pause setting to milliseconds:
```js
const PAUSE_MS = { off: 0, short: 1500, longer: 4000 };
function endChapterPauseMs() { return PAUSE_MS[state.endChapterPause] ?? 0; }
```

**Step 2: the player reads LIVE voice/speed; inject the pause getter.**

In `showDocument()`'s `createPlayer({...})`, change the synth closure + add the pause getter:
```js
    synth: (text) => window.reader.synthesize(text, { voice: state.voice, speed: state.speed })
      .catch((e) => { console.warn('[Reader] synth failed:', e); throw e; }),
    ...
    endChapterPauseMs,
```
(`makeClip`, `view`, `onStateChange`, `prefetchAhead` stay as they are.)

**Step 3: apply-change helpers (used by the UI in Task 4 and by settings-load).**
```js
function setVoice(voiceId) {
  state.voice = voiceId || 'af_heart';
  if (state.player) state.player.reload(); // flush + restart current sentence in the new voice
  saveSettings();
}
function setSpeed(x) {
  state.speed = Math.min(1.5, Math.max(0.7, Number(x) || 1));
  if (state.player) state.player.reload(); // restart current sentence at the new speed
  saveSettings();
}
function setEndChapterPause(mode) {
  state.endChapterPause = (mode in PAUSE_MS) ? mode : 'off';
  // no reload needed — only affects the NEXT chapter crossing
  saveSettings();
}
```
> Speed note: call `setSpeed` from the slider's **`change`** (release) event, not `input`, so one
> restart per adjustment, not one per drag tick. Update the live "1.0×" label on `input`.

**Step 4: Commit.**
```bash
git add src/renderer/app.js
git commit -m "feat(player): live voice/speed/pause state + restart-on-change wiring"
```

---

# TASK 4 — UI: voice picker (+ preview), speed slider, pause control

**Files:**
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/app.js`
- Modify: `src/renderer/styles.css`

**Step 1: markup in `#settings-panel`** (add a Voice section above or below Font; Speed + Pause near
it). Mirror the existing `.setting` / `.font-list` structure:
```html
<div class="setting setting-voice">
  <span>Voice</span>
  <div class="voice-list" id="voice-list" role="listbox" aria-label="Narration voice"></div>
</div>
<div class="setting">
  <label for="speed-range">Reading speed</label>
  <input id="speed-range" type="range" min="0.7" max="1.5" step="0.05" value="1" />
  <span id="speed-label" aria-live="polite">1.0×</span>
</div>
<div class="setting">
  <span>End-of-chapter pause</span>
  <div class="segmented" id="pause-toggle">
    <button type="button" data-pause="off" class="active">Off</button>
    <button type="button" data-pause="short">Short</button>
    <button type="button" data-pause="longer">Longer</button>
  </div>
</div>
```

**Step 2: the curated voice catalog in `app.js`** (use ONLY IDs confirmed present in Task 1 Step 1;
this is the target — adjust to reality):
```js
// Curated best English voices, grouped. `id` must exist in the installed kokoro-js voices.
const VOICES = [
  { group: 'US',  items: [
    { id: 'af_heart',    label: 'Heart — US, female' },
    { id: 'af_bella',    label: 'Bella — US, female' },
    { id: 'am_michael',  label: 'Michael — US, male' },
    { id: 'am_fenrir',   label: 'Fenrir — US, male' },
  ]},
  { group: 'UK',  items: [
    { id: 'bf_emma',     label: 'Emma — UK, female' },
    { id: 'bf_isabella', label: 'Isabella — UK, female' },
    { id: 'bm_george',   label: 'George — UK, male' },
    { id: 'bm_fable',    label: 'Fable — UK, male' },
  ]},
];
const SAMPLE_TEXT = 'The quick brown fox jumps over the lazy dog.';
```

**Step 3: build the list with a ▶ preview per row** (each row: a select button + a preview button):
```js
const voiceListEl = document.getElementById('voice-list');
function buildVoiceList() {
  voiceListEl.innerHTML = '';
  for (const grp of VOICES) {
    const h = document.createElement('div'); h.className = 'voice-group'; h.textContent = grp.group;
    voiceListEl.appendChild(h);
    for (const v of grp.items) {
      const row = document.createElement('div'); row.className = 'voice-row';
      const pick = document.createElement('button');
      pick.type = 'button'; pick.className = 'voice-pick'; pick.dataset.voice = v.id; pick.textContent = v.label;
      pick.addEventListener('click', () => { setVoice(v.id); markActiveVoice(); });
      const prev = document.createElement('button');
      prev.type = 'button'; prev.className = 'voice-preview'; prev.title = 'Preview'; prev.setAttribute('aria-label', `Preview ${v.label}`);
      prev.textContent = '▶';
      prev.addEventListener('click', (e) => { e.stopPropagation(); previewVoice(v.id); });
      row.append(pick, prev);
      voiceListEl.appendChild(row);
    }
  }
  markActiveVoice();
}
function markActiveVoice() {
  for (const b of voiceListEl.querySelectorAll('.voice-pick')) {
    b.classList.toggle('active', b.dataset.voice === state.voice);
  }
}
```

**Step 4: preview playback** (pauses narration; one-shot; user resumes manually):
```js
let previewClip = null;
async function previewVoice(voiceId) {
  if (state.player && state.player.isPlaying()) state.player.pause(); // duck narration; user resumes
  await resumeAudio();
  try {
    if (previewClip) previewClip.stop();
    const { wav, sampleRate } = await window.reader.synthesize(SAMPLE_TEXT, { voice: voiceId, speed: state.speed });
    previewClip = await makeClip(wav, sampleRate);
    previewClip.play(() => {});
  } catch (e) { console.warn('[Reader] voice preview failed:', e); }
}
```

**Step 5: speed slider + pause control wiring.**
```js
const speedRange = document.getElementById('speed-range');
const speedLabel = document.getElementById('speed-label');
speedRange.addEventListener('input', () => { speedLabel.textContent = `${(+speedRange.value).toFixed(2).replace(/0$/,'')}×`; });
speedRange.addEventListener('change', () => setSpeed(+speedRange.value)); // one restart on release

document.getElementById('pause-toggle').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-pause]'); if (!btn) return;
  setEndChapterPause(btn.dataset.pause);
  for (const b of document.querySelectorAll('#pause-toggle button')) b.classList.toggle('active', b === btn);
});
```
Call `buildVoiceList()` in the boot section (next to `buildFontList()`).

**Step 6: styles** in `styles.css` — `.voice-group` (a quiet header), `.voice-row` (flex: label
grows, ▶ preview small on the right), `.voice-pick.active` highlighted like the font picker; match
the calm popover language. Keep it scannable.

**Step 7: Commit.**
```bash
git add src/renderer/index.html src/renderer/app.js src/renderer/styles.css
git commit -m "feat(ui): voice picker with preview, reading-speed slider, end-of-chapter pause"
```

---

# TASK 5 — Persist the new settings (global)

**Files:**
- Modify: `src/main/main.js`
- Modify: `src/renderer/app.js`

**Step 1: whitelist the new keys in `main.js`.**
```js
const SETTINGS_KEYS = ['font', 'theme', 'textSize', 'pageWidth', 'viewMode', 'voice', 'speed', 'endChapterPause'];
```

**Step 2: include them in `gatherSettings()` and apply them in `applySettings()` (app.js).**
```js
// gatherSettings(): add
  voice: state.voice,
  speed: state.speed,
  endChapterPause: state.endChapterPause,

// applySettings(s): add (apply WITHOUT triggering a reload/save storm — set state + reflect UI)
  if (typeof s.voice === 'string') { state.voice = s.voice; markActiveVoice(); }
  if (Number.isFinite(s.speed)) {
    state.speed = s.speed;
    speedRange.value = String(s.speed);
    speedLabel.textContent = `${(+s.speed).toFixed(2).replace(/0$/,'')}×`;
  }
  if (s.endChapterPause in PAUSE_MS) {
    state.endChapterPause = s.endChapterPause;
    for (const b of document.querySelectorAll('#pause-toggle button')) b.classList.toggle('active', b.dataset.pause === s.endChapterPause);
  }
```
> Apply settings BEFORE the first `createPlayer` so the synth closure (which reads `state.voice/speed`
> live) and `endChapterPauseMs()` see the saved values. `loadSettings()` already runs at boot; make
> sure `buildVoiceList()` has run first so `markActiveVoice()` has buttons to mark.

**Step 3: verify persistence** (manual): `npm start`, pick a voice + speed + pause, close, reopen →
they're restored. Then `npm test` (still green).

**Step 4: Commit.**
```bash
git add src/main/main.js src/renderer/app.js
git commit -m "feat(settings): persist voice, speed, and end-of-chapter pause globally"
```

---

# TASK 6 — Smoke test + manual checklist

**Files:**
- Modify: `test/smoke/launch.smoke.js`
- Modify: `HOW-TO-RUN.md` (user-facing run guide — OK to edit; NOT a planning doc)

**Step 1: extend the smoke** (after the narration block). Open the comfort popover, change the
voice, assert narration **restarts** (a fresh `.is-reading` re-render / it keeps narrating after the
switch), and that the speed + pause settings **persist across a restart** (the smoke already
restarts the app for the settings test — fold `voice/speed/endChapterPause` into the values it sets
to non-defaults and re-reads). Use the existing helpers and long timeouts (model warm-up). If
driving the preview audio proves flaky headless, assert only that clicking ▶ issues a
`reader.synthesize` for the previewed voice (you can spy via a wrapper) and leave the *listening* to
the manual check.

**Step 2: manual checklist** — append to the Phase 2 section in `HOW-TO-RUN.md`:
- [ ] Each curated voice (US/UK × male/female) sounds right via ▶ preview.
- [ ] Picking a voice restarts the current sentence in the new voice immediately.
- [ ] Speed slider changes pace (and restarts the current sentence on release); label tracks.
- [ ] End-of-chapter pause: Off continues immediately; Short/Longer wait the beat; pausing during
      the beat cancels it.
- [ ] Voice/speed/pause survive an app restart.

**Step 3: verify.** `npm run smoke` → PASS (long timeout). `npm test` → all green.

**Step 4: Commit.**
```bash
git add test/smoke/launch.smoke.js HOW-TO-RUN.md
git commit -m "test(smoke): voice change restarts narration; voice/speed/pause persist"
```

---

## Acceptance criteria (this phase is done when…)

1. **Voice picker** shows the curated US/UK male+female voices (IDs verified present in the installed
   kokoro-js), grouped, with the active one marked; picking one **restarts the current sentence in
   that voice immediately** (and sets it for all subsequent sentences).
2. **▶ Preview** plays a short sample in that voice without disturbing the highlight/playback state
   (it pauses narration first; the user resumes).
3. **Reading speed** slider changes narration pace (applies on release, restarts the current
   sentence); the live label tracks the value.
4. **End-of-chapter pause** (Off / Short / Longer) waits the configured beat when crossing into a new
   chapter, and the beat is **cancelable** by pause/seek.
5. **All three persist** globally in `settings.json` across a restart; defaults
   (`af_heart` / `1.0×` / `off`) mean no behavior change until the user picks.
6. **Cache stays correct:** `clipKey` includes `speed` (and `voice`); switching voice/speed does not
   wipe or corrupt existing cached clips; rewind remains instant.
7. **No regression:** all prior unit tests + the new ones pass; the smoke passes (incl. the voice
   change + persistence); the voice-agnostic seam, offline/CPU/utilityProcess, and the per-sentence
   highlight contract are all intact.

---

## Testing summary

- **Unit (`npm test`):** `clipKey` includes speed; `player.reload()` flushes + restarts (or just
  flushes when paused); the end-of-chapter pause defers a cross-chapter advance and is cancelable
  (node `mock.timers`). All Phase 2 tests stay green.
- **Smoke (`npm run smoke`):** real-engine voice change restarts narration; voice/speed/pause persist
  across restart.
- **Manual:** the listen checklist (voice quality, speed feel, pause beats) — the only things ears
  must judge.

---

## Out of scope (do NOT build)

- **Per-book** voice/speed memory (needs Phase 3's library/per-book store). Global only.
- **Non-English / other-language** voices; the full ~54-voice dump. Curated US/UK English only.
- **Pronunciation overrides**, and any change to highlighting/pagination/parsing. (Phase 4 / done.)
- Markdown/DOCX. Cloud/premium voices. Per-voice volume/pitch beyond Kokoro's `speed`.

---

## When finished

1. Confirm each acceptance criterion with a real check; note any partial.
2. **Do NOT edit `HANDOFF.md`, `design.md`, or any doc** (HOW-TO-RUN.md is fine). Write a **report in
   chat**: what you built; the **verified voice IDs/grades** from Task 1; per-criterion verification
   with output (test counts, smoke result, persistence check); any gotchas (esp. kokoro-js `speed`
   behavior, the cache-key change, the cancelable-pause timing); and anything partial. The planning
   session verifies it and records `HANDOFF.md`.
3. Leave the voice-agnostic `reader.synthesize(text, {voice, speed})` seam and the player's
   `reload()` / `endChapterPauseMs` injected edges clearly in place.

# Pronunciation Overrides (deterministic layer) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let the user right-click a mispronounced word in the reader and give it a "sounds-like" respelling that every future reading uses — while the on-screen text never changes.

**Architecture:** A single global map (`{ word: respelling }`) lives in `settings.json`. One pure function `applyPronunciations(text, map)` runs in `main.js`'s `synthesize` handler immediately before `normalizeTTS` — the seam that already separates synth-text from display-text. Because the clip cache keys on the final processed string, a changed map produces a cold-miss + correct re-synth with zero cache-invalidation code, and it works identically for both the Kokoro and expressive GPU engines. The add-a-fix UX is a right-click popover; word detection uses the caret-at-point API (no per-word DOM spans — the per-sentence highlight contract is untouched).

**Tech Stack:** Node `node:test` (unit), Playwright `_electron` (smoke), Electron 33 (Chromium 130), vanilla renderer JS with the project's dual-mode (`module.exports` + `globalThis`) export pattern.

**Design doc:** [`2026-07-02-pronunciation-overrides-design.md`](./2026-07-02-pronunciation-overrides-design.md)

**Scope boundary (do not build):** context-dependent heteronyms ("read" reed/red), per-book overrides, per-sentence expression, import/export/bulk-edit UI. All deferred to the later LLM phase.

**Baseline:** `npm test` → 145 green. Target after this plan: ~160.

**Suggested model:** Build on **Claude Sonnet 5** (this is mechanical TDD — two pure functions + settings wiring, squarely Sonnet's lane). Keep the spec/quality review gate on **Opus 4.8**, per the project's documented role split.

---

## Task 1: `applyPronunciations` pure function (main)

**Files:**
- Create: `src/main/pronounce.js`
- Test: `test/unit/pronounce.test.js`

**Step 1: Write the failing tests**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { applyPronunciations } = require('../../src/main/pronounce');

test('substitutes a mapped word', () => {
  assert.strictEqual(applyPronunciations('I love reading.', { reading: 'reeding' }), 'I love reeding.');
});

test('case-insensitive match, all occurrences, respelling inserted verbatim (no case-copy)', () => {
  assert.strictEqual(
    applyPronunciations('Reading is fun. READING rocks.', { reading: 'reeding' }),
    'reeding is fun. reeding rocks.'
  );
});

test('whole-word only — never inside another word', () => {
  // "read" must not touch "already", "bread", or "readings"
  assert.strictEqual(
    applyPronunciations('already bread readings', { read: 'reed' }),
    'already bread readings'
  );
  assert.strictEqual(applyPronunciations('I read it', { read: 'red' }), 'I red it');
});

test('punctuation and spacing are preserved', () => {
  assert.strictEqual(applyPronunciations('GIF, really?', { gif: 'jiff' }), 'jiff, really?');
});

test('single pass — a substituted respelling is never re-matched by another key', () => {
  assert.strictEqual(applyPronunciations('a', { a: 'b', b: 'c' }), 'b');
});

test('apostrophe words are one token', () => {
  // "don't" is a single word; a key for "don" must not match inside it
  assert.strictEqual(applyPronunciations("don't stop", { don: 'x' }), "don't stop");
});

test('empty respelling is a no-op (never emits an empty string)', () => {
  assert.strictEqual(applyPronunciations('reading', { reading: '' }), 'reading');
  assert.strictEqual(applyPronunciations('reading', { reading: '   ' }), 'reading');
});

test('empty/absent map and empty text pass through', () => {
  assert.strictEqual(applyPronunciations('reading', {}), 'reading');
  assert.strictEqual(applyPronunciations('reading', null), 'reading');
  assert.strictEqual(applyPronunciations('', { reading: 'reeding' }), '');
});

test('prototype-chain word keys do not crash and are left untouched', () => {
  assert.strictEqual(
    applyPronunciations('the constructor toString hasOwnProperty here', { reading: 'reeding' }),
    'the constructor toString hasOwnProperty here'
  );
});

test('typographic apostrophe words are one token', () => {
  assert.strictEqual(applyPronunciations('it’s fine', { it: 'x' }), 'it’s fine');
});

test('punctuation directly adjacent to a word is a clean boundary', () => {
  assert.strictEqual(applyPronunciations('(reading)', { reading: 'reeding' }), '(reeding)');
});
```

**Step 2: Run to verify it fails**

Run: `npx node --test test/unit/pronounce.test.js`
Expected: FAIL — `Cannot find module '../../src/main/pronounce'`.

**Step 3: Write the implementation**

```js
'use strict';
// Apply the user's "sounds-like" pronunciation overrides to a sentence BEFORE it reaches the TTS
// engine. Runs ONLY on the synth-text path (main's synthesize handler, right before normalizeTTS),
// so the on-screen sentence stays pristine and the clip cache keys on the respelled result
// (a changed map => cold miss => correct re-synth). `map` is a flat { lowercasedWord: respelling }.
// Matching is case-insensitive, whole-word, all-occurrences, single-pass; the respelling is
// inserted verbatim (no case-copying). This layer is for words with ONE correct pronunciation the
// engine always gets wrong (reading->reeding, GIF->jiff, names) — NOT context-dependent heteronyms
// (read reed/red), which need the later LLM phase.

// Word-char for boundary purposes: Unicode letters/digits + the apostrophes that occur inside
// words (don't, it's, incl. the typographic '). Everything else is a boundary.
const WORD_CHAR = /[\p{L}\p{N}'’]/u;

function applyPronunciations(text, map) {
  if (!text || !map) return text;
  if (Object.keys(map).length === 0) return text;

  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    if (WORD_CHAR.test(text[i])) {
      let j = i + 1;
      while (j < n && WORD_CHAR.test(text[j])) j++;
      const word = text.slice(i, j);
      // `typeof === 'string'` guard: map[...] reads through the prototype chain, so a word like
      // "constructor"/"toString"/"hasOwnProperty" would otherwise return an inherited FUNCTION
      // (truthy) and crash on .trim(). The guard also hardens against any non-string value.
      const respelling = map[word.toLowerCase()];
      out += (typeof respelling === 'string' && respelling.trim()) ? respelling : word;
      i = j; // single pass: never re-scan a substituted respelling
    } else {
      out += text[i];
      i++;
    }
  }
  return out;
}

module.exports = { applyPronunciations };
```

**Step 4: Run to verify pass**

Run: `npx node --test test/unit/pronounce.test.js`
Expected: PASS (all cases).

**Step 5: Commit**

```bash
git add src/main/pronounce.js test/unit/pronounce.test.js
git commit -m "feat(pronounce): applyPronunciations pure fn for sounds-like overrides"
```

---

## Task 2: Apply the map in the synthesize handler (main)

**Files:**
- Modify: `src/main/main.js` (add the require near the top with the other `./` requires; edit the `synthesize` handler at ~line 247)
- Modify: `src/main/preload.js` (comment only — the opts spread already forwards new fields)

**Step 1: Add the require**

Near the existing requires (with `const { normalizeTTS } = require('./tts-normalize');`), add:

```js
const { applyPronunciations } = require('./pronounce');
```

**Step 2: Widen the destructure + apply before normalize**

In the `ipcMain.handle('synthesize', ...)` handler, add `pronunciations` to the destructured payload and wrap the existing normalize call. Change:

```js
ipcMain.handle('synthesize', async (_evt, {
  text, voice, speed, engine, expressiveVoice, expressiveVoiceMode, exaggeration, cfgWeight, temperature, speedFactor, serverUrl,
}) => {
  voice = voice || 'af_heart';
  const normalized = normalizeTTS(text);
```

to:

```js
ipcMain.handle('synthesize', async (_evt, {
  text, voice, speed, engine, expressiveVoice, expressiveVoiceMode, exaggeration, cfgWeight, temperature, speedFactor, serverUrl, pronunciations,
}) => {
  voice = voice || 'af_heart';
  // Pronunciation overrides first (display text stays pristine), then the existing #digit/all-caps
  // normalization. The clip cache keys on this final string, so a changed map => cold miss =>
  // correct re-synth, and both the Kokoro and expressive branches below inherit the fix for free.
  const normalized = normalizeTTS(applyPronunciations(text, pronunciations || {}));
```

Leave everything below unchanged — both engine branches already read `normalized`, and the cache `get`/`put` already key on it.

**Step 3: Update the preload comment**

In `src/main/preload.js`, extend the `synthesize` comment to mention the new field (the code line is unchanged — `synthesize: (text, opts) => ipcRenderer.invoke('synthesize', { text, ...(opts || {}) })` already forwards it):

```js
  // For the expressive engine, opts also carries { engine, expressiveVoice, expressiveVoiceMode,
  // exaggeration, cfgWeight, temperature, speedFactor, serverUrl }. opts may also carry
  // { pronunciations } — the global sounds-like map, applied in main before normalize/cache-key.
```

**Step 4: Verify nothing regressed**

Run: `npm test`
Expected: 145 passing (no new unit test here — this wiring is proven end-to-end by the smoke in Task 6; the pure logic is covered by Task 1).

**Step 5: Commit**

```bash
git add src/main/main.js src/main/preload.js
git commit -m "feat(tts): apply pronunciation map before normalize in synthesize handler"
```

---

## Task 3: `wordAtOffset` pure function (renderer, dual-mode)

**Files:**
- Create: `src/renderer/word-at-offset.js`
- Modify: `src/renderer/index.html` (add the script tag)
- Test: `test/unit/word-at-offset.test.js`

**Step 1: Write the failing tests**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { wordAtOffset } = require('../../src/renderer/word-at-offset');

test('finds the word at a mid-word offset', () => {
  assert.deepStrictEqual(wordAtOffset('the reading room', 6), { word: 'reading', start: 4, end: 11 });
});

test('finds the word at its start and end offsets', () => {
  assert.strictEqual(wordAtOffset('the reading room', 4).word, 'reading'); // start
  assert.strictEqual(wordAtOffset('the reading room', 11).word, 'reading'); // caret just after 'g'
});

test('returns null on whitespace', () => {
  assert.strictEqual(wordAtOffset('the reading room', 3), null); // the space
});

test('caret just after a word, before punctuation, still returns the word', () => {
  assert.strictEqual(wordAtOffset('GIF, ok', 3).word, 'GIF'); // index 3 is the comma; falls back to F
});

test('apostrophe words are one token', () => {
  assert.strictEqual(wordAtOffset("don't stop", 2).word, "don't");
});

test('out-of-range / empty returns null', () => {
  assert.strictEqual(wordAtOffset('', 0), null);
  assert.strictEqual(wordAtOffset('hi', -1), null);
  assert.strictEqual(wordAtOffset('hi', 5), null);
});
```

**Step 2: Run to verify it fails**

Run: `npx node --test test/unit/word-at-offset.test.js`
Expected: FAIL — module not found.

**Step 3: Write the implementation**

```js
'use strict';
// Given a text string and a caret character offset (from the caret-at-point API), return the
// word token covering that offset as { word, start, end }, or null if the caret is on
// whitespace/punctuation with no adjacent word. Pure + DOM-free so it's unit-testable; the DOM
// caret plumbing lives in app.js. Boundary rule matches src/main/pronounce.js (Unicode letters/
// digits + in-word apostrophes).

const WORD_CHAR = /[\p{L}\p{N}'’]/u;

function wordAtOffset(text, index) {
  if (!text || index == null || index < 0 || index > text.length) return null;
  const isWord = (ch) => ch != null && WORD_CHAR.test(ch);
  // Anchor on the char at the caret; if that's not a word char (caret sits just past a word or on
  // a gap), fall back to the char before the caret.
  let at = index;
  if (!isWord(text[at])) at = index - 1;
  if (!isWord(text[at])) return null;
  let start = at;
  let end = at + 1;
  while (start > 0 && isWord(text[start - 1])) start--;
  while (end < text.length && isWord(text[end])) end++;
  return { word: text.slice(start, end), start, end };
}

// Dual-mode export: CommonJS for node:test, browser global for the renderer.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { wordAtOffset };
} else {
  globalThis.WordAtOffset = { wordAtOffset };
}
```

**Step 4: Run to verify pass**

Run: `npx node --test test/unit/word-at-offset.test.js`
Expected: PASS.

**Step 5: Add the script tag**

In `src/renderer/index.html`, after the `reading-cursor.js` / `player.js` lines and before `app.js`:

```html
    <script src="word-at-offset.js"></script>
```

**Step 6: Commit**

```bash
git add src/renderer/word-at-offset.js test/unit/word-at-offset.test.js src/renderer/index.html
git commit -m "feat(renderer): wordAtOffset pure helper + wire script"
```

---

## Task 4: Renderer state + settings wiring

**Files:**
- Modify: `src/renderer/app.js` (state, `synthOpts`, `gatherSettings`, `applySettings`)

No new tests here (pure wiring; proven by the Task 6 smoke persistence + artifact checks). Each step is a small edit; run `npm test` at the end to confirm no regression.

**Step 1: Add state field**

In the `state` object (near line 50, after `voiceEngineDir: null,`), add:

```js
  // Global "sounds-like" pronunciation overrides { lowercasedWord: respelling }. Applied at synth
  // time in main (display text unchanged). Persisted in settings.json.
  pronunciations: {},
```

**Step 2: Thread the map into every synth call**

In `synthOpts()` (line ~79), add `pronunciations: state.pronunciations` to BOTH returned objects:

```js
function synthOpts() {
  if (state.ttsEngine === 'expressive') {
    return {
      voice: state.voice,
      speed: state.speed,
      engine: 'expressive',
      expressiveVoice: state.expressiveVoice,
      expressiveVoiceMode: state.expressiveVoiceMode,
      exaggeration: state.exaggeration,
      cfgWeight: state.cfgWeight,
      temperature: state.temperature,
      speedFactor: state.speedFactor,
      pronunciations: state.pronunciations,
    };
  }
  return { voice: state.voice, speed: state.speed, pronunciations: state.pronunciations };
}
```

**Step 3: Persist it**

In `gatherSettings()` (line ~1101), add to the returned object:

```js
    pronunciations: state.pronunciations,
```

**Step 4: Restore it on boot**

In `applySettings(s)` (line ~1135), add alongside the other direct, side-effect-free restores (e.g. after the `voiceEngineDir` block, before `buildExpressiveVoiceList()`):

```js
  if (s.pronunciations && typeof s.pronunciations === 'object') {
    state.pronunciations = s.pronunciations;
  }
```

Follow the existing boot rule: set state directly, do NOT call `saveSettings()`/`reload()` here.

**Step 5: Verify**

Run: `npm test`
Expected: 145 passing.

**Step 6: Commit**

```bash
git add src/renderer/app.js
git commit -m "feat(renderer): thread pronunciations through synth opts + settings"
```

---

## Task 5: Right-click "Sounds like…" popover

**Files:**
- Modify: `src/renderer/app.js` (caret helper, contextmenu handler, popover, save/remove, test seam, outside-click close)
- Modify: `src/renderer/styles.css` (popover styles)

**Step 1: Prove the caret API resolves (fail-fast, 2 minutes)**

Before building anything, launch the app (`npm start` — note: this dev shell needs `ELECTRON_RUN_AS_NODE` cleared; use the Bash tool: `env -u ELECTRON_RUN_AS_NODE npm start`), open a book, and in the DevTools console run:

```js
document.caretPositionFromPoint ? 'position' : (document.caretRangeFromPoint ? 'range' : 'NEITHER')
```

Expected on Electron 33/Chromium 130: `'position'`. If `'NEITHER'`, stop and revisit — the whole popover rests on this. (The helper below supports both regardless.)

**Step 2: Add the caret helper + save/remove + test seam**

Add near the other apply-change helpers (after `setSpeedFactor`, ~line 1421). `savePronunciation` mirrors `setVoice`'s reload+save pattern:

```js
// --- Pronunciation overrides (right-click a word -> "sounds like…") -----------
// Resolve the text node + char offset under a viewport point, across Chromium versions: the
// standard caretPositionFromPoint (Blink >= Chrome 126 / Electron 33) or the older
// caretRangeFromPoint. Returns { node, offset } for a TEXT node, else null.
function caretNodeAt(x, y) {
  let node = null;
  let offset = 0;
  if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    if (pos) { node = pos.offsetNode; offset = pos.offset; }
  } else if (document.caretRangeFromPoint) {
    const range = document.caretRangeFromPoint(x, y);
    if (range) { node = range.startContainer; offset = range.startOffset; }
  }
  if (!node || node.nodeType !== Node.TEXT_NODE) return null;
  return { node, offset };
}

function savePronunciation(word, respelling) {
  const key = (word || '').toLowerCase().trim();
  if (!key) return;
  const value = (respelling || '').trim();
  if (value) state.pronunciations[key] = value;
  else delete state.pronunciations[key]; // empty respelling = removal
  saveSettings();
  if (state.player) state.player.reload(); // re-synth the current sentence with the fix
}
function removePronunciation(word) {
  delete state.pronunciations[(word || '').toLowerCase()];
  saveSettings();
  if (state.player) state.player.reload();
}
// Test-only seam (mirrors window.__test_setEngine): drive a save without the native
// right-click/caret gesture, which Playwright can't synthesize deterministically headless.
window.__test_setPronunciation = (word, respelling) => savePronunciation(word, respelling);
```

**Step 3: Add the popover**

```js
let pronouncePopoverEl = null;
function closePronouncePopover() {
  if (pronouncePopoverEl) { pronouncePopoverEl.remove(); pronouncePopoverEl = null; }
}
function openPronouncePopover(word, x, y) {
  closePronouncePopover();
  const key = word.toLowerCase();
  const existing = state.pronunciations[key] || '';
  const wrap = document.createElement('div');
  wrap.className = 'pronounce-popover';
  wrap.innerHTML = `
    <p class="pronounce-title">Sounds like…</p>
    <p class="pronounce-word"></p>
    <input type="text" class="pronounce-input" placeholder="how it should sound" maxlength="80" />
    <div class="pronounce-actions">
      <button type="button" class="pronounce-save">Save</button>
      ${existing ? '<button type="button" class="pronounce-remove">Remove</button>' : ''}
      <button type="button" class="pronounce-cancel">Cancel</button>
    </div>
  `;
  // Set the book word via textContent (never innerHTML) — book text must not inject markup.
  wrap.querySelector('.pronounce-word').textContent = word;
  const input = wrap.querySelector('.pronounce-input');
  input.value = existing;
  const save = () => { savePronunciation(key, input.value); closePronouncePopover(); };
  wrap.querySelector('.pronounce-save').addEventListener('click', save);
  wrap.querySelector('.pronounce-cancel').addEventListener('click', closePronouncePopover);
  const removeBtn = wrap.querySelector('.pronounce-remove');
  if (removeBtn) removeBtn.addEventListener('click', () => { removePronunciation(key); closePronouncePopover(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') save();
    else if (e.key === 'Escape') closePronouncePopover();
  });
  document.body.appendChild(wrap);
  pronouncePopoverEl = wrap;
  // Position near the click, clamped inside the viewport.
  const r = wrap.getBoundingClientRect();
  wrap.style.left = `${Math.max(12, Math.min(x, window.innerWidth - r.width - 12))}px`;
  wrap.style.top = `${Math.max(12, Math.min(y, window.innerHeight - r.height - 12))}px`;
  input.focus();
}

readingEl.addEventListener('contextmenu', (e) => {
  e.preventDefault(); // own the gesture; suppress any default menu
  const caret = caretNodeAt(e.clientX, e.clientY);
  if (!caret) { closePronouncePopover(); return; }
  const found = window.WordAtOffset.wordAtOffset(caret.node.textContent, caret.offset);
  if (!found) { closePronouncePopover(); return; }
  openPronouncePopover(found.word, e.clientX, e.clientY);
});

// Outside-click closes the pronounce popover (its own buttons are guarded).
document.addEventListener('click', (e) => {
  if (pronouncePopoverEl && !e.target.closest('.pronounce-popover')) closePronouncePopover();
});
```

**Step 4: Add CSS**

In `src/renderer/styles.css`, add (mirroring `.add-voice-popover`'s look; adjust to match the file's tokens):

```css
.pronounce-popover {
  position: fixed;
  z-index: 60;
  min-width: 220px;
  padding: 12px;
  border-radius: 10px;
  background: var(--panel-bg, #fff);
  color: var(--fg, #111);
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.25);
  border: 1px solid var(--panel-border, rgba(0, 0, 0, 0.12));
  font-size: 0.9rem;
}
.pronounce-title { margin: 0 0 2px; opacity: 0.7; font-size: 0.8rem; }
.pronounce-word { margin: 0 0 8px; font-weight: 600; }
.pronounce-input { width: 100%; box-sizing: border-box; padding: 6px 8px; margin-bottom: 8px; }
.pronounce-actions { display: flex; gap: 6px; }
.pronounce-actions button { padding: 4px 10px; cursor: pointer; }
```

(Use the actual color variables already defined in `styles.css` — grep for what `.add-voice-popover` uses and match, so light/dark both work.)

**Step 5: Manual check**

Launch (`env -u ELECTRON_RUN_AS_NODE npm start`), open a book, press Play, right-click a word → popover appears with that word → type a respelling → Save → the current sentence re-reads with the fix. Left-click still starts reading. Right-click whitespace → no popover.

**Step 6: Commit**

```bash
git add src/renderer/app.js src/renderer/styles.css
git commit -m "feat(ui): right-click 'sounds like' popover for pronunciation overrides"
```

---

## Task 6: Smoke coverage

**Files:**
- Modify: `test/smoke/launch.smoke.js`

Add requires at the top (next to `const { clipKey } = require('../../src/main/clip-cache');`):

```js
const { normalizeTTS } = require('../../src/main/tts-normalize');
const { applyPronunciations } = require('../../src/main/pronounce');
```

**Step 1: Add a pronunciation section after the book is open and a player exists** (after the existing voice/preview block, before the Library section ~line 359). Three assertions:

```js
  // --- Pronunciation overrides -------------------------------------------------
  // (a) Right-click a word (real Playwright right-click, near the span start so the caret lands
  //     on a letter, not a gap) -> the "sounds like…" popover appears with a detected word.
  await win.locator('#reading .sentence').first().click({ button: 'right', position: { x: 6, y: 8 } });
  await win.waitForSelector('.pronounce-popover', { timeout: 5000 });
  const detectedWord = (await win.locator('.pronounce-popover .pronounce-word').textContent()).trim();
  assert.ok(/^[\p{L}\p{N}'’]+$/u.test(detectedWord), `popover shows a word token; got "${detectedWord}"`);
  console.log('  ✓ right-click opened the pronunciation popover for:', detectedWord);

  // (b) Type a respelling + Save -> it persists to settings.json under the lowercased word.
  await win.fill('.pronounce-popover .pronounce-input', 'zzztest');
  await win.click('.pronounce-popover .pronounce-save');
  await win.waitForTimeout(600); // let the 250ms save debounce + write settle
  const settingsPath = path.join(USERDATA, 'settings.json');
  const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.strictEqual(saved.pronunciations[detectedWord.toLowerCase()], 'zzztest',
    'the saved respelling should be in settings.json');
  console.log('  ✓ respelling saved to settings.json');

  // (c) The map is APPLIED at synth time: synthesize a known sentence with a map and assert the
  //     on-disk clip is keyed on the RESPELLED+normalized text (proves renderer->IPC->apply->cache).
  const pText = 'Reading room.';
  const pMap = { reading: 'reeding' };
  const expectedClip = clipKey(normalizeTTS(applyPronunciations(pText, pMap)), 'af_heart', 1);
  assert.ok(!has(expectedClip), 'respelled clip should not exist yet');
  await win.evaluate(({ t, m }) => window.reader.synthesize(t, { voice: 'af_heart', speed: 1, pronunciations: m }), { t: pText, m: pMap });
  for (let i = 0; i < 120 && !has(expectedClip); i++) await win.waitForTimeout(500);
  assert.ok(has(expectedClip), `synth should write the respelled clip (${expectedClip})`);
  console.log('  ✓ pronunciation map applied at synth time (respelled clip on disk)');
```

Note: `has`, `clipsDir`, and `USERDATA` are already defined earlier in the smoke (the preview block). If the pronunciation section runs *before* that block, hoist `const clipsDir = path.join(USERDATA, 'clips'); const has = (f) => ...` up; otherwise reuse them.

**Step 2: Run the smoke**

Run: `npm run smoke`
Expected: `SMOKE OK`, exit 0, with the three new `✓` lines. All prior assertions still pass.

If the real right-click proves flaky headless (popover doesn't open because the caret landed on a gap), fall back to the seam for (a)/(b): `await win.evaluate(() => window.__test_setPronunciation('reading', 'reeding'))` then assert settings.json — and keep (c) as-is. Prefer the real right-click; use the seam only if needed.

**Step 3: Commit**

```bash
git add test/smoke/launch.smoke.js
git commit -m "test(smoke): pronunciation popover + persistence + synth-time application"
```

---

## Task 7: Full verification + package rebuild

**Files:** none (verification only)

**Step 1: Full unit suite**

Run: `npm test`
Expected: ~160 passing (145 baseline + Task 1 (8) + Task 3 (6)), 0 failing.

**Step 2: Smoke**

Run: `npm run smoke`
Expected: `SMOKE OK`.

**Step 3: Rebuild the installer** (the user runs the packaged `.exe`, never `npm start`)

Run: `npm run dist:win`
Expected: `dist/Reader-0.1.0-setup.exe` produced.

**Step 4: Package gate — offline synth still works**

Run: `node test/manual/verify-packaged.js`
Expected: a valid WAV (`201644 bytes @ 24000 Hz` or similar non-zero) — confirms the new require (`./pronounce`) resolves in the packaged asar and nothing broke the synth path.

**Step 5: Final commit (if any build metadata changed) + hand back to the planner/verifier gate**

```bash
git add -A
git commit -m "chore: rebuild installer with pronunciation overrides" # only if there are changes
```

Then request the Opus review gate (spec + quality) per the project convention before merge.

---

## Manual verification checklist (for the user, by ear/eye)

- Right-click a mispronounced word → popover appears with that word.
- Type a respelling, Save → the sentence re-reads correctly right away.
- The fix applies everywhere that word appears, in any book, and survives a quit+relaunch.
- Right-click a word you've already fixed → the popover pre-fills the current respelling; Remove clears it.
- The on-screen text is unchanged (only the narration changed).
- Works the same on the expressive GPU voice as on Kokoro.

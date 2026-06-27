# Phase 2.6 Plan — UI polish & heading reading

> **Run this with:** Claude **Sonnet 4.6, medium** is fine for items 1–4 (menu, popover split,
> SVG icons, circular play button). **Item 5 (heading reading) is the one with real logic + test
> churn** — touches `epub.js` and `render.js` and their unit tests; do it carefully and TDD-first.
> If you prefer one model for the whole plan, **Opus 4.8 high**.
>
> **STRICT — separation of duties (see [`../design.md`](../design.md) §10):**
> You are a **builder session. Execute this plan only.** Do **NOT** edit any planning document —
> not `HANDOFF.md`, not `design.md`, not this plan, not anything in `docs/`. `HOW-TO-RUN.md` is fine
> to edit. When you finish, **deliver a self-contained written report in chat** (what you built, how
> you verified each acceptance criterion with real output, anything partial, gotchas). The planning
> session verifies your report and is the **sole author** of `HANDOFF.md`.
>
> **Context:** [`2026-06-27-ui-polish-and-headings-design.md`](./2026-06-27-ui-polish-and-headings-design.md)
> (the decisions/why), [`../HANDOFF.md`](../HANDOFF.md), [`../design.md`](../design.md).
> Phases 1–2.5 are built & verified: 56 unit tests + a smoke test green; the book narrates with a
> moving highlight, offline. This phase is **UI cleanup + making the narrator read headings**. It
> must **not** regress narration, the per-sentence `.is-reading` DOM contract, pagination, or the
> voice/offline architecture.

---

## Goal

Five fixes the user asked for after running the Windows build:

1. Remove the Electron default menu bar (File/Edit/View/Window/Help).
2. Split the overcrowded comfort popover into **Comfort** ("Aa") and **Voice** buttons/panels.
3. Replace the emoji transport glyphs (the "blue" ⏮ / ⏸) with **inline SVG** icons.
4. Make the play button a clean **circle**.
5. **Read headings:** the narrator should speak chapter/section headings (e.g. "BARRY",
   "November 2, 2018"); no more duplicated, never-read chapter title.

---

## Hard constraints / invariants (do not violate)

- **The per-sentence DOM contract is sacred.** Every spoken unit is a
  `span.sentence[data-chapter][data-paragraph][data-sentence]`. Headings become headings that
  *contain* such spans — never plain text. The cursor/player/highlight/pagination address spans by
  those three indices; **do not change that addressing.**
- **No change to the voice/offline/CPU/utilityProcess architecture, the clip cache, or the player.**
  This phase is parser + renderer + DOM/CSS only.
- **Keep `setView()` CSS-only** and the chapter DOM identical across single/two/scroll — headings
  must survive a mode switch like any sentence span.
- **Don't regress:** all current unit tests stay green (adjust the ones that assert the *old* heading
  behavior), and `npm run smoke` stays green.
- **CSP unchanged.** Inline `<svg>` in our own `index.html` is fine (it's document markup, not
  fetched content, not injected book HTML). Do not loosen the CSP.

---

# TASK 1 — Remove the Electron default menu

**Files:** Modify `src/main/main.js`.

**Step 1:** add `Menu` to the electron import and clear the menu. Do it once, in `app.whenReady`
(before/at `createWindow`), so it applies on launch:
```js
const { app, BrowserWindow, ipcMain, dialog, utilityProcess, Menu } = require('electron');
// ...
Menu.setApplicationMenu(null); // calm reading UI — no File/Edit/View/Window/Help bar.
```
(If `app.whenReady().then(createWindow)` is the current shape, put the `setApplicationMenu(null)`
call right before `createWindow()`.) Leave a comment noting the macOS app-menu is revisited at the
mac build.

**Step 2: verify.** `env -u ELECTRON_RUN_AS_NODE npm start` → no menu bar; window still works; the
existing smoke still launches. Commit:
```bash
git commit -am "feat(ui): remove the default Electron menu bar"
```
Trailer on every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

# TASK 2 — Split the comfort popover into Comfort + Voice

**Files:** Modify `src/renderer/index.html`, `src/renderer/app.js`, `src/renderer/styles.css`.

**Step 1: markup.** In the top bar, add a **Voice** button next to the "Aa" settings button:
```html
<button type="button" id="voice-btn" aria-label="Voice settings" title="Voice settings">Voice</button>
```
Split the single `#settings-panel` into two sibling panels, **keeping every inner control's existing
`id` unchanged** (so app.js logic is untouched):
- `#comfort-panel` (was the top half): Font, Text size, Theme, Page width.
- `#voice-panel`: the Voice list (`#voice-list`), Reading speed (`#speed-range`/`#speed-label`),
  End-of-chapter pause (`#pause-toggle`).
Both start `hidden`. Give them a shared class (e.g. `class="popover"`) for styling/position.

**Step 2: toggles (app.js).** Replace the single `settings-btn` handler with two that are mutually
exclusive — opening one closes the other:
```js
const comfortPanel = document.getElementById('comfort-panel');
const voicePanel = document.getElementById('voice-panel');
function openOnly(panel) {
  for (const p of [comfortPanel, voicePanel]) p.hidden = (p !== panel) ? true : !p.hidden;
}
document.getElementById('settings-btn').addEventListener('click', () => openOnly(comfortPanel));
document.getElementById('voice-btn').addEventListener('click', () => openOnly(voicePanel));
// Esc closes whichever is open; an outside click closes too.
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { comfortPanel.hidden = true; voicePanel.hidden = true; } });
document.addEventListener('click', (e) => {
  if (e.target.closest('#comfort-panel,#voice-panel,#settings-btn,#voice-btn')) return;
  comfortPanel.hidden = true; voicePanel.hidden = true;
});
```
> Don't break the existing Esc handling for the TOC if there is any — check the current keydown
> handler and merge, don't clobber. The outside-click listener must not swallow clicks on the
> controls themselves (the `closest` guard above handles that).

**Step 3: styles.** Position the two popovers under their buttons (reuse the current
`#settings-panel` positioning rules, applied to `.popover` / both ids). Keep the calm look.

**Step 4: verify + commit.** `npm start`: "Aa" opens Comfort only; "Voice" opens Voice only; each
toggles closed; Esc/outside-click closes; the controls inside still work (font, theme, voice pick,
speed, pause). Commit:
```bash
git commit -am "feat(ui): split comfort popover into Comfort + Voice panels"
```

---

# TASK 3 — Inline SVG transport icons

**Files:** Modify `src/renderer/index.html`, `src/renderer/app.js`, `src/renderer/styles.css`.

Replace the glyph text inside **all** transport buttons with small inline `<svg>` icons, filled/
stroked with `currentColor` so they follow the theme. Buttons (current ids): `#back-para`,
`#back-sent`, `#play-pause`, `#fwd-sent`, `#prev-chapter`, `#prev-page`, `#next-page`,
`#next-chapter`.

**Step 1: icons in `index.html`.** Use simple, consistent 24×24 SVGs (e.g. `viewBox="0 0 24 24"`,
`fill="currentColor"`). Keep each button's existing `aria-label`/`title` (the icons are decorative —
add `aria-hidden="true"` on the `<svg>`). Suggested set: skip-to-start (back paragraph), back arrow
(back sentence), forward arrow (forward sentence), prev/next chapter (bar+triangle), chevrons
(prev/next page).

**Step 2: play/pause toggle.** `#play-pause` shows a **play triangle** when paused and **pause bars**
when playing. Put **both** SVGs inside the button and toggle with CSS:
```html
<button id="play-pause" class="play" aria-label="Play" title="Play / Pause (Space)">
  <svg class="icon-play" ...>…triangle…</svg>
  <svg class="icon-pause" ...>…two bars…</svg>
</button>
```
```css
#play-pause .icon-pause { display: none; }
#play-pause.is-playing .icon-play { display: none; }
#play-pause.is-playing .icon-pause { display: inline; }
```
Update `updatePlayButton()` (app.js) to toggle the class instead of setting `textContent`:
```js
function updatePlayButton() {
  const btn = document.getElementById('play-pause');
  const on = !!(state.player && state.player.isPlaying());
  btn.classList.toggle('is-playing', on);
  btn.setAttribute('aria-label', on ? 'Pause' : 'Play');
}
```
> Grep `updatePlayButton` and any other place that writes `▶`/`⏸`/`textContent` on `#play-pause`
> and remove the glyph writes. Keep the `.blur()` after click (the Space-double-fire guard) intact.

**Step 3: styles.** Size the SVGs (e.g. `#bottom-bar svg { width: 22px; height: 22px; }`); ensure
`color`/`currentColor` gives the right contrast on the accent-filled play button and the plain
buttons in both themes.

**Step 4: verify + commit.** `npm start`: no colored emoji anywhere on the control strip; play
shows a triangle, becomes two bars while reading, back to triangle on pause/end; all controls still
drive playback. Commit:
```bash
git commit -am "feat(ui): inline SVG transport icons (kills the colored emoji glyphs)"
```

---

# TASK 4 — Circular play button

**Files:** Modify `src/renderer/styles.css`.

`#play-pause` already sets `border-radius: 50%`, but the bottom-bar's `padding: 6px 12px` and
`min-width` skew it oval. Make it a fixed circle:
```css
#play-pause {
  width: 60px; height: 60px; min-width: 60px; padding: 0;
  border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  /* keep the accent background/color rules */
}
```
**Verify + commit.** Visually round at every text size / theme. Commit:
```bash
git commit -am "fix(ui): make the play button a clean circle"
```

---

# TASK 5 — Read headings (parser + renderer), TDD

**Files:**
- Modify: `src/parse/epub.js`, `src/renderer/render.js`, `src/renderer/styles.css`
- Test: `test/unit/epub.test.js`, `test/unit/render.test.js`

**The model:** a heading is a paragraph that carries a `heading` level. Chapter shape stays
`{ title, paragraphs: [ { heading?:number, sentences:[...] } ] }`. Cursor/player/pagination
unchanged.

**Step 1 (TDD) — renderer tests first (`render.test.js`).** Extend `DOC` and add assertions:
```js
// a chapter whose first paragraph is a heading:
{ title: 'Chapter One', paragraphs: [
  { heading: 2, sentences: ['Chapter One'] },
  { sentences: ['First sentence.', 'Second sentence.'] },
] }
```
- Assert the heading renders as `<h2 class="chapter-heading">` **containing** a
  `span.sentence[data-chapter][data-paragraph][data-sentence]` (addressable + narratable).
- Assert there is **no** `h2.chapter-title` injected from `chapter.title` anymore.
- Assert a heading's sentence span carries the correct indices (e.g. `0/0/0`) so the player can
  highlight it.
- Keep/extend the escaping + index-reset tests.
Update the existing `emits one section per chapter with the chapter title` test: it should now assert
the section/`data-chapter` wiring and the **absence** of the injected title, not `h2.chapter-title`.
Run `npm test` → the render tests FAIL.

**Step 2 — implement `render.js`.** Remove the `chapter.title` → `<h2 class="chapter-title">`
injection. In the paragraph loop, branch on `para.heading`:
```js
chapter.paragraphs.forEach((para, pi) => {
  const lvl = Math.min(6, Math.max(1, para.heading || 0));
  const tag = para.heading ? `h${lvl}` : 'p';
  const cls = para.heading ? 'chapter-heading' : 'para';
  out.push(`<${tag} class="${cls}" data-chapter="${ci}" data-paragraph="${pi}">`);
  para.sentences.forEach((sentence, si) => {
    out.push(`<span class="sentence" data-chapter="${ci}" data-paragraph="${pi}" data-sentence="${si}">${escapeHtml(sentence)}</span> `);
  });
  out.push(`</${tag}>`);
});
```
Run `npm test` → render tests PASS.

**Step 3 (TDD) — parser tests (`epub.test.js`).** Add cases (synthetic XHTML + a small `parseEpub`
fixture run if practical, or unit the assembly via `htmlToBlocks` + the chapter loop):
- A doc with a leading `<h1>BARRY</h1>` then `<p>` body → the chapter's **first paragraph is a
  heading** (`paragraphs[0].heading` set, its sentence is "BARRY"), i.e. the heading is **kept and
  read**, not skipped.
- A doc with **two** headings ("Chapter Two" / "Chapter Two") → both kept as heading paragraphs (no
  silent drop), and the chapter `title` metadata is still derived (TOC or first heading).
- A doc with **no heading** but a TOC title for its href → a **synthesized** leading heading
  paragraph (`paragraphs[0].heading === 2`, sentence === the title); the chapter `title` is that
  title.
- A doc with **no heading and no title** → no synthesized heading (front-matter is fine).
- `title` still equals `navTitles.get(href) || firstHeadingText || null` (metadata only).
Run `npm test` → new parser tests FAIL.

**Step 4 — implement `epub.js`.** In the `parseEpub` chapter loop, stop pulling/skipping the first
heading. Build paragraphs preserving headings, compute the metadata title, then synthesize a heading
only when the chapter has none of its own:
```js
const HEADING_LEVEL = { h1:1, h2:2, h3:3, h4:4, h5:5, h6:6 };
// ...
let firstHeadingText = null;
let hasOwnHeading = false;
const paragraphs = [];
for (const b of blocks) {
  const lvl = HEADING_LEVEL[b.tag];
  const sentences = splitSentences(b.text);
  if (sentences.length === 0) continue;
  if (lvl) {
    if (firstHeadingText === null) firstHeadingText = b.text;
    hasOwnHeading = true;
    paragraphs.push({ heading: lvl, sentences });
  } else {
    paragraphs.push({ sentences });
  }
}
if (paragraphs.length === 0) continue;

const title = navTitles.get(href) || firstHeadingText || null;
// Fallback (design option a): every chapter gets a visible+read heading. Only
// synthesize when the chapter has none of its own (no duplication).
if (!hasOwnHeading && title) {
  paragraphs.unshift({ heading: 2, sentences: splitSentences(title) });
}
chapters.push({ title, paragraphs });
```
Update the file's top-of-function comment (it currently says "The first heading … becomes the chapter
title; remaining blocks become paragraphs") to describe the new behavior. Run `npm test` → green.

**Step 5 — styles for `.chapter-heading`.** Repurpose/replace the old `.chapter-title` CSS with
`.chapter-heading` (size by level if you like: `h2.chapter-heading` largest, smaller for deeper
levels). Keep it calm and consistent with the reading view. Ensure the `.is-reading` highlight reads
well on a heading span (it should, since it's the same span class).

**Step 6 — sanity on a real book.** With `env -u ELECTRON_RUN_AS_NODE`, run the existing parse over
the user's books or a Gutenberg fixture and confirm headings now appear as headings and there's no
duplicated title. (A tiny throwaway node script that `parseEpub`s a fixture and prints the first
chapter's paragraphs with their `heading` flags is enough.)

**Step 7 — commit.**
```bash
git add src/parse/epub.js src/renderer/render.js src/renderer/styles.css test/unit/epub.test.js test/unit/render.test.js
git commit -m "feat(reader): read chapter/section headings; drop the duplicated unread title"
```

---

# TASK 6 — Smoke + manual checklist

**Files:** Modify `test/smoke/launch.smoke.js`, `HOW-TO-RUN.md`.

**Step 1 — extend the smoke** (use the existing helpers + long timeouts):
- Assert the **two popovers** are mutually exclusive: clicking "Aa" shows `#comfort-panel` and hides
  `#voice-panel`; clicking "Voice" flips it.
- Assert a **heading is an addressable, narratable span**: after a book renders, there is at least
  one `h2.chapter-heading span.sentence[data-chapter][data-paragraph][data-sentence]`, and that the
  narration highlight can land on it (you can assert the heading span exists and is part of the
  sentence sequence; keep the existing "highlight advances" assertion).
- Assert there is **no** `h2.chapter-title` element (old injected title) anywhere.
- (Optional) assert `#play-pause` gets `.is-playing` toggled when narration starts/stops.
Keep the Phase 2.5 voice/persist assertions working (the controls just moved into `#voice-panel`).

**Step 2 — manual checklist:** append a "Phase 2.6" section to `HOW-TO-RUN.md`:
- [ ] No menu bar at the top.
- [ ] "Aa" and "Voice" each open their own popover; opening one closes the other; Esc/outside closes.
- [ ] Transport icons are monochrome (no blue), theme-aware; play button is a clean circle and
      toggles play/pause shape.
- [ ] Headings (chapter titles, POV names like "BARRY", dates) are **read aloud** and highlighted; no
      duplicated chapter title on the page.

**Step 3 — verify.** `npm test` → all green. `npm run smoke` → PASS (long timeout). Commit:
```bash
git add test/smoke/launch.smoke.js HOW-TO-RUN.md
git commit -m "test(smoke): popover split + headings render as narratable spans"
```

---

## Acceptance criteria (this phase is done when…)

1. **No Electron menu bar** on launch.
2. **Two popovers** — Comfort ("Aa") and Voice — mutually exclusive, Esc/outside-click close; every
   control inside still works and still persists (Phase 2.5 intact).
3. **No colored-emoji transport icons** — all transport controls are theme-colored inline SVG; the
   play/pause shape toggles with state.
4. **Play button is a clean circle** at all text sizes / both themes.
5. **Headings are read aloud and highlighted**, rendered as `<hN class="chapter-heading">` containing
   sentence spans; **no duplicated, unread chapter title**; chapters with no own heading get the TOC
   title as a synthesized spoken heading; the chapter title still drives the Chapters panel + the
   "Chapter X of Y" strip.
6. **No regression:** the per-sentence `.is-reading` contract, pagination across all 3 view modes,
   the voice/offline/CPU/utilityProcess stack, and the clip cache are all intact; all unit tests +
   the smoke pass.

---

## Testing summary

- **Unit (`npm test`):** render emits headings as `<hN>` with addressable sentence spans and no
  injected `chapter-title`; parser keeps headings as `{heading,...}` paragraphs, derives the metadata
  title, and synthesizes a heading only when a chapter has none. All prior tests stay green (update
  the ones asserting the old title behavior).
- **Smoke (`npm run smoke`):** popover split is mutually exclusive; a heading is a narratable span;
  no `chapter-title`; Phase 2.5 voice/persist still pass.
- **Manual:** the Phase 2.6 checklist (menu gone, popovers, icon/play look, headings *sound* right).

---

## Out of scope (do NOT build)

- macOS build / a mac app-menu (Phase 1 carryover; revisit then).
- Anything in the **voice-latency spike** ([`spike-voice-latency.md`](./spike-voice-latency.md)) — no
  GPU, no warm-up/prefetch changes here. This phase ships no player/engine changes.
- The app name, Phase 3 (Library/auto-resume), Phase 4 (pronunciation, Markdown/DOCX).

---

## When finished

1. Confirm each acceptance criterion with a real check; note any partial.
2. **Do NOT edit `HANDOFF.md`/`design.md`/any planning doc** (HOW-TO-RUN.md is fine). Write a
   **report in chat**: what you built; per-criterion verification with output (test counts, smoke
   result, before/after notes on the heading behavior on a real book); any gotchas. The planning
   session verifies it and records `HANDOFF.md`.
3. Leave the per-sentence span contract and the voice/offline architecture untouched and obvious.

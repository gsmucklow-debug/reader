# Pronunciation Overrides (deterministic layer) — Design

**Date:** 2026-07-02
**Status:** Approved (brainstormed + validated with the user). Ready for a builder plan.

## Context

The narrator sometimes mispronounces words, and the engines (Kokoro, and the expressive
Chatterbox GPU voice) take plain text — no phoneme/SSML control. The only lever is changing
the text the engine *hears* while leaving the on-screen text untouched. The code already
separates display-text from synth-text at synthesis time (`tts-normalize.js`, applied in the
`synthesize` handler), so a "sounds-like respelling" map slots in cleanly.

This is the **first, deterministic half** of the long-planned pronunciation/expression work.
The ambitious LLM pipeline (context-aware heteronym disambiguation + per-sentence expression
intensity) is a **separate, later phase**; this layer is both immediately useful on its own and
the fallback/override layer the LLM output will eventually feed into. Scoping it first
deliberately de-risks the big unknown.

### What this layer is for (and is not)

The map handles words with **one** correct pronunciation the engine always gets wrong:
- `reading → reeding` (the verb is always "reeding"; the model reaching for the UK town "Redding" is the bug)
- `GIF → jiff`, names, invented terms.

It deliberately does **not** try to handle true **heteronyms** like "read" (reed vs red) or
"lead" (leed vs led), whose pronunciation depends on sentence context — forcing one spelling
everywhere would be wrong half the time. Those wait for the LLM phase.

## Decisions

1. **Scope this plan to the deterministic layers first** (de-risk the LLM unknown).
2. **Global map only** for v1. One `settings.json` map applies everywhere, every book. Per-book
   overrides are deferred to the LLM phase (which is inherently per-book anyway).
3. **Right-click a word in the reader** to add/edit a fix (fully in-app; no-terminal is a hard
   constraint). Left-click is unchanged (starts reading there).

## Architecture & data flow

One pure function, `applyPronunciations(text, map)`, runs in `main.js`'s `synthesize` handler
**immediately before `normalizeTTS`** — the exact seam that already keeps synth-text separate
from display-text (`main.js` ~line 247). The final processed string is what the clip cache keys
on. Consequences, all free:

- **Display text stays pristine** — the renderer sends the real sentence; substitution happens
  in main.
- **Adding/changing a fix makes old clips cold-miss and re-synthesize correctly** — no cache
  invalidation code needed (the clip cache already keys on the final processed text). Same trick
  the TTS-normalize change relied on.
- **Engine-agnostic** — applied in the shared handler before both the Kokoro and expressive
  branches read the text, so it works for both voices with zero per-engine code.

Flow:
1. Renderer holds the map in `state.pronunciations` (loaded from `settings.json`, persisted via
   the existing `saveSettings`).
2. Each `synthesize` IPC call carries the map in its payload (tiny — a handful of entries;
   per-call keeps it stateless, no main-side cache to go stale).
3. Main runs `applyPronunciations` → `normalizeTTS` → cache-key → synth.

## The right-click UX & word detection

The reader DOM wraps *sentences*, not words (the sacred highlight contract — untouched). Word
detection happens at click time via the caret API:

1. **Right-click** (`contextmenu`) in the reading text.
2. `document.caretPositionFromPoint(x, y)` gives the text node + offset under the cursor.
3. A pure helper `wordAtOffset(text, index)` → `{ word, start, end }` expands to word boundaries
   (unit-testable, no DOM).
4. A small **"Sounds like…" popup** near the click:
   - shows the word (e.g. **reading**),
   - a text input pre-filled with the current respelling if one exists,
   - **Save**, and **Remove** if a fix already exists,
   - Esc / outside-click closes (reuses the existing popover-dismiss pattern).

**On Save:** store lowercased-key → respelling in `state.pronunciations`, persist via
`saveSettings`, and call `player.reload()` so the **current sentence re-synthesizes
immediately** (same mechanism a voice change uses — you hear the fix right away).

**What you type:** free-text, verbatim, "sound it out" (`reading→reeding`, `GIF→jiff`,
`Hermione→her-my-oh-nee`). Substituted as-is; iterate by ear. No phoneme syntax.

**Right-click on empty space / non-word** (whitespace, gaps): no popup.

## Matching semantics (`applyPronunciations`)

- **Case-insensitive match, all occurrences.** A fix for "reading" matches "reading",
  "Reading", "READING" everywhere in the sentence. Keys stored lowercased.
- **Whole-word only, Unicode-aware boundaries.** Match "read" but never inside "already" or
  "bread". JS `\b` is ASCII-only and prose has apostrophes/accents, so boundaries are checked
  against non-letter neighbors rather than naïve `\b`. Single-pass so one respelling can't be
  re-matched by another.
- **Respelling inserted verbatim** — exactly as typed, no case-copying from the original.
- **Order: pronunciations first, then `normalizeTTS`.** The explicit respelling wins; then the
  existing `#4`→"number 4" / all-caps handling runs on the result. A word given a fix is exempt
  from all-caps lowercasing (it's already the chosen spelling).
- **Punctuation stays put** — only the word token is replaced; surrounding commas/quotes/periods
  are untouched, preserving prosody and the sentence boundary the splitter already found.
- **Empty respelling = no-op / removal**, never an empty string to the engine.

## Storage, settings & wiring

One new key in `settings.json`:
```json
"pronunciations": { "reading": "reeding", "gif": "jiff" }
```
Flat object, lowercased keys. Joins the existing global settings the renderer already loads/saves.

Settings plumbing (follows the Phase 2.5 pattern):
- `applySettings()` reads `pronunciations` into `state.pronunciations` on boot — **directly,
  side-effect-free** (no `reload()`/`saveSettings` during boot, per the existing gotcha).
- Save/Remove mutate `state.pronunciations` then `saveSettings()` + `player.reload()`.
- Backward-compatible: settings.json without the key → empty map.

IPC: the `synthesize` payload gains one field, `pronunciations`. Preload already spreads the
opts object, so the bridge widens by data only — no new channel (mirrors how `speed` and the
expressive params were added). Main destructures it, defaults to `{}`.

Cache: **no key change.** Respelling happens before the key is computed, so "reading" and
"reeding" naturally produce different keys — different clips, no collisions, no stale serves.

## Testing (TDD, `node:test` + Playwright-Electron)

- **`applyPronunciations` unit tests** — the bug-prone core: case-insensitive match,
  all-occurrences, whole-word boundaries (not inside "already"/"bread"), Unicode/apostrophe
  neighbors, verbatim insert (no case-copy), order-vs-normalizeTTS, empty-respelling no-op,
  empty-map passthrough.
- **`wordAtOffset` unit tests** — expand-to-word at mid-word / start / end / whitespace offsets.
- **Smoke (real engine):** via a small test seam (mirroring `window.__test_setEngine`) — set a
  pronunciation, trigger synth, assert the on-disk clip for the **respelled** text exists (proves
  renderer → IPC → apply → cache key → synth), since the right-click popup + native
  word-detection can't be Playwright-driven directly.
- Existing 145 tests stay green (no cache-key change, no DOM-contract change).

## Verification

Rebuild `dist/Reader-0.1.0-setup.exe` (NSIS) so the user gets it as a double-click — every
change ships as a rebuilt `.exe`, never "run npm start." Package gate: offline synth still
returns valid WAV.

## Out of scope (deferred to the LLM phase)

- Context-dependent **heteronyms** ("read" reed/red) — needs the LLM.
- **Per-book** overrides and character-name maps.
- **Expression** (per-sentence `exaggeration` modulation) — the LLM half.
- Import/export of the map; bulk-editing UI (right-click add + Remove is the whole v1 UX).

# Voice Variety — Design (validated)

> Brainstormed + validated with the user 2026-06-28. Small, self-contained follow-up
> (not a numbered phase). Data + a little CSS only.

## Goal

The current voice picker offers **8 curated English voices**. The user finds them fine but
wants **more variety / different timbres**. Expand the picker to a **generous ~22 English
(US + UK) voices**, keeping the calm-UI feel via grouping, best-first ordering, and a ★ mark
on the standouts.

## Why this is cheap

- **All 54 Kokoro voices already ship bundled** (`node_modules/kokoro-js/voices/*.bin`, loaded
  via `fs`) — no extra download, no fetch, no bundle-size change.
- The whole stack is **already per-voice**: `clipKey(text, voice, speed)` caches each voice
  independently, the ▶ preview synthesizes any id, `setVoice`/`markActiveVoice` and the
  persisted `state.voice` are id-driven. Adding a voice = adding a `{id, label}` row.
- **No engine, IPC, cache, persistence, or reader changes.** Just the `VOICES` array in
  `src/renderer/app.js` and a small CSS rule.

## Scope decisions (locked with the user)

- **English only.** Kokoro's non-English voices (Spanish/French/Italian/Hindi/Japanese/
  Mandarin/Brazilian-Portuguese) are trained to speak *their own* language and mispronounce
  English book text — out of scope for an English reader.
- **Generous tier (~22):** keep every English voice graded **C− or better**; exclude only the
  D/F-grade ones (`am_echo`, `am_eric`, `am_liam`, `am_onyx`, `am_santa`, `am_adam`).
- **4 groups, best-first** (was 2 accent groups): US Female / US Male / UK Female / UK Male.
- **★ on the standouts** (A/B grade) so the best surface in a longer list — a visual cue only.
- **Default unchanged:** `af_heart`. A user who never opens the picker sees no change.

## The voice list

Ordered best-first within each group; ★ = standout (Kokoro grade A or B). Grades are from
Kokoro's official `VOICES.md` (approximate; every voice is auditionable via ▶ preview, so the
exact letter is guidance, not gospel).

- **US Female (11):** ★ Heart (A), ★ Bella (A−), ★ Nicole (B−), Aoede (C+), Kore (C+),
  Sarah (C+), Nova (C), Alloy (C), Jessica (C), River (C), Sky (C−)
- **US Male (3):** Michael (C+), Fenrir (C+), Puck (C+) — *the entire usable US-male pool;
  Kokoro has no good US male below C+ (an inherent model limit, recorded honestly).*
- **UK Female (4):** ★ Emma (B−), Isabella (C), Alice (C), Lily (C)
- **UK Male (4):** George (C), Fable (C), Lewis (C+), Daniel (C)

> ★ set = `af_heart`, `af_bella`, `af_nicole`, `bf_emma`.

## Implementation

1. **`VOICES` (`src/renderer/app.js`)** — replace the 2-group array with the 4-group list above,
   each `{ id, label }` row in best-first order. Add a `top: true` flag (or similar) to the four
   ★ rows. `buildVoiceList()` already iterates groups → items; extend it to render the group
   label and, for `top` rows, a ★ before the name (no change to `data-voice` / selection).
2. **CSS (`src/renderer/styles.css`)** — add `max-height: ~50vh; overflow-y: auto;` to
   `.voice-list` (line ~126) so 22 rows scroll inside the popover instead of overflowing the
   viewport. Keep the existing `.voice-group` header styling.
3. **No other code.** Preview, active-marking, persistence, cache keys, and the `tts-service`
   engine are untouched.

## Testing

- **Unit:** a tiny check that every curated id in `VOICES` exists as a `*.bin` in
  `node_modules/kokoro-js/voices/` (catches a typo'd id silently falling back). Pure, no engine.
- **Smoke:** the existing voice-switch + ▶-preview assertions already exercise the real engine
  per-voice; no new smoke logic needed (optionally point the switch at a newly-added id).
- **Ears-only (user):** which of the new C-grade voices actually sound good is a listen-pass —
  the ★s + ordering + preview are the affordances for that.

## Out of scope

Non-English voices; per-book voice memory (still a deferred Phase 3/4 item); showing the full
grade on every label (rejected — exposing "C" looks off-putting; ★-on-standouts chosen instead);
custom/user-imported voices.

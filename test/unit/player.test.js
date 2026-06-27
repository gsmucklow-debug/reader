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

// Captures every PLAYED clip and, unlike fakeDeps, its stop() does NOT clear the
// ended callback — mirroring real Web Audio, where stop() fires onended. This lets
// us fire a STALE clip's end after a seek while playback is still going, isolating
// the `my !== token` half of the guard (the `!playing` half can't catch it here).
function captureDeps() {
  const shown = [];
  const played = []; // one entry per clip that had .play() called, with fireEnded()
  const deps = {
    doc,
    synth: async () => ({ wav: new Uint8Array(1), sampleRate: 24000 }),
    makeClip: async () => {
      let ended = null;
      return {
        play: (onEnded) => { ended = onEnded; played.push({ fireEnded: () => ended && ended() }); },
        stop: () => { /* deliberately keep `ended` — real stop() fires onended */ },
      };
    },
    view: { show: (a) => shown.push(`${a.ci}.${a.pi}.${a.si}`) },
  };
  return { deps, shown, played };
}

test('stale clip-end after seek does not advance past the seek target (pins token guard)', async () => {
  const { deps, shown, played } = captureDeps();
  const p = createPlayer({ ...deps, prefetchAhead: 0 });
  await p.play(); await tick();             // 0.0.0 active (played[0]), still playing
  await p.forwardSentence(); await tick();  // seek → 0.0.1 (played[1]), still playing
  played[0].fireEnded(); await tick();      // stale end from the PRE-seek clip
  assert.strictEqual(shown[shown.length - 1], '0.0.1'); // must NOT advance to 0.1.0
  assert.strictEqual(p.isPlaying(), true);
  // (Deleting the `my !== token` clause in onEnded makes this fail — that's the pin.)
});

test('onStateChange fires when the book reaches its end and playback stops', async () => {
  const { deps, endCurrent } = fakeDeps();
  const states = []; // every `playing` transition the player reports
  const p = createPlayer({ ...deps, onStateChange: (v) => states.push(v) });
  await p.play(); await tick();
  assert.deepStrictEqual(states, [true]); // started playing
  for (let i = 0; i < 4; i++) { endCurrent(); await tick(); } // roll to the last sentence's end
  assert.strictEqual(p.isPlaying(), false);
  assert.strictEqual(states[states.length - 1], false); // auto-stop at book end notified the UI
  assert.deepStrictEqual(states, [true, false]);
});

const tick = () => new Promise((r) => setTimeout(r, 0));

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
  const onStateChange = deps.onStateChange || (() => {}); // optional: notify UI when `playing` flips

  let addr = null;            // current sentence address
  let playing = false;
  let activeClip = null;
  let token = 0;             // invalidates in-flight async work on pause/seek
  const clips = new Map();   // key -> Promise<{ play, stop }>

  function clipFor(a) {
    const k = Cursor.key(a);
    if (!clips.has(k)) {
      const promise = synth(Cursor.textAt(doc, a)).then((r) => makeClip(r.wav, r.sampleRate));
      promise.catch(() => clips.delete(k)); // swallow prefetch rejection; evict poison so retry works
      clips.set(k, promise);
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
    if (!next) { setPlaying(false); activeClip = null; return; } // end of book
    addr = next;
    playCurrent();
  }

  // Flip `playing` and notify the UI only on an actual transition, so #play-pause
  // always reflects state (e.g. it auto-stops at book end in onEnded).
  function setPlaying(v) {
    if (playing === v) return;
    playing = v;
    onStateChange(v);
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
    setPlaying(true);
    await playCurrent();
  }

  function pause() { setPlaying(false); stopInternal(); }

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
    jumpTo: (a) => { setPlaying(true); return seekTo(a); }, // clicking a sentence starts playback there
    isPlaying: () => playing,
    current: () => addr,
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { createPlayer };
else globalThis.ReaderPlayer = { createPlayer };

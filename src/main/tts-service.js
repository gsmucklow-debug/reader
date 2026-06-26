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
    // app the path is supplied via the READER_MODELS_DIR env var (set when the
    // parent forks this utilityProcess, resolved from process.resourcesPath).
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
  // Don't cache a rejected promise forever: a transient load failure would
  // otherwise brick the long-lived engine. Reset so a later request retries.
  ttsPromise.catch(() => { ttsPromise = null; });
  return ttsPromise;
}

// RawAudio → 16-bit PCM WAV bytes. kokoro-js exposes audio.toWav()/toBlob(); use
// toWav() if present, else build the header from audio.audio (Float32) + sampling_rate.
// (kokoro-js 1.2.x always provides toWav(); the encodeWav fallback is an untested
// defensive path that only fires if a future version drops the method.)
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
// The WAV rides back inside the message body (msg.wav). Electron's utilityProcess
// channel uses structured clone, which COPIES the typed array — we deliberately do
// NOT pass a transfer list (that is renderer MessagePort semantics, and it would
// strip `wav` from the body, leaving the parent with `undefined`).
process.parentPort.on('message', async (e) => {
  // The parent keys pending requests by id and only ever resolves on a reply, so
  // EVERY message with an id must get exactly one reply — including unknown types —
  // or that request hangs forever. Drop only un-replyable (id-less) messages.
  const msg = e && e.data;
  if (!msg || typeof msg.id === 'undefined') return;
  if (msg.type === 'synthesize') {
    try {
      const { wav, sampleRate } = await synthesize(msg);
      process.parentPort.postMessage({ id: msg.id, ok: true, sampleRate, wav });
    } catch (err) {
      process.parentPort.postMessage({ id: msg.id, ok: false, error: errInfo(err) });
    }
  } else if (msg.type === 'ping') {
    try { await getTTS(); process.parentPort.postMessage({ id: msg.id, ok: true }); }
    catch (err) { process.parentPort.postMessage({ id: msg.id, ok: false, error: errInfo(err) }); }
  } else {
    process.parentPort.postMessage({ id: msg.id, ok: false, error: `unknown message type: ${msg.type}` });
  }
});

// Preserve the stack when available — invaluable the first time an offline load
// fails in the packaged exe, where there's no console to inspect.
function errInfo(err) {
  return err && err.stack ? err.stack : String(err);
}

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

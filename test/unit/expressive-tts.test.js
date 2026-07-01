'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { synthesizeRemote, wavSampleRate } = require('../../src/main/expressive-tts');

// A minimal valid WAV header (44 bytes) with a given sample rate, for the fake server.
function fakeWav(sampleRate) {
  const b = new Uint8Array(44);
  b.set([0x52, 0x49, 0x46, 0x46]); // "RIFF"
  b[24] = sampleRate & 0xff;
  b[25] = (sampleRate >> 8) & 0xff;
  b[26] = (sampleRate >> 16) & 0xff;
  b[27] = (sampleRate >> 24) & 0xff;
  return b;
}

test('synthesizeRemote POSTs the sentence to /tts in predefined-voice mode', async () => {
  let seenUrl, seenBody;
  const fetchImpl = async (url, opts) => {
    seenUrl = url;
    seenBody = JSON.parse(opts.body);
    return { ok: true, async arrayBuffer() { return fakeWav(24000).buffer; } };
  };
  const { wav, sampleRate } = await synthesizeRemote({
    text: 'Hello there.', voice: 'Abigail.wav', url: 'http://localhost:8004/', fetchImpl,
  });
  assert.strictEqual(seenUrl, 'http://localhost:8004/tts');       // trailing slash trimmed
  assert.strictEqual(seenBody.text, 'Hello there.');
  assert.strictEqual(seenBody.voice_mode, 'predefined');
  assert.strictEqual(seenBody.predefined_voice_id, 'Abigail.wav');
  assert.strictEqual(seenBody.split_text, false);                 // Reader sends one sentence
  assert.strictEqual(seenBody.stream, false);                     // whole-clip invariant
  assert.ok(wav instanceof Uint8Array && wav.length === 44);
  assert.strictEqual(sampleRate, 24000);
});

test('synthesizeRemote throws on a non-ok response (so the caller can fall back to Kokoro)', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, async text() { return 'CUDA OOM'; } });
  await assert.rejects(
    () => synthesizeRemote({ text: 'x', url: 'http://localhost:8004', fetchImpl }),
    /expressive TTS 500: CUDA OOM/,
  );
});

test('wavSampleRate reads the header rate, defaults to 24000 on garbage', () => {
  assert.strictEqual(wavSampleRate(fakeWav(48000)), 48000);
  assert.strictEqual(wavSampleRate(new Uint8Array([1, 2, 3])), 24000); // not a RIFF header
});

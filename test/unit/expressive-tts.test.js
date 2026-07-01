'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { synthesizeRemote, wavSampleRate, parseReferenceList, expressiveCacheVoice } = require('../../src/main/expressive-tts');

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

test('synthesizeRemote sends only the generation params that were provided', async () => {
  let body;
  const fetchImpl = async (_url, opts) => {
    body = JSON.parse(opts.body);
    return { ok: true, async arrayBuffer() { return fakeWav(24000).buffer; } };
  };
  await synthesizeRemote({
    text: 'x', url: 'http://localhost:8004', fetchImpl,
    params: { exaggeration: 0.5, cfgWeight: 0.3, temperature: 0.75, speedFactor: 1.0 },
  });
  assert.strictEqual(body.exaggeration, 0.5);
  assert.strictEqual(body.cfg_weight, 0.3);   // mapped to the server's snake_case name
  assert.strictEqual(body.temperature, 0.75);
  assert.strictEqual(body.speed_factor, 1.0);

  // Omitted params must NOT appear (server keeps its own config.yaml defaults).
  await synthesizeRemote({ text: 'x', url: 'http://localhost:8004', fetchImpl, params: { cfgWeight: 0.4 } });
  assert.strictEqual(body.cfg_weight, 0.4);
  assert.ok(!('exaggeration' in body));
  assert.ok(!('temperature' in body));
});

test('synthesizeRemote throws on a non-ok response (so the caller can fall back to Kokoro)', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, async text() { return 'CUDA OOM'; } });
  await assert.rejects(
    () => synthesizeRemote({ text: 'x', url: 'http://localhost:8004', fetchImpl }),
    /expressive TTS 500: CUDA OOM/,
  );
});

test('synthesizeRemote defaults to predefined mode when mode is omitted', async () => {
  let body;
  const fetchImpl = async (_url, opts) => {
    body = JSON.parse(opts.body);
    return { ok: true, async arrayBuffer() { return fakeWav(24000).buffer; } };
  };
  await synthesizeRemote({ text: 'x', voice: 'Axel.wav', url: 'http://localhost:8004', fetchImpl });
  assert.strictEqual(body.voice_mode, 'predefined');
  assert.strictEqual(body.predefined_voice_id, 'Axel.wav');
  assert.ok(!('reference_audio_filename' in body));
});

test('synthesizeRemote sends clone-mode body with reference_audio_filename, no predefined_voice_id', async () => {
  let body;
  const fetchImpl = async (_url, opts) => {
    body = JSON.parse(opts.body);
    return { ok: true, async arrayBuffer() { return fakeWav(24000).buffer; } };
  };
  await synthesizeRemote({
    text: 'Hello there.', voice: 'my-voice.wav', mode: 'clone',
    url: 'http://localhost:8004', fetchImpl,
  });
  assert.strictEqual(body.text, 'Hello there.');
  assert.strictEqual(body.voice_mode, 'clone');
  assert.strictEqual(body.reference_audio_filename, 'my-voice.wav');
  assert.ok(!('predefined_voice_id' in body));
  assert.strictEqual(body.split_text, false);
  assert.strictEqual(body.stream, false);
});

test('synthesizeRemote clone mode still sends only the provided generation params', async () => {
  let body;
  const fetchImpl = async (_url, opts) => {
    body = JSON.parse(opts.body);
    return { ok: true, async arrayBuffer() { return fakeWav(24000).buffer; } };
  };
  await synthesizeRemote({
    text: 'x', voice: 'cloned.wav', mode: 'clone', url: 'http://localhost:8004', fetchImpl,
    params: { cfgWeight: 0.4 },
  });
  assert.strictEqual(body.cfg_weight, 0.4);
  assert.ok(!('exaggeration' in body));
});

test('wavSampleRate reads the header rate, defaults to 24000 on garbage', () => {
  assert.strictEqual(wavSampleRate(fakeWav(48000)), 48000);
  assert.strictEqual(wavSampleRate(new Uint8Array([1, 2, 3])), 24000); // not a RIFF header
});

test('parseReferenceList accepts a bare array of filename strings', () => {
  assert.deepStrictEqual(parseReferenceList(['gary.wav', 'draft-voice.mp3']), ['gary.wav', 'draft-voice.mp3']);
});

test('parseReferenceList accepts an array of objects with filename/name/file keys', () => {
  assert.deepStrictEqual(
    parseReferenceList([{ filename: 'a.wav' }, { name: 'b.wav' }, { file: 'c.wav' }]),
    ['a.wav', 'b.wav', 'c.wav'],
  );
});

test('parseReferenceList accepts a wrapped { files / reference_files } response', () => {
  assert.deepStrictEqual(parseReferenceList({ files: ['x.wav'] }), ['x.wav']);
  assert.deepStrictEqual(parseReferenceList({ reference_files: ['y.wav'] }), ['y.wav']);
});

test('parseReferenceList tolerates garbage without throwing (empty My Voices, not a crash)', () => {
  assert.deepStrictEqual(parseReferenceList(null), []);
  assert.deepStrictEqual(parseReferenceList(undefined), []);
  assert.deepStrictEqual(parseReferenceList('nope'), []);
  assert.deepStrictEqual(parseReferenceList({}), []);
  assert.deepStrictEqual(parseReferenceList([1, null, {}, { other: 'x' }]), []);
});

const SAME_PARAMS = { exaggeration: 0.5, cfgWeight: 0.3, temperature: 0.75, speedFactor: 1.0 };

test('expressiveCacheVoice: predefined and clone with the SAME filename produce DIFFERENT keys', () => {
  const predefined = expressiveCacheVoice({ mode: 'predefined', voice: 'Alice.wav', params: SAME_PARAMS });
  const clone = expressiveCacheVoice({ mode: 'clone', voice: 'Alice.wav', params: SAME_PARAMS });
  assert.notStrictEqual(predefined, clone,
    'a predefined voice and a cloned reference filename that happen to share a name must not collide');
});

test('expressiveCacheVoice: identical inputs produce the SAME key (same-words-same-voice still caches)', () => {
  const a = expressiveCacheVoice({ mode: 'clone', voice: 'my-voice.wav', params: SAME_PARAMS });
  const b = expressiveCacheVoice({ mode: 'clone', voice: 'my-voice.wav', params: { ...SAME_PARAMS } });
  assert.strictEqual(a, b);
});

test('expressiveCacheVoice: defaults mode to predefined when omitted', () => {
  assert.strictEqual(
    expressiveCacheVoice({ voice: 'Axel.wav', params: SAME_PARAMS }),
    expressiveCacheVoice({ mode: 'predefined', voice: 'Axel.wav', params: SAME_PARAMS }),
  );
});

test('expressiveCacheVoice: changing a generation param changes the key', () => {
  const a = expressiveCacheVoice({ mode: 'clone', voice: 'v.wav', params: SAME_PARAMS });
  const b = expressiveCacheVoice({ mode: 'clone', voice: 'v.wav', params: { ...SAME_PARAMS, cfgWeight: 0.6 } });
  assert.notStrictEqual(a, b);
});

'use strict';
// One-time developer script: download the Kokoro model into assets/models so the
// app can run fully offline. Run with: `node scripts/fetch-model.js`. NOT shipped/run by users.
const path = require('node:path');

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const OUT = path.join(__dirname, '..', 'assets', 'models');

(async () => {
  const { env } = await import('@huggingface/transformers');
  // Download into our bundled location; allow remote ONLY for this fetch step.
  env.cacheDir = OUT;            // transformers.js caches the repo under OUT/<org>/<repo>/...
  env.allowRemoteModels = true;
  const { KokoroTTS } = await import('kokoro-js');
  console.log('Downloading', MODEL_ID, '→', OUT);
  const tts = await KokoroTTS.from_pretrained(MODEL_ID, { dtype: 'q8', device: 'cpu' });
  // Force the default voice to download too (voices load lazily/separately).
  await tts.generate('Bundling check.', { voice: 'af_heart' });
  // NOTE: kokoro-js 1.2.1 list_voices() prints and returns void; read the voices map directly.
  console.log('Done. Voices:', Object.keys(tts.voices).slice(0, 8), '…');
})().catch((e) => { console.error(e); process.exit(1); });

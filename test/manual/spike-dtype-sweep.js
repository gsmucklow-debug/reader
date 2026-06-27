'use strict';

// Manual harness (docs/plans/spike-voice-latency.md / -findings.md, the dtype win).
// The spike found the bundled q8 is ~4x SLOWER than fp16/q4/q4f16/fp32 on CPU. This
// sweeps CPU dtypes to find the best precision to SHIP (CPU-only, zero per-OS
// divergence): measures model file size, load-from-warm-cache time, warm synth latency.
// Downloads each dtype once into a persistent scratch cache, then re-loads from
// disk (no network) so load times are real. Run: node test/manual/spike-dtype-sweep.js
// NOT shipped (test/manual isn't packaged). RETAINED for the dtype follow-up: re-run
// this on the MacBook Pro M5 (the primary device, ARM, untested in the spike) before
// swapping the shipping dtype off q8.

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');

// Persistent (not mkdtemp) so a re-run reuses the downloaded weights.
const CACHE = path.join(os.tmpdir(), 'kokoro-dtype-sweep');
fs.mkdirSync(CACHE, { recursive: true });

const DTYPES = ['fp32', 'fp16', 'q8', 'q4', 'q4f16'];
const SENTENCES = [
  'The door closed behind her.',
  'It was a bright cold day in April, and the clocks were striking thirteen.',
  'He was an old man who fished alone in a skiff in the Gulf Stream.',
  'It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.',
  'Call me Ishmael.',
  'The sky above the port was the color of television, tuned to a dead channel.',
];

const ONNX_DIR = path.join(CACHE, 'onnx-community', 'Kokoro-82M-v1.0-ONNX', 'onnx');
const FILE_FOR = {
  fp32: 'model.onnx', fp16: 'model_fp16.onnx', q8: 'model_quantized.onnx',
  q4: 'model_q4.onnx', q4f16: 'model_q4f16.onnx',
};

function sizeMB(dtype) {
  try { return (fs.statSync(path.join(ONNX_DIR, FILE_FOR[dtype])).size / 1e6).toFixed(0); }
  catch { return '?'; }
}

async function loadTTS(dtype, remote) {
  const { env } = await import('@huggingface/transformers');
  env.cacheDir = CACHE;
  env.allowRemoteModels = remote;   // true on the download pass, false to time warm load
  env.allowLocalModels = true;
  const { KokoroTTS } = await import('kokoro-js');
  return KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype, device: 'cpu' });
}

async function cell(dtype) {
  // Download pass (uncounted) — ensures weights are on disk.
  try { await loadTTS(dtype, true); }
  catch (e) { console.log(`  ${dtype.padEnd(6)} download FAILED: ${e.message}`); return null; }

  // Timed load from warm disk cache (no network).
  const t0 = performance.now();
  const tts = await loadTTS(dtype, false);
  const load = performance.now() - t0;

  await tts.generate(SENTENCES[0], { voice: 'af_heart', speed: 1 }); // warm-up, discarded
  const times = [];
  for (const text of SENTENCES) {
    const t = performance.now();
    await tts.generate(text, { voice: 'af_heart', speed: 1 });
    times.push(performance.now() - t);
  }
  const sorted = [...times].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  console.log(`  ${dtype.padEnd(6)} | size ${sizeMB(dtype).padStart(4)} MB | load ${load.toFixed(0).padStart(5)} ms`
    + ` | synth median ${median.toFixed(0).padStart(5)} mean ${mean.toFixed(0).padStart(5)}`
    + ` min ${sorted[0].toFixed(0)} max ${sorted[sorted.length - 1].toFixed(0)} ms`);
  return { dtype, load, median };
}

(async () => {
  console.log('=== CPU dtype sweep on', os.cpus()[0].model, '===');
  console.log('(size = on-disk .onnx; load = from warm cache, no network; synth = warm, first discarded)\n');
  for (const d of DTYPES) await cell(d);
})().catch((e) => { console.error('SWEEP FAILED:', e); process.exit(1); });

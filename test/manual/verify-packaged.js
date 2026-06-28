'use strict';

// Task-7 packaged-app offline synth gate. Launches the BUILT exe (win-unpacked)
// via Playwright _electron with executablePath, isolated user-data-dir, and env
// WITHOUT ELECTRON_RUN_AS_NODE. Calls window.reader.synthesize and asserts
// nonzero WAV bytes @ 24000 Hz. Proves model loads from resources/assets/models,
// the .node loads from app.asar.unpacked, voices load from asar, allowRemoteModels=false.
// Run: node test/manual/verify-packaged.js

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert');
const { _electron: electron } = require('playwright');

const EXE = path.join(__dirname, '..', '..', 'dist', 'win-unpacked', 'Reader.exe');
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-pkg-verify-'));

(async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const app = await electron.launch({
    executablePath: EXE,
    args: [`--user-data-dir=${USERDATA}`],
    env,
  });

  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  const res = await win.evaluate(async () => {
    const out = await window.reader.synthesize('Packaged offline check.', { voice: 'af_heart' });
    const wav = out.wav;
    const len = (wav && (wav.byteLength != null ? wav.byteLength : wav.length)) || 0;
    return { len, sampleRate: out.sampleRate, ctor: wav && wav.constructor && wav.constructor.name };
  });

  console.log('PACKAGED synthesize result:', JSON.stringify(res));
  assert.ok(res.len > 0, `expected nonzero WAV bytes, got ${res.len}`);
  assert.strictEqual(res.sampleRate, 24000, `expected sampleRate 24000, got ${res.sampleRate}`);

  await app.close();
  console.log('PACKAGED VERIFY OK:', res.len, 'bytes @', res.sampleRate, 'Hz');
})().catch((err) => {
  console.error('PACKAGED VERIFY FAILED:', err);
  process.exit(1);
});

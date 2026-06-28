'use strict';

// Throwaway Task-2 verification: proves the full renderer→main→utilityProcess→
// renderer path for reader.synthesize. Launches the real app via Playwright
// _electron (stripping ELECTRON_RUN_AS_NODE so electron boots a GUI, not node),
// calls window.reader.synthesize, and asserts nonzero WAV bytes @ 24000 Hz.
// Run: node test/manual/verify-synthesize.js

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert');
const { _electron: electron } = require('playwright');

const ROOT = path.join(__dirname, '..', '..');
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-verify-'));

function launch() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // else electron acts as plain node (no GUI)
  return electron.launch({ args: [ROOT, `--user-data-dir=${USERDATA}`], env });
}

(async () => {
  const app = await launch();
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  const res = await win.evaluate(async () => {
    const out = await window.reader.synthesize('Hello from Reader.', { voice: 'af_heart' });
    // Marshal across the Playwright boundary as plain values.
    const wav = out.wav;
    const len = (wav && (wav.byteLength != null ? wav.byteLength : wav.length)) || 0;
    return { len, sampleRate: out.sampleRate, ctor: wav && wav.constructor && wav.constructor.name };
  });

  console.log('synthesize result:', JSON.stringify(res));
  assert.ok(res.len > 0, `expected nonzero WAV bytes, got ${res.len}`);
  assert.strictEqual(res.sampleRate, 24000, `expected sampleRate 24000, got ${res.sampleRate}`);

  await app.close();
  console.log('VERIFY OK: reader.synthesize returned', res.len, 'bytes @', res.sampleRate, 'Hz');
})().catch((err) => {
  console.error('VERIFY FAILED:', err);
  process.exit(1);
});

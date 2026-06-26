'use strict';
// Throwaway spike: run with `npx electron test/manual/spike-synthesize.js`.
// Spawns the TTS utilityProcess, synthesizes one sentence, writes spike.wav.
// IMPORTANT: clear ELECTRON_RUN_AS_NODE first, e.g.
//   env -u ELECTRON_RUN_AS_NODE npx electron test/manual/spike-synthesize.js
const electron = require('electron');
const path = require('node:path');
const fs = require('node:fs');

// Guard: if ELECTRON_RUN_AS_NODE leaked in, `electron` is the path string (no `app`),
// and this gate would prove nothing about native-module loading in real Electron.
if (typeof electron === 'string' || !electron.app || !electron.utilityProcess) {
  console.error('FATAL: not running inside Electron runtime (ELECTRON_RUN_AS_NODE set?).');
  console.error('Re-run with: env -u ELECTRON_RUN_AS_NODE npx electron test/manual/spike-synthesize.js');
  process.exit(1);
}
const { app, utilityProcess } = electron;

let done = false;

app.whenReady().then(() => {
  const child = utilityProcess.fork(path.join(__dirname, '..', '..', 'src', 'main', 'tts-service.js'));
  // The WAV rides back as msg.wav (a Uint8Array; structured-cloned, not transferred).
  child.on('message', (m) => {
    if (m.id !== 1) return;
    if (!m.ok) { console.error('SYNTH FAILED:', m.error); app.exit(1); return; }
    // Buffer.from(typedArray) copies and respects byteOffset/length — offset-safe.
    fs.writeFileSync(path.join(__dirname, 'spike.wav'), Buffer.from(m.wav));
    console.log('WROTE spike.wav', m.wav.length, 'bytes @', m.sampleRate, 'Hz');
    done = true;
    app.exit(0);
  });
  // Only an error if the child dies BEFORE we got our result.
  child.on('exit', (code) => {
    if (done) return;
    console.error('utilityProcess exited early, code', code);
    app.exit(1);
  });
  child.postMessage({ id: 1, type: 'synthesize', text:
    'The quick brown fox jumps over the lazy dog.', voice: 'af_heart' });
});

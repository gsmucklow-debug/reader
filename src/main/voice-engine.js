'use strict';
// Pure/testable core of the Voice Engine lifecycle manager: Reader auto-starts and auto-stops
// the optional Chatterbox-class server (the "Voice Engine") when the user switches to the
// Expressive TTS engine. Split out of main.js (which can't be require()'d directly — it's the
// Electron app entry point) so the command-building, folder validation, and readiness-polling
// logic are unit-testable with injected fakes (no real fs, no real spawn, no real timers).
// The actual child_process.spawn / taskkill / fs / setTimeout glue lives in main.js and calls
// these helpers. Mirrors the expressive-tts.js / expressive-params.js extraction pattern.

const path = require('node:path');

// Launch the server DIRECTLY with the embedded python:
//   <dir>\python_embedded\python.exe server.py   (cwd = dir)
// NOT `start.py --portable`: start.py is a LAUNCHER meant to be run by the *system* python (it
// does env detection + sets up the embedded env), so running it with the embedded python breaks
// it. server.py has `if __name__=='__main__': uvicorn.run(... port 8004)`, and start.py's own
// launch_server() does exactly `Popen([embedded_python, server.py])`. The caller (main.js) must
// also prepend python_embedded (+ its Scripts) to PATH so the native .pyd/DLLs are discoverable.
function engineCommand(dir) {
  return {
    exe: path.join(dir, 'python_embedded', 'python.exe'),
    args: ['server.py'],
    cwd: dir,
  };
}

// A valid engine dir must contain both the embedded python interpreter and server.py (what we run).
// `fsExistsFn` is injected (real callers pass fs.existsSync-shaped fn) so this is testable
// without touching disk. A falsy/empty dir is invalid without even consulting fsExistsFn.
function validateEngineDir(dir, fsExistsFn) {
  if (!dir) return false;
  const { exe, cwd } = engineCommand(dir);
  const serverPy = path.join(cwd, 'server.py');
  return !!(fsExistsFn(exe) && fsExistsFn(serverPy));
}

// Poll `healthFn` every `intervalMs` until it resolves truthy or `timeoutMs` elapses.
// `sleepFn` is injected (real callers pass a promisified setTimeout) so this runs instantly
// under fake timers in tests. A throwing/rejecting healthFn is treated as "not ready yet"
// (mirrors the server being down mid-boot — ECONNREFUSED, not a hard error) rather than
// propagating as a rejection: the caller only ever gets a boolean.
//
// Elapsed time is tracked as a counter of `intervalMs` slept (not wall-clock Date.now()) so
// this is exactly reproducible under injected fake sleepFns that don't advance real time.
async function pollUntilReady({ healthFn, intervalMs, timeoutMs, sleepFn }) {
  let elapsedMs = 0;
  for (;;) {
    let ready = false;
    try {
      ready = !!(await healthFn());
    } catch {
      ready = false;
    }
    if (ready) return true;
    if (elapsedMs >= timeoutMs) return false;
    await sleepFn(intervalMs);
    elapsedMs += intervalMs;
  }
}

// Auto-detect the Voice Engine folder from a list of candidate paths, so the user never has to
// locate it manually (it's a local install in a standard place). Returns the first candidate that
// validates, else null. `candidates` + `fsExistsFn` are injected so this is testable.
function detectEngineDir(candidates, fsExistsFn) {
  for (const dir of candidates || []) {
    if (validateEngineDir(dir, fsExistsFn)) return dir;
  }
  return null;
}

module.exports = { engineCommand, validateEngineDir, pollUntilReady, detectEngineDir };

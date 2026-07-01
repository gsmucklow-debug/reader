'use strict';
// Guards the pure/testable core of the Voice Engine lifecycle manager (auto start/stop of the
// optional Chatterbox server). The actual spawn/taskkill/fs/timers glue lives in main.js — this
// file only exercises the three injected-fake-friendly helpers extracted into voice-engine.js:
// engineCommand (exe/args/cwd), validateEngineDir (fs existence check), and pollUntilReady (a
// state machine driven by injected healthFn/sleepFn so no real network/timers are involved).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  engineCommand,
  validateEngineDir,
  pollUntilReady,
  detectEngineDir,
} = require('../../src/main/voice-engine');

test('detectEngineDir returns the first candidate that validates (has python + server.py)', () => {
  const good = 'C:\\Users\\me\\Chatterbox-TTS-Server';
  const exists = (p) => p.startsWith(good); // only the good dir's files "exist"
  assert.equal(
    detectEngineDir(['C:\\nope', good, 'C:\\also-nope'], exists),
    good,
  );
  assert.equal(detectEngineDir(['C:\\nope', 'C:\\also-nope'], exists), null);
  assert.equal(detectEngineDir([], exists), null);
  assert.equal(detectEngineDir(undefined, exists), null);
});

// --- engineCommand ----------------------------------------------------------

test('engineCommand runs server.py directly with the embedded python', () => {
  const dir = 'C:\\Users\\me\\VoiceEngine';
  const cmd = engineCommand(dir);
  assert.strictEqual(cmd.exe, path.join(dir, 'python_embedded', 'python.exe'));
  assert.deepStrictEqual(cmd.args, ['server.py']); // NOT start.py (that's a system-python launcher)
  assert.strictEqual(cmd.cwd, dir);
});

test('engineCommand joins paths correctly regardless of trailing slash', () => {
  const cmd = engineCommand('C:\\VoiceEngine\\');
  assert.strictEqual(cmd.exe, path.join('C:\\VoiceEngine\\', 'python_embedded', 'python.exe'));
  assert.strictEqual(cmd.cwd, 'C:\\VoiceEngine\\');
});

// --- validateEngineDir -------------------------------------------------------

test('validateEngineDir is true when both python.exe and server.py exist', () => {
  const dir = 'C:\\VoiceEngine';
  const exists = (p) =>
    p === path.join(dir, 'python_embedded', 'python.exe') || p === path.join(dir, 'server.py');
  assert.strictEqual(validateEngineDir(dir, exists), true);
});

test('validateEngineDir is false when python.exe is missing', () => {
  const dir = 'C:\\VoiceEngine';
  const exists = (p) => p === path.join(dir, 'server.py');
  assert.strictEqual(validateEngineDir(dir, exists), false);
});

test('validateEngineDir is false when server.py is missing', () => {
  const dir = 'C:\\VoiceEngine';
  const exists = (p) => p === path.join(dir, 'python_embedded', 'python.exe');
  assert.strictEqual(validateEngineDir(dir, exists), false);
});

test('validateEngineDir is false for a falsy/empty dir without calling fsExistsFn', () => {
  let called = false;
  const exists = () => { called = true; return true; };
  assert.strictEqual(validateEngineDir('', exists), false);
  assert.strictEqual(validateEngineDir(null, exists), false);
  assert.strictEqual(validateEngineDir(undefined, exists), false);
  assert.strictEqual(called, false);
});

// --- pollUntilReady -----------------------------------------------------------

test('pollUntilReady resolves true immediately when the first health check succeeds', async () => {
  let healthCalls = 0;
  let sleepCalls = 0;
  const ok = await pollUntilReady({
    healthFn: async () => { healthCalls++; return true; },
    intervalMs: 1000,
    timeoutMs: 5000,
    sleepFn: async () => { sleepCalls++; },
  });
  assert.strictEqual(ok, true);
  assert.strictEqual(healthCalls, 1);
  assert.strictEqual(sleepCalls, 0);
});

test('pollUntilReady resolves true after N unsuccessful polls, sleeping between each', async () => {
  let calls = 0;
  let sleeps = 0;
  const ok = await pollUntilReady({
    healthFn: async () => { calls++; return calls >= 4; }, // ready on the 4th check
    intervalMs: 1500,
    timeoutMs: 60000,
    sleepFn: async () => { sleeps++; },
  });
  assert.strictEqual(ok, true);
  assert.strictEqual(calls, 4);
  assert.strictEqual(sleeps, 3); // slept between checks, not after the final success
});

test('pollUntilReady resolves false when the server never becomes ready within timeoutMs', async () => {
  let calls = 0;
  let elapsed = 0;
  const ok = await pollUntilReady({
    healthFn: async () => { calls++; return false; },
    intervalMs: 1000,
    timeoutMs: 3500,
    sleepFn: async () => { elapsed += 1000; },
  });
  assert.strictEqual(ok, false);
  // Bounded: should not poll forever — call count consistent with timeoutMs/intervalMs.
  assert.ok(calls <= 5, `expected a bounded number of polls, got ${calls}`);
  assert.ok(calls >= 3, `expected at least a few polls before giving up, got ${calls}`);
});

test('pollUntilReady treats a throwing healthFn as "not ready" rather than rejecting', async () => {
  let calls = 0;
  const ok = await pollUntilReady({
    healthFn: async () => {
      calls++;
      if (calls < 3) throw new Error('ECONNREFUSED');
      return true;
    },
    intervalMs: 500,
    timeoutMs: 5000,
    sleepFn: async () => {},
  });
  assert.strictEqual(ok, true);
  assert.strictEqual(calls, 3);
});

test('pollUntilReady bounds total health calls by timeoutMs/intervalMs (no infinite loop)', async () => {
  let calls = 0;
  const ok = await pollUntilReady({
    healthFn: async () => { calls++; return false; },
    intervalMs: 100,
    timeoutMs: 1000,
    sleepFn: async () => {},
  });
  assert.strictEqual(ok, false);
  assert.ok(calls <= 11, `expected roughly timeoutMs/intervalMs polls, got ${calls}`);
});

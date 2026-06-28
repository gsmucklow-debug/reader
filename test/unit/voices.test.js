'use strict';
// Guards the curated voice picker: every id listed in app.js's VOICES array must
// exist as a bundled kokoro-js voice (*.bin), or the picker silently falls back to
// af_heart on selection. app.js is a browser script (touches `document` at load),
// so we parse the VOICES block out of the source text rather than require()ing it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.join(__dirname, '../../src/renderer/app.js');
const VOICES_DIR = path.join(__dirname, '../../node_modules/kokoro-js/voices');

function curatedVoiceIds() {
  const src = fs.readFileSync(APP, 'utf8');
  const start = src.indexOf('const VOICES = [');
  assert.ok(start !== -1, 'VOICES array not found in app.js');
  const end = src.indexOf('\n];', start);
  assert.ok(end !== -1, 'end of VOICES array not found');
  const block = src.slice(start, end);
  return [...block.matchAll(/id:\s*'([a-z]{2}_[a-z]+)'/g)].map((m) => m[1]);
}

test('every curated voice id exists as a bundled kokoro-js .bin', () => {
  const ids = curatedVoiceIds();
  assert.ok(ids.length >= 18, `expected the generous (~22) list, got ${ids.length}`);
  for (const id of ids) {
    const bin = path.join(VOICES_DIR, `${id}.bin`);
    assert.ok(fs.existsSync(bin), `voice "${id}" has no bundled .bin (${bin})`);
  }
});

test('no duplicate voice ids', () => {
  const ids = curatedVoiceIds();
  assert.equal(new Set(ids).size, ids.length, 'duplicate voice id in VOICES');
});

test('the default voice (af_heart) is in the curated list', () => {
  assert.ok(curatedVoiceIds().includes('af_heart'));
});

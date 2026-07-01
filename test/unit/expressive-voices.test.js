'use strict';
// Guards the curated EXPRESSIVE_VOICES list in app.js: exactly the 28 server voices the user
// confirmed by ear (10 female + 18 male), each id a `.wav` filename (the server's
// predefined_voice_id), no duplicates. app.js touches `document` at load, so — mirroring
// voices.test.js — parse the source text rather than require()ing it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.join(__dirname, '../../src/renderer/app.js');

function expressiveVoiceIds() {
  const src = fs.readFileSync(APP, 'utf8');
  const start = src.indexOf('const EXPRESSIVE_VOICES = [');
  assert.ok(start !== -1, 'EXPRESSIVE_VOICES array not found in app.js');
  const end = src.indexOf('\n];', start);
  assert.ok(end !== -1, 'end of EXPRESSIVE_VOICES array not found');
  const block = src.slice(start, end);
  // Only pull names out of the `items: [ ... ]` name arrays (which .map() into voice
  // objects) — not the `group: 'Female'/'Male'` labels.
  const names = [];
  for (const itemsBlock of block.matchAll(/items: \[([\s\S]*?)\]\.map/g)) {
    for (const m of itemsBlock[1].matchAll(/'([A-Za-z]+)'/g)) names.push(m[1]);
  }
  return names;
}

test('EXPRESSIVE_VOICES has exactly 28 voices (10 female + 18 male)', () => {
  const ids = expressiveVoiceIds();
  assert.equal(ids.length, 28, `expected 28 curated server voices, got ${ids.length}`);
});

test('no duplicate expressive voice names', () => {
  const ids = expressiveVoiceIds();
  assert.equal(new Set(ids).size, ids.length, 'duplicate voice name in EXPRESSIVE_VOICES');
});

test('the default expressive voice (Axel) is in the curated list', () => {
  assert.ok(expressiveVoiceIds().includes('Axel'));
});

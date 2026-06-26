'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { clipKey } = require('../../src/main/clip-cache');

test('clipKey is stable and depends on text + voice', () => {
  const a = clipKey('Hello world.', 'af_heart');
  assert.strictEqual(a, clipKey('Hello world.', 'af_heart'));      // stable
  assert.notStrictEqual(a, clipKey('Hello world.', 'bf_emma'));    // voice matters
  assert.notStrictEqual(a, clipKey('Goodbye world.', 'af_heart')); // text matters
  assert.match(a, /^[0-9a-f]{16,}\.wav$/);                          // filename-safe
});

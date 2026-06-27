'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { clipKey, makeCache } = require('../../src/main/clip-cache');

test('clipKey depends on text, voice, AND speed', () => {
  const base = clipKey('Hello world.', 'af_heart', 1);
  assert.strictEqual(base, clipKey('Hello world.', 'af_heart', 1));     // stable
  assert.notStrictEqual(base, clipKey('Hello world.', 'bf_emma', 1));   // voice matters
  assert.notStrictEqual(base, clipKey('Goodbye world.', 'af_heart', 1));// text matters
  assert.notStrictEqual(base, clipKey('Hello world.', 'af_heart', 1.25)); // speed matters
  assert.match(base, /^[0-9a-f]{16,}\.wav$/);                          // filename-safe
});

test('makeCache round-trips bytes and never fails the synth path', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clip-cache-test-'));
  try {
    const cache = makeCache(dir);
    const bytes = Buffer.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]); // "RIFF"...

    assert.strictEqual(await cache.get('miss', 'af_heart', 1), null); // miss -> null, no throw

    await cache.put('hello', 'af_heart', 1, bytes);
    const got = await cache.get('hello', 'af_heart', 1);
    assert.ok(Buffer.isBuffer(got));
    assert.ok(got.equals(bytes)); // same bytes back

    // A different speed is a cache miss for the same text+voice (independent combos).
    assert.strictEqual(await cache.get('hello', 'af_heart', 1.25), null);

    // No temp files left behind after the atomic rename.
    const leftover = (await fs.readdir(dir)).filter((f) => f.endsWith('.tmp'));
    assert.deepStrictEqual(leftover, []);

    // put() to a bogus, un-writable path must NOT throw: caching must never
    // break the synth path. Point dir at a file so mkdir/write fails.
    const fileAsDir = path.join(dir, 'not-a-dir');
    await fs.writeFile(fileAsDir, 'x');
    const broken = makeCache(path.join(fileAsDir, 'clips'));
    await broken.put('hello', 'af_heart', 1, bytes); // resolves, does not reject
    assert.strictEqual(await broken.get('hello', 'af_heart', 1), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

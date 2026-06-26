'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { clipKey, makeCache } = require('../../src/main/clip-cache');

test('clipKey is stable and depends on text + voice', () => {
  const a = clipKey('Hello world.', 'af_heart');
  assert.strictEqual(a, clipKey('Hello world.', 'af_heart'));      // stable
  assert.notStrictEqual(a, clipKey('Hello world.', 'bf_emma'));    // voice matters
  assert.notStrictEqual(a, clipKey('Goodbye world.', 'af_heart')); // text matters
  assert.match(a, /^[0-9a-f]{16,}\.wav$/);                          // filename-safe
});

test('makeCache round-trips bytes and never fails the synth path', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clip-cache-test-'));
  try {
    const cache = makeCache(dir);
    const bytes = Buffer.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]); // "RIFF"...

    assert.strictEqual(await cache.get('miss', 'af_heart'), null); // miss -> null, no throw

    await cache.put('hello', 'af_heart', bytes);
    const got = await cache.get('hello', 'af_heart');
    assert.ok(Buffer.isBuffer(got));
    assert.ok(got.equals(bytes)); // same bytes back

    // No temp files left behind after the atomic rename.
    const leftover = (await fs.readdir(dir)).filter((f) => f.endsWith('.tmp'));
    assert.deepStrictEqual(leftover, []);

    // put() to a bogus, un-writable path must NOT throw: caching must never
    // break the synth path. Point dir at a file so mkdir/write fails.
    const fileAsDir = path.join(dir, 'not-a-dir');
    await fs.writeFile(fileAsDir, 'x');
    const broken = makeCache(path.join(fileAsDir, 'clips'));
    await broken.put('hello', 'af_heart', bytes); // resolves, does not reject
    assert.strictEqual(await broken.get('hello', 'af_heart'), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

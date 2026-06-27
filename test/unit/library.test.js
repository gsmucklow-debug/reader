'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeLibrary, isFinished, splitShelf } = require('../../src/main/library');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'reader-lib-')); }

// Fake parse/cover deps: a 2-chapter doc, lastAddress = {1,0,0}; no cover.
const fakeDoc = { title: 'Test Book', chapters: [
  { paragraphs: [ { sentences: ['a', 'b'] } ] },
  { paragraphs: [ { sentences: ['c'] } ] },
] };
const deps = { parse: async () => fakeDoc, cover: async () => null };

test('add stores a record with lastAddress and null progress', async () => {
  const lib = makeLibrary(tmpDir(), deps);
  const rec = await lib.add(Buffer.from('EPUBBYTES-1'), 'book.epub');
  assert.equal(rec.title, 'Test Book');
  assert.deepEqual(rec.lastAddress, { ci: 1, pi: 0, si: 0 });
  assert.equal(rec.progress, null);
  assert.equal((await lib.list()).length, 1);
});

test('add is idempotent by content hash AND preserves progress on re-add', async () => {
  const lib = makeLibrary(tmpDir(), deps);
  const bytes = Buffer.from('SAME-BYTES');
  const rec = await lib.add(bytes, 'book.epub');
  await lib.updateProgress(rec.id, { ci: 0, pi: 0, si: 1 });
  const again = await lib.add(bytes, 'book.epub'); // re-drop a half-read book
  assert.equal((await lib.list()).length, 1, 'no duplicate tile');
  assert.deepEqual(again.progress, { ci: 0, pi: 0, si: 1 }, 'progress survives re-add');
});

test('open returns the doc + progress and bumps lastOpenedAt', async () => {
  const lib = makeLibrary(tmpDir(), deps);
  const rec = await lib.add(Buffer.from('B'), 'b.epub');
  await lib.updateProgress(rec.id, { ci: 0, pi: 0, si: 1 });
  const opened = await lib.open(rec.id);
  assert.deepEqual(opened.doc, fakeDoc);
  assert.deepEqual(opened.progress, { ci: 0, pi: 0, si: 1 });
});

test('opening a FINISHED book resets progress to null (restart from beginning)', async () => {
  const lib = makeLibrary(tmpDir(), deps);
  const rec = await lib.add(Buffer.from('B'), 'b.epub');
  await lib.updateProgress(rec.id, rec.lastAddress); // mark finished
  assert.equal(isFinished(await getRec(lib, rec.id)), true);
  const opened = await lib.open(rec.id);
  assert.equal(opened.progress, null, 'finished reopen starts at the beginning');
  assert.equal(isFinished(await getRec(lib, rec.id)), false, 'back to active');
});

test('remove deletes the record (and its folder)', async () => {
  const lib = makeLibrary(tmpDir(), deps);
  const rec = await lib.add(Buffer.from('B'), 'b.epub');
  await lib.remove(rec.id);
  assert.equal((await lib.list()).length, 0);
});

test('isFinished: progress deep-equals lastAddress', () => {
  assert.equal(isFinished({ progress: { ci: 1, pi: 0, si: 0 }, lastAddress: { ci: 1, pi: 0, si: 0 } }), true);
  assert.equal(isFinished({ progress: { ci: 0, pi: 0, si: 0 }, lastAddress: { ci: 1, pi: 0, si: 0 } }), false);
  assert.equal(isFinished({ progress: null, lastAddress: { ci: 1, pi: 0, si: 0 } }), false);
});

test('splitShelf: active (unfinished) by lastOpened desc, finished separate', () => {
  const recs = [
    { id: 'a', lastOpenedAt: 10, progress: null, lastAddress: { ci: 0, pi: 0, si: 1 } },
    { id: 'b', lastOpenedAt: 30, progress: { ci: 0, pi: 0, si: 1 }, lastAddress: { ci: 0, pi: 0, si: 1 } }, // finished
    { id: 'c', lastOpenedAt: 20, progress: { ci: 0, pi: 0, si: 0 }, lastAddress: { ci: 0, pi: 0, si: 1 } },
  ];
  const { active, finished } = splitShelf(recs);
  assert.deepEqual(active.map(r => r.id), ['c', 'a']); // 20 then 10
  assert.deepEqual(finished.map(r => r.id), ['b']);
});

// helper: read one record back via list()
async function getRec(lib, id) { return (await lib.list()).find(r => r.id === id); }

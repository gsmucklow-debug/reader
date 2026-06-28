'use strict';
// The library index + per-book store. Lives under <base>/ (caller passes userData/library).
//   <base>/index.json                  -> { books: [ record, ... ] }
//   <base>/books/<id>/original.epub     copied source
//   <base>/books/<id>/document.json     parsed Document (instant reopen)
//   <base>/books/<id>/cover.<ext>       extracted cover (absent => render a title card)
// Decisions live here so they're unit-testable: idempotent-by-hash preserves progress;
// opening a finished book resets progress (restart); active/finished split is derived.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const fssync = require('node:fs');
const path = require('node:path');
const { parseDocument, extractCover } = require('../parse');
const { lastAddress } = require('../renderer/reading-cursor'); // dual-mode require

function eqAddr(a, b) {
  return !!a && !!b && a.ci === b.ci && a.pi === b.pi && a.si === b.si;
}
function isFinished(rec) { return eqAddr(rec.progress, rec.lastAddress); }
function splitShelf(records) {
  const byRecent = (x, y) => (y.lastOpenedAt || 0) - (x.lastOpenedAt || 0);
  const active = records.filter((r) => !isFinished(r)).sort(byRecent);
  const finished = records.filter(isFinished).sort(byRecent);
  return { active, finished };
}

// `deps` lets tests inject fakes: { parse(buffer)->doc, cover(buffer)->{bytes,ext}|null }
function makeLibrary(base, deps = {}) {
  const parse = deps.parse || parseDocument;
  const cover = deps.cover || extractCover;
  const indexPath = path.join(base, 'index.json');
  const bookDir = (id) => path.join(base, 'books', id);

  async function readIndex() {
    try { return JSON.parse(await fs.readFile(indexPath, 'utf8')); }
    catch { return { books: [] }; }
  }
  async function writeIndex(idx) {
    await fs.mkdir(base, { recursive: true });
    const tmp = `${indexPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(idx, null, 2), 'utf8');
    await fs.rename(tmp, indexPath);
  }

  async function list() { return (await readIndex()).books; }

  async function add(buffer, fileName) {
    const id = crypto.createHash('sha256').update(buffer).digest('hex');
    const idx = await readIndex();
    const existing = idx.books.find((b) => b.id === id);
    if (existing) {                      // idempotent: refresh recency, KEEP progress
      existing.lastOpenedAt = Date.now();
      await writeIndex(idx);
      return existing;
    }
    const doc = await parse(buffer, fileName);
    const dir = bookDir(id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'original.epub'), buffer);
    await fs.writeFile(path.join(dir, 'document.json'), JSON.stringify(doc), 'utf8');
    let coverName = null;
    const cov = await cover(buffer, fileName);
    if (cov && cov.bytes && cov.bytes.length) {
      coverName = `cover.${cov.ext}`;
      await fs.writeFile(path.join(dir, coverName), Buffer.from(cov.bytes));
    }
    const rec = {
      id, title: doc.title || fileName || 'Untitled', author: doc.author || null,
      fileName: fileName || null, addedAt: Date.now(), lastOpenedAt: Date.now(),
      cover: coverName, lastAddress: lastAddress(doc), progress: null,
    };
    idx.books.push(rec);
    await writeIndex(idx);
    return rec;
  }

  async function open(id) {
    const idx = await readIndex();
    const rec = idx.books.find((b) => b.id === id);
    if (!rec) return null;
    if (isFinished(rec)) rec.progress = null; // reopen finished => restart from beginning
    rec.lastOpenedAt = Date.now();
    await writeIndex(idx);
    const doc = JSON.parse(await fs.readFile(path.join(bookDir(id), 'document.json'), 'utf8'));
    return { doc, progress: rec.progress, record: rec };
  }

  async function updateProgress(id, addr) {
    const idx = await readIndex();
    const rec = idx.books.find((b) => b.id === id);
    if (!rec) return false;
    rec.progress = addr;
    await writeIndex(idx);
    return true;
  }

  // Synchronous flush for the renderer 'beforeunload' path (see Task 7). Avoids the
  // before-quit async-write race: writes index.json with the latest address before exit.
  function updateProgressSync(id, addr) {
    try {
      let idx; try { idx = JSON.parse(fssync.readFileSync(indexPath, 'utf8')); } catch { return false; }
      const rec = idx.books.find((b) => b.id === id);
      if (!rec) return false;
      rec.progress = addr;
      fssync.writeFileSync(indexPath, JSON.stringify(idx, null, 2), 'utf8');
      return true;
    } catch { return false; }
  }

  async function remove(id) {
    const idx = await readIndex();
    idx.books = idx.books.filter((b) => b.id !== id);
    await writeIndex(idx);
    await fs.rm(bookDir(id), { recursive: true, force: true });
    return true;
  }

  return { list, add, open, updateProgress, updateProgressSync, remove };
}

module.exports = { makeLibrary, isFinished, splitShelf, eqAddr };

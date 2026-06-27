'use strict';
// Content-addressed clip cache. Key = sha1("<voice> <text>").wav, so identical sentences
// (incl. rewind/re-read) reuse one file. Lives under userData/clips. Phase 3 may
// formalize per-book folders; a global content hash is correct and dedupes for now.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

function clipKey(text, voice) {
  const h = crypto.createHash('sha1').update(`${voice || 'af_heart'} ${text}`).digest('hex');
  return `${h}.wav`;
}

function makeCache(dir) {
  let ready = null;
  const ensure = () => (ready ||= fs.mkdir(dir, { recursive: true }));
  return {
    async get(text, voice) {
      try { return await fs.readFile(path.join(dir, clipKey(text, voice))); }
      catch { return null; }
    },
    async put(text, voice, bytes) {
      // Best-effort, durable cache write: the WAV bytes are already in hand, so a
      // write failure (disk full / permissions) must never fail the synth path.
      // Write to a unique temp file then atomically rename, so a kill mid-write
      // can't leave a truncated .wav that get() would later serve as a poisoned hit.
      try {
        await ensure();
        const final = path.join(dir, clipKey(text, voice));
        const tmp = `${final}.${process.pid}.${Date.now()}.tmp`;
        await fs.writeFile(tmp, Buffer.from(bytes));
        await fs.rename(tmp, final);
      } catch { /* best-effort cache; never fail the synth path */ }
    },
  };
}

module.exports = { clipKey, makeCache };

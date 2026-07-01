'use strict';
// Content-addressed clip cache. Key = sha1("<voice> <speed> <text>").wav for the default
// Kokoro engine, or sha1("<engine> <voice> <speed> <text>").wav for an alternate backend
// (e.g. the GPU Chatterbox voice). Identical sentences (incl. rewind/re-read) reuse one file,
// and each (engine, voice, speed) combo caches independently — switching never wipes the others.
// Lives under userData/clips. Phase 3 may formalize per-book folders; a global content hash is
// correct and dedupes for now.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

function clipKey(text, voice, speed, engine) {
  const v = voice || 'af_heart';
  const s = Number.isFinite(speed) ? speed : 1;
  // Kokoro is the default engine and is left OUT of the key so the user's existing warm
  // clips stay hits across this change. Any other engine gets a distinct namespace.
  const prefix = engine && engine !== 'kokoro' ? `${engine} ` : '';
  const h = crypto.createHash('sha1').update(`${prefix}${v} ${s} ${text}`).digest('hex');
  return `${h}.wav`;
}

function makeCache(dir) {
  let ready = null;
  const ensure = () => (ready ||= fs.mkdir(dir, { recursive: true }));
  return {
    async get(text, voice, speed, engine) {
      try { return await fs.readFile(path.join(dir, clipKey(text, voice, speed, engine))); }
      catch { return null; }
    },
    async put(text, voice, speed, bytes, engine) {
      // Best-effort, durable cache write: the WAV bytes are already in hand, so a
      // write failure (disk full / permissions) must never fail the synth path.
      // Write to a unique temp file then atomically rename, so a kill mid-write
      // can't leave a truncated .wav that get() would later serve as a poisoned hit.
      try {
        await ensure();
        const final = path.join(dir, clipKey(text, voice, speed, engine));
        const tmp = `${final}.${process.pid}.${Date.now()}.tmp`;
        await fs.writeFile(tmp, Buffer.from(bytes));
        await fs.rename(tmp, final);
      } catch { /* best-effort cache; never fail the synth path */ }
    },
  };
}

module.exports = { clipKey, makeCache };

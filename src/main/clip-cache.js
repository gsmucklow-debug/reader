'use strict';
// Content-addressed clip cache. Key = sha1(text|voice).wav, so identical sentences
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
      await ensure();
      await fs.writeFile(path.join(dir, clipKey(text, voice)), Buffer.from(bytes));
    },
  };
}

module.exports = { clipKey, makeCache };

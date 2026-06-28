'use strict';
const path = require('node:path');
const { parseEpub, coverImage } = require('./epub');
const { parseMarkdown } = require('./markdown');

function extOf(fileName) {
  return path.extname(String(fileName || '')).toLowerCase().replace(/^\./, '');
}

async function parseDocument(buffer, fileName) {
  const ext = extOf(fileName);
  if (ext === 'epub') return parseEpub(buffer);
  if (ext === 'md' || ext === 'markdown') return parseMarkdown(buffer, fileName);
  throw new Error(`Unsupported file type: .${ext || '(none)'}`);
}

async function extractCover(buffer, fileName) {
  const ext = extOf(fileName);
  if (ext === 'epub') return coverImage(buffer);
  return null;
}

module.exports = { parseDocument, extractCover };

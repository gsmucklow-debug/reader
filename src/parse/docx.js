'use strict';

/**
 * DOCX -> normalized Document. mammoth converts .docx (OOXML) to HTML, mapping
 * Word "Heading 1-6" styles to <h1>-<h6>; we then reuse the EPUB htmlToBlocks()
 * and the shared blocksToChapters(). Only .docx (OOXML), not the old binary .doc.
 */

const mammoth = require('mammoth');
const { htmlToBlocks } = require('./epub');
const { blocksToChapters } = require('./blocks-to-chapters');

async function parseDocx(buffer, fileName) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const { value: html } = await mammoth.convertToHtml({ buffer: buf }); // ignore .messages (style warnings)
  const blocks = htmlToBlocks(html);
  return blocksToChapters(blocks, { fileName });
}

module.exports = { parseDocx };

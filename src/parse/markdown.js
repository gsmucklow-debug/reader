'use strict';

/**
 * Markdown -> normalized Document. Markdown-specific front-end only:
 *   strip YAML frontmatter -> marked.parse -> HTML -> htmlToBlocks() ->
 *   the shared blocksToChapters() (top-most-heading split, { heading?, sentences }).
 * Pure: (Buffer|string, fileName) in, Document out. No I/O, no native modules.
 */

const { marked } = require('marked');
const { htmlToBlocks } = require('./epub');
const { blocksToChapters } = require('./blocks-to-chapters');

// Strip a single leading YAML frontmatter block (--- ... ---) at the very start.
function stripFrontmatter(text) {
  const s = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text; // drop a leading BOM
  const m = s.match(/^\s*---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/);
  return m ? s.slice(m[0].length) : s;
}

function parseMarkdown(buffer, fileName) {
  const raw = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer);
  const html = marked.parse(stripFrontmatter(raw));
  const blocks = htmlToBlocks(html);
  return blocksToChapters(blocks, { fileName });
}

module.exports = { parseMarkdown, stripFrontmatter };

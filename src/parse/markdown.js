'use strict';

const { marked } = require('marked');
const { htmlToBlocks } = require('./epub');
const { splitSentences } = require('./split-sentences');

const HEADING_LEVEL = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

function stripFrontmatter(text) {
  const s = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  const m = s.match(/^\s*---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/);
  return m ? s.slice(m[0].length) : s;
}

function baseName(fileName) {
  if (!fileName) return null;
  const base = String(fileName).split(/[\\/]/).pop();
  return base.replace(/\.(md|markdown)$/i, '') || null;
}

function blockToParagraph(b) {
  const sentences = splitSentences(b.text);
  if (sentences.length === 0) return null;
  const lvl = HEADING_LEVEL[b.tag];
  return lvl ? { heading: lvl, sentences } : { sentences };
}

function parseMarkdown(buffer, fileName) {
  const raw = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer);
  const html = marked.parse(stripFrontmatter(raw));
  const blocks = htmlToBlocks(html);

  let topLevel = null;
  for (const b of blocks) {
    const lvl = HEADING_LEVEL[b.tag];
    if (lvl && (topLevel === null || lvl < topLevel)) topLevel = lvl;
  }

  const chapters = [];
  let current = null;
  let docTitle = null;
  const startChapter = (title) => {
    current = { title: title || null, paragraphs: [] };
    chapters.push(current);
  };

  for (const b of blocks) {
    const isChapterHead = topLevel !== null && HEADING_LEVEL[b.tag] === topLevel;
    if (isChapterHead) {
      startChapter(b.text);
      if (docTitle === null) docTitle = b.text;
    } else if (current === null) {
      startChapter(null);
    }
    const para = blockToParagraph(b);
    if (para) current.paragraphs.push(para);
  }

  const kept = chapters.filter((c) => c.paragraphs.length > 0);
  const title = docTitle || baseName(fileName) || 'Untitled';
  return { title, chapters: kept };
}

module.exports = { parseMarkdown, stripFrontmatter };

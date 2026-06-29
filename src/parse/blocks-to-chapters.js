'use strict';

/**
 * A flat block list -> the normalized Document { title, chapters }.
 * A "block" is { tag, text } as produced by htmlToBlocks(). Chapters split at the
 * top-most heading level present (smallest number); leading pre-heading content
 * becomes one untitled chapter; a file with no headings is one untitled chapter.
 * Title: the first top-level heading's text, else filename-without-extension, else
 * 'Untitled'. Format-agnostic: both Markdown and DOCX funnel their HTML through here.
 */

const { splitSentences } = require('./split-sentences');

const HEADING_LEVEL = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

// filename -> title fallback: drop the path and a single trailing extension.
function baseName(fileName) {
  if (!fileName) return null;
  const base = String(fileName).split(/[\\/]/).pop();
  return base.replace(/\.[^.]+$/, '') || null;
}

// One block -> a paragraph, or null if it has no sentences.
function blockToParagraph(b) {
  const sentences = splitSentences(b.text);
  if (sentences.length === 0) return null;
  const lvl = HEADING_LEVEL[b.tag];
  return lvl ? { heading: lvl, sentences } : { sentences };
}

function blocksToChapters(blocks, { fileName } = {}) {
  // Top-most heading level present (smallest number); null if no headings.
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
      startChapter(null); // leading content before the first top-level heading
    }
    const para = blockToParagraph(b);
    if (para) current.paragraphs.push(para);
  }

  const kept = chapters.filter((c) => c.paragraphs.length > 0);
  const title = docTitle || baseName(fileName) || 'Untitled';
  return { title, chapters: kept };
}

module.exports = { blocksToChapters, baseName, blockToParagraph, HEADING_LEVEL };

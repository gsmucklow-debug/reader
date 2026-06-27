'use strict';

/**
 * EPUB → normalized Document extractor.
 *
 * The two bug-prone jobs called out in design.md live here:
 *   1. Reading-order extraction — follow the OPF *spine* in order, and skip the
 *      nav/toc document so the table of contents isn't read as if it were a chapter.
 *   2. Block extraction — pull real paragraph/heading text out of each XHTML doc,
 *      skipping nav/header/footer/script/style chrome.
 *
 * Sentence splitting is delegated to split-sentences.js (its own tested unit).
 *
 * Parsing is pure-JS (jszip + cheerio) so there are no native modules to compile
 * per-OS — a hard Phase-1 constraint.
 */

const JSZip = require('jszip');
const cheerio = require('cheerio');
const { splitSentences } = require('./split-sentences');

// Resolve an href that is relative to the OPF file into a full zip path.
function resolveHref(href, opfDir) {
  // strip any fragment, then normalize against the opf directory
  const clean = decodeURIComponent(String(href).split('#')[0]);
  const parts = (opfDir ? opfDir.split('/') : []).filter(Boolean);
  for (const seg of clean.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

function dirOf(p) {
  const idx = p.lastIndexOf('/');
  return idx === -1 ? '' : p.slice(0, idx);
}

/** Find the OPF package path from META-INF/container.xml. */
function findOpfPath(containerXml) {
  const $ = cheerio.load(containerXml, { xmlMode: true });
  const full = $('rootfile').attr('full-path');
  if (!full) throw new Error('EPUB container.xml has no rootfile full-path');
  return full;
}

/**
 * Parse an OPF package document.
 * @returns {{title:string, spine:Array<{idref,href,mediaType,properties}>}}
 */
function parseOpf(opfXml, opfPath) {
  const $ = cheerio.load(opfXml, { xmlMode: true });
  const opfDir = dirOf(opfPath);

  // dc:title carries a namespace prefix that CSS selectors can't address in
  // cheerio's xml mode, so match by tag name among metadata's descendants.
  let title = '';
  $('metadata')
    .find('*')
    .each((_, el) => {
      const name = (el.tagName || '').toLowerCase();
      if (!title && (name === 'dc:title' || name === 'title')) {
        title = $(el).text().trim();
      }
    });
  title = title || 'Untitled';

  // manifest: id -> {href(zip path), mediaType, properties}
  const byId = new Map();
  $('manifest item').each((_, el) => {
    const id = $(el).attr('id');
    if (!id) return;
    byId.set(id, {
      href: resolveHref($(el).attr('href') || '', opfDir),
      mediaType: $(el).attr('media-type') || '',
      properties: $(el).attr('properties') || '',
    });
  });

  // Cover id: EPUB3 uses properties="cover-image"; EPUB2 uses <meta name="cover" content="itemId">
  let metaCoverId = null;
  $('metadata').find('*').each((_, el) => {
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'meta' && ($(el).attr('name') || '').toLowerCase() === 'cover') {
      metaCoverId = $(el).attr('content') || null;
    }
  });
  let coverId = null;
  for (const [id, item] of byId) {
    if (/\bcover-image\b/.test(item.properties)) { coverId = id; break; }
  }
  if (!coverId && metaCoverId && byId.has(metaCoverId)) coverId = metaCoverId;

  const spine = [];
  $('spine itemref').each((_, el) => {
    const idref = $(el).attr('idref');
    const item = byId.get(idref);
    if (!item) return;
    spine.push({ idref, ...item });
  });

  // Locate the table-of-contents document so chapter titles can come from it
  // (the spine XHTML often lacks per-chapter headings, or repeats the book title
  // as a running header). Prefer the EPUB3 nav doc; fall back to the EPUB2 .ncx.
  let toc = null;
  for (const [, item] of byId) {
    if (/\bnav\b/.test(item.properties)) { toc = { href: item.href, type: 'xhtml' }; break; }
  }
  if (!toc) {
    const tocId = $('spine').attr('toc');
    if (tocId && byId.has(tocId)) toc = { href: byId.get(tocId).href, type: 'ncx' };
  }
  if (!toc) {
    for (const [, item] of byId) {
      if (/dtbncx/.test(item.mediaType) || /\.ncx$/i.test(item.href)) {
        toc = { href: item.href, type: 'ncx' };
        break;
      }
    }
  }

  return { title, spine, toc, coverId };
}

/**
 * Parse a TOC document into a map of spine-file href -> human chapter title.
 * Handles both the EPUB3 nav XHTML (`<nav epub:type="toc">` anchors) and the
 * EPUB2 `.ncx` (`navPoint > navLabel > text`). Fragments are stripped so a title
 * keys to its whole file; the first title seen for a file wins.
 *
 * @param {string} xml      the TOC document source
 * @param {'xhtml'|'ncx'} type
 * @param {string} tocPath  the TOC file's zip path (links resolve against its dir)
 * @returns {Map<string,string>}
 */
function parseToc(xml, type, tocPath) {
  const map = new Map();
  const tocDir = dirOf(tocPath);
  const add = (label, src) => {
    const title = String(label || '').replace(/\s+/g, ' ').trim();
    if (!title || !src) return;
    const href = resolveHref(src, tocDir);
    if (!map.has(href)) map.set(href, title);
  };

  if (type === 'ncx') {
    const $ = cheerio.load(xml, { xmlMode: true });
    $('navPoint').each((_, el) => {
      const label = $(el).find('navLabel').first().find('text').first().text();
      const src = $(el).find('content').first().attr('src');
      add(label, src);
    });
  } else {
    const $ = cheerio.load(xml);
    // Prefer the nav explicitly marked as the table of contents.
    let chosen = null;
    $('nav').each((_, el) => {
      const role = ($(el).attr('epub:type') || $(el).attr('role') || '').toLowerCase();
      if (!chosen && (role.includes('toc'))) chosen = el;
    });
    const scope = chosen ? $(chosen) : ($('nav').first().length ? $('nav').first() : $.root());
    scope.find('a').each((_, el) => add($(el).text(), $(el).attr('href')));
  }
  return map;
}

/** Reading order = spine order, minus the nav doc and non-XHTML items. */
function readingOrder(parsed) {
  return parsed.spine
    .filter((it) => /xhtml|html/i.test(it.mediaType) || it.href.match(/\.x?html?$/i))
    .filter((it) => !/\bnav\b/.test(it.properties))
    .map((it) => it.href);
}

const SKIP_TAGS = 'script,style,nav,header,footer,aside';
const BLOCK_TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'blockquote', 'li'];

/**
 * Extract ordered block-level text from an XHTML document, skipping chrome.
 * @returns {Array<{tag:string, text:string}>}
 */
function htmlToBlocks(html) {
  const $ = cheerio.load(html);
  $(SKIP_TAGS).remove();

  const blocks = [];
  $(BLOCK_TAGS.join(',')).each((_, el) => {
    // skip a block that merely contains other block elements (avoid duplicate
    // text from parent + child); repeated *leaf* lines (e.g. "* * *") are kept.
    const $el = $(el);
    if ($el.children(BLOCK_TAGS.join(',')).length > 0) return;
    const text = $el.text().replace(/\s+/g, ' ').trim();
    if (!text) return;
    blocks.push({ tag: el.tagName.toLowerCase(), text });
  });
  return blocks;
}

const HEADING_LEVEL = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

/**
 * Parse a whole EPUB buffer into the normalized Document contract:
 *   Document { title, chapters: [ { title, paragraphs: [ { heading?, sentences:[] } ] } ] }
 *
 * One spine document => one chapter. Headings are KEPT in reading order as
 * paragraphs carrying a `heading` level (so the renderer can show them and the
 * narrator reads them). The chapter `title` is metadata only (Chapters panel +
 * "Chapter X of Y" strip): navTitles.get(href) || firstHeadingText || null — it is
 * NOT injected into the page. A chapter with no heading of its own but a known title
 * gets ONE synthesized leading heading so every chapter has a visible, spoken header.
 */
async function parseEpub(buffer) {
  const zip = await JSZip.loadAsync(buffer);

  const containerFile = zip.file('META-INF/container.xml');
  if (!containerFile) throw new Error('Not a valid EPUB: missing META-INF/container.xml');
  const opfPath = findOpfPath(await containerFile.async('string'));

  const opfFile = zip.file(opfPath);
  if (!opfFile) throw new Error(`EPUB OPF not found at ${opfPath}`);
  const parsed = parseOpf(await opfFile.async('string'), opfPath);

  // Build href -> chapter-title map from the TOC document, if there is one.
  let navTitles = new Map();
  if (parsed.toc) {
    const tocFile = zip.file(parsed.toc.href);
    if (tocFile) {
      try {
        navTitles = parseToc(await tocFile.async('string'), parsed.toc.type, parsed.toc.href);
      } catch {
        navTitles = new Map(); // a malformed TOC just means we fall back to headings
      }
    }
  }

  const chapters = [];
  for (const href of readingOrder(parsed)) {
    const f = zip.file(href);
    if (!f) continue;
    const blocks = htmlToBlocks(await f.async('string'));
    if (blocks.length === 0) continue;

    // Keep every block in reading order; a heading block becomes a paragraph that
    // carries its level, so it renders as <hN> and is narrated like any sentence.
    let firstHeadingText = null;
    let hasOwnHeading = false;
    const paragraphs = [];
    for (const b of blocks) {
      const lvl = HEADING_LEVEL[b.tag];
      const sentences = splitSentences(b.text);
      if (sentences.length === 0) continue;
      if (lvl) {
        if (firstHeadingText === null) firstHeadingText = b.text;
        hasOwnHeading = true;
        paragraphs.push({ heading: lvl, sentences });
      } else {
        paragraphs.push({ sentences });
      }
    }
    if (paragraphs.length === 0) continue; // e.g. a pure cover/image page

    // Title is metadata only: the TOC's name for this file, then a heading inside it.
    const title = navTitles.get(href) || firstHeadingText || null;
    // Fallback: a chapter with no heading of its own but a known title gets a
    // synthesized leading heading so every chapter has a visible, spoken header.
    // A chapter that already has its own heading is NOT given one (no duplication).
    if (!hasOwnHeading && title) {
      paragraphs.unshift({ heading: 2, sentences: splitSentences(title) });
    }
    chapters.push({ title, paragraphs });
  }

  return { title: parsed.title, chapters };
}

const EXT_BY_MIME = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/svg+xml': 'svg',
};

/** Extract the cover image bytes from an EPUB buffer, or null if none. */
async function coverImage(buffer) {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const containerFile = zip.file('META-INF/container.xml');
    if (!containerFile) return null;
    const opfPath = findOpfPath(await containerFile.async('string'));
    const opfFile = zip.file(opfPath);
    if (!opfFile) return null;
    const opfXml = await opfFile.async('string');
    const parsed = parseOpf(opfXml, opfPath);
    if (!parsed.coverId) return null;
    const $ = cheerio.load(opfXml, { xmlMode: true });
    const opfDir = dirOf(opfPath);
    let href = null, mime = '';
    $('manifest item').each((_, el) => {
      if ($(el).attr('id') === parsed.coverId) {
        href = resolveHref($(el).attr('href') || '', opfDir);
        mime = $(el).attr('media-type') || '';
      }
    });
    if (!href) return null;
    const f = zip.file(href);
    if (!f) return null;
    const bytes = await f.async('nodebuffer');
    const ext = EXT_BY_MIME[mime] || (href.split('.').pop() || 'img').toLowerCase();
    return { bytes, ext };
  } catch { return null; } // a missing/odd cover must never break add
}

module.exports = {
  findOpfPath,
  parseOpf,
  parseToc,
  readingOrder,
  htmlToBlocks,
  resolveHref,
  parseEpub,
  coverImage,
};

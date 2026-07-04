'use strict';

// Renderer logic for Phase 1.5: load an EPUB, render ONE chapter at a time into
// the addressable reading view, paginate it with a CSS multi-column flow, and
// drive chapter navigation, fonts, and comfort controls. No voice yet — the
// Phase 2 seams (highlightSentence / goToPageContaining) are documented below.

const stage = document.getElementById('stage');
const viewport = document.getElementById('reading-viewport');
const readingEl = document.getElementById('reading');
const emptyState = document.getElementById('empty-state');
const dropOverlay = document.getElementById('drop-overlay');
const bottomBar = document.getElementById('bottom-bar');
const orientationEl = document.getElementById('orientation');
const tocPanel = document.getElementById('toc-panel');
const tocOverlay = document.getElementById('toc-overlay');
const tocList = document.getElementById('toc-list');
const rootStyle = document.documentElement.style;

// --- Reading state --------------------------------------------------------
const state = {
  doc: null,
  fileName: null,
  ci: 0,           // current chapter index (into doc.chapters)
  page: 0,         // current page/spread within the chapter
  pageCount: 1,
  font: null,      // null => default serif stack; otherwise a bundled family name
  geom: { colWidth: 0, gap: 48, per: 1 }, // last computed geometry, for flip math
  player: null,    // Phase 2: the per-book narrator (ReaderPlayer)
  // Phase 2.5 — global voice/playback settings (persisted in settings.json):
  voice: 'af_heart',          // curated Kokoro voice id
  speed: 1,                   // reading-speed multiplier (Kokoro `speed`)
  endChapterPause: 'off',     // 'off' | 'short' | 'longer' — rest beat when crossing a chapter
  currentBookId: null,        // Phase 3: open book's library id (for progress saves)
  // Expressive GPU voice (optional, global — same persistence model as voice/speed above):
  ttsEngine: 'kokoro',         // 'kokoro' | 'expressive'
  expressiveVoice: 'Axel.wav', // server predefined_voice_id (filename), OR a clone reference filename
  expressiveVoiceMode: 'predefined', // 'predefined' | 'clone' — which list expressiveVoice came from
  exaggeration: 0.5,
  cfgWeight: 0.3,
  temperature: 0.75,
  speedFactor: 1.0,
  myVoices: [], // BYO-reference clone voices fetched from the server on panel-open (filenames)
  // Local display-name aliases for My Voices (filename -> friendly name). The server has no
  // rename endpoint, so renaming is a Reader-side label only; the underlying reference filename
  // (the synth id) is unchanged. Persisted globally.
  expressiveVoiceNames: {},
  // Voice Engine auto-launch (Windows-only): the folder containing python_embedded\python.exe
  // + start.py, persisted after the one-time folder-picker prompt. null until located.
  voiceEngineDir: null,
  // Global "sounds-like" pronunciation overrides { lowercasedWord: respelling }. Applied at synth
  // time in main (display text unchanged). Persisted in settings.json.
  pronunciations: {},
};

// End-of-chapter pause presets → milliseconds. endChapterPauseMs() is injected into
// the player and read LIVE each chapter crossing, so a change applies on the next one.
const PAUSE_MS = { off: 0, short: 1500, longer: 4000 };
function endChapterPauseMs() { return PAUSE_MS[state.endChapterPause] ?? 0; }

// Bundled, OFL-licensed reading fonts (files under assets/fonts/, declared in
// fonts.css). `family` matches the @font-face font-family.
const FONTS = [
  { label: 'Inter', family: 'Inter', fallback: 'sans-serif' },
  { label: 'Atkinson Hyperlegible', family: 'Atkinson Hyperlegible', fallback: 'sans-serif' },
  { label: 'Source Sans 3', family: 'Source Sans 3', fallback: 'sans-serif' },
  { label: 'Literata', family: 'Literata', fallback: 'serif' },
  { label: 'Lora', family: 'Lora', fallback: 'serif' },
  { label: 'Bitter', family: 'Bitter', fallback: 'serif' },
];

const P = window.ReaderPaginate;
const currentView = () => document.body.dataset.view;
const colsPerPage = () => (currentView() === 'two' ? 2 : 1);

// --- Loading a book -------------------------------------------------------

// Build the per-call synth opts from live state. Kokoro: unchanged shape. Expressive: adds
// `engine` + the server voice/params on top of voice/speed (so main's Kokoro fallback still
// has them if the server is unreachable). Read live (not captured) so a setting change takes
// effect on the very next synth call via reload() — no player rebuild needed.
function synthOpts() {
  if (state.ttsEngine === 'expressive') {
    return {
      voice: state.voice,
      speed: state.speed,
      engine: 'expressive',
      expressiveVoice: state.expressiveVoice,
      expressiveVoiceMode: state.expressiveVoiceMode,
      exaggeration: state.exaggeration,
      cfgWeight: state.cfgWeight,
      temperature: state.temperature,
      speedFactor: state.speedFactor,
      pronunciations: state.pronunciations,
    };
  }
  return { voice: state.voice, speed: state.speed, pronunciations: state.pronunciations };
}

function showDocument(doc, fileName) {
  document.title = doc.title ? `${doc.title} — Reader` : 'Reader';
  state.doc = doc;
  state.fileName = fileName || null;
  state.ci = 0;
  state.page = 0;
  // Keep the parsed document around — Phase 2 reads sentences from here.
  window.__readerDoc = { doc, fileName: fileName || null };

  emptyState.hidden = true;
  viewport.hidden = false;
  bottomBar.hidden = false;

  buildTOC();
  renderChapter(state.ci);
  paginate();

  // Phase 2: build the narrator for this book. The injected synth wraps
  // reader.synthesize so a failed sentence logs (was a silent dead-end) while
  // still rejecting so the player's catch leaves the highlight in place.
  state.player = ReaderPlayer.createPlayer({
    doc,
    // Read engine/voice/speed/params LIVE at call time (via synthOpts()) so a setting
    // change takes effect via the player's reload() (flush + restart) without rebuilding it.
    synth: (text) => window.reader.synthesize(text, synthOpts())
      .catch((e) => {
        console.warn('[Reader] synth failed:', e);
        throw e;
      }),
    makeClip,
    view: ReaderView,
    // Prefetch a deep cushion of upcoming clips. Kokoro (CPU) runs ~0.4x realtime and never
    // needs this, but the expressive GPU engine has slower + variable per-sentence latency, so a
    // deeper buffer rides over a slow (long) sentence without an audible gap between clips. Harmless
    // for Kokoro (its utilityProcess just queues them). The server processes concurrent requests
    // serially, so the buffer fills during the short sentences and cushions the long ones.
    prefetchAhead: 8,
    prefetchBehind: 1,  // keep the prior sentence warm so back-a-sentence is instant
    maxClips: 64,       // retain enough decoded clips for the deeper prefetch + rewind targets
    onStateChange: updatePlayButton, // keep #play-pause in sync (esp. auto-stop at book end)
    endChapterPauseMs,               // live: rest beat when narration crosses into a new chapter
  });
  updatePlayButton();
}

function renderChapter(ci) {
  readingEl.style.transform = 'none';
  state.page = 0;
  readingEl.innerHTML = window.ReaderRender.renderChapterHTML(state.doc.chapters[ci], ci);
  viewport.scrollTop = 0;
}

// --- Library shell (Phase 3) ----------------------------------------------

// Progress tracking: capture at every sentence show, debounce disk writes, flush on stop/quit.
let progressTimer = null;
let pendingAddr = null;

function recordProgress(addr) {
  if (!state.currentBookId) return;
  pendingAddr = addr;
  clearTimeout(progressTimer);
  progressTimer = setTimeout(flushProgress, 1500);
}
function flushProgress() {
  clearTimeout(progressTimer);
  if (!state.currentBookId || !pendingAddr) return;
  window.reader.libraryUpdateProgress(state.currentBookId, pendingAddr)
    .catch((e) => console.warn('[Reader] progress save failed:', e));
}

async function showLibrary() {
  if (state.player) state.player.pause();
  flushProgress();
  pendingAddr = null;                 // clear cross-book contamination (advisor note)
  clearTimeout(progressTimer);
  state.currentBookId = null;
  // Show the library screen immediately with an empty shelf so the UI responds
  // right away — on boot the main process may take a moment to serve the IPC.
  await ReaderLibrary.render([], [], { onOpen: openFromLibrary, onRemove: removeFromLibrary });
  ReaderLibrary.show();
  // Populate with real books once the IPC resolves.
  try {
    const { active, finished } = await window.reader.libraryShelf();
    // Guard: if the user opened a book while the IPC was in flight (drop on boot,
    // or very fast click), don't clobber the reader state.
    if (document.body.dataset.screen !== 'library') return;
    await ReaderLibrary.render(active, finished, { onOpen: openFromLibrary, onRemove: removeFromLibrary });
  } catch (e) {
    console.warn('[Reader] shelf load failed:', e);
  }
}

async function openFromLibrary(rec) {
  // Clear any stale pending progress before setting the new book (cross-book guard).
  pendingAddr = null;
  clearTimeout(progressTimer);
  const { doc, progress } = await window.reader.libraryOpen(rec.id);
  state.currentBookId = rec.id;
  ReaderLibrary.hide();
  showDocument(doc, rec.fileName);
  const start = progress || ReaderCursor.firstAddress(doc);
  if (start && state.player) {
    state.player.showAt(start);
    if (document.fonts && document.fonts.ready) {
      try { await document.fonts.ready; } catch (_) {}
      state.player.showAt(start); // re-flip to correct page with real metrics
    }
  }
}

async function removeFromLibrary(rec) {
  if (!window.confirm(`Remove "${rec.title}" from your library?`)) return;
  await window.reader.libraryRemove(rec.id);
  await showLibrary();
}

async function addAndOpen(bytes, fileName) {
  try {
    const rec = await window.reader.libraryAdd(bytes, fileName);
    await openFromLibrary(rec);
  } catch (err) {
    // Show error on the library empty card (not the reader empty-state which is hidden).
    const el = document.getElementById('library-empty');
    if (el) {
      el.innerHTML = '<h1>Couldn\'t open that file</h1><p>It may not be a valid EPUB. Try another book.</p>';
      el.hidden = false;
    } else {
      reportError(err);
    }
  }
}

function reportError(err) {
  console.error('[Reader] failed to open book:', err);
  emptyState.querySelector('.empty-card').innerHTML =
    '<h1>Couldn\'t open that file</h1><p>It may not be a valid EPUB. ' +
    'Try another book.</p>';
  emptyState.hidden = false;
  viewport.hidden = true;
  bottomBar.hidden = true;
}

// --- Pagination engine ----------------------------------------------------
// Layout-only: a single chapter is laid out as a tall multi-column flow that
// overflows horizontally; each page is one column the width of the reading area
// (two columns in two-page mode). Flipping is a translateX of #reading. The DOM
// — every sentence span — is never restructured (the sacred contract).

function readGap() {
  const v = parseFloat(getComputedStyle(document.body).getPropertyValue('--page-gap'));
  return Number.isFinite(v) ? v : 48;
}

function paginate() {
  if (!state.doc || viewport.hidden) return;

  if (currentView() === 'continuous') {
    // One bounded, vertically scrolling column — no horizontal pages.
    readingEl.style.transform = '';
    readingEl.style.columnWidth = '';
    state.pageCount = 1;
    state.page = 0;
    updateOrientation();
    return;
  }

  const per = colsPerPage();
  const gap = readGap();
  const vw = readingEl.clientWidth; // padding-free element => exact content width
  const colWidth = Math.max(1, (vw - gap * (per - 1)) / per);

  readingEl.style.columnWidth = `${colWidth}px`;
  // Force layout so scrollWidth reflects the new column geometry.
  const scrollWidth = readingEl.scrollWidth;

  state.geom = { colWidth, gap, per };
  state.pageCount = P.pageCount(scrollWidth, colWidth, gap, per);
  state.page = P.clampPage(state.page, state.pageCount);
  applyTransform();
  updateOrientation();
}

function applyTransform() {
  const { colWidth, gap, per } = state.geom;
  const x = P.pageOffset(state.page, colWidth, gap, per);
  readingEl.style.transform = `translateX(${x}px)`;
}

// Flip by `delta` pages; rolling past a chapter's end/start carries into the
// neighbouring chapter (AC#1).
function flipPage(delta) {
  if (!state.doc || currentView() === 'continuous') return;
  const target = state.page + delta;
  if (target < 0) {
    if (state.ci > 0) goToChapter(state.ci - 1, { toEnd: true });
    return;
  }
  if (target >= state.pageCount) {
    if (state.ci < state.doc.chapters.length - 1) goToChapter(state.ci + 1, { toEnd: false });
    return;
  }
  state.page = target;
  applyTransform();
  updateOrientation();
}

function goToChapter(ci, opts = {}) {
  if (!state.doc) return;
  const clamped = Math.max(0, Math.min(ci, state.doc.chapters.length - 1));
  state.ci = clamped;
  renderChapter(clamped);
  paginate();
  if (opts.toEnd) {
    if (currentView() === 'continuous') {
      viewport.scrollTop = viewport.scrollHeight;
    } else {
      state.page = state.pageCount - 1;
      applyTransform();
      updateOrientation();
    }
  }
  updateTOCHighlight();
}

function updateOrientation() {
  if (!state.doc) return;
  const total = state.doc.chapters.length;
  let txt = `Chapter ${state.ci + 1} of ${total}`;
  if (currentView() !== 'continuous') {
    txt += ` · Page ${state.page + 1} / ${state.pageCount}`;
  }
  orientationEl.textContent = txt;

  document.getElementById('prev-chapter').disabled = state.ci <= 0;
  document.getElementById('next-chapter').disabled = state.ci >= total - 1;
  const paged = currentView() !== 'continuous';
  document.getElementById('prev-page').disabled = !paged || (state.page <= 0 && state.ci <= 0);
  document.getElementById('next-page').disabled =
    !paged || (state.page >= state.pageCount - 1 && state.ci >= total - 1);
}

// --- Chapter table of contents -------------------------------------------

function chapterLabel(chapter, idx) {
  const t = chapter.title && chapter.title.trim();
  if (t) return t;
  return idx === 0 ? 'Front matter' : 'Untitled';
}

function buildTOC() {
  tocList.innerHTML = '';
  state.doc.chapters.forEach((chapter, idx) => {
    const li = document.createElement('li');
    li.textContent = chapterLabel(chapter, idx);
    li.dataset.chapter = String(idx);
    li.addEventListener('click', () => {
      goToChapter(idx);
      closeTOC();
    });
    tocList.appendChild(li);
  });
  updateTOCHighlight();
}

function updateTOCHighlight() {
  for (const li of tocList.children) {
    li.classList.toggle('current', Number(li.dataset.chapter) === state.ci);
  }
}

function openTOC() {
  tocOverlay.hidden = false;
  tocPanel.hidden = false;
  // next frame so the transition runs from the off-screen state
  requestAnimationFrame(() => tocPanel.classList.add('open'));
}
function closeTOC() {
  tocPanel.classList.remove('open');
  tocOverlay.hidden = true;
  // hide after the slide-out so it isn't tab-focusable while open=false
  setTimeout(() => { if (!tocPanel.classList.contains('open')) tocPanel.hidden = true; }, 220);
}
function toggleTOC() {
  if (tocPanel.classList.contains('open')) closeTOC();
  else openTOC();
}

document.getElementById('toc-btn').addEventListener('click', toggleTOC);
tocOverlay.addEventListener('click', closeTOC);

// --- Bottom strip + chapter skip -----------------------------------------

document.getElementById('prev-page').addEventListener('click', () => flipPage(-1));
document.getElementById('next-page').addEventListener('click', () => flipPage(1));
document.getElementById('prev-chapter').addEventListener('click', () => goToChapter(state.ci - 1));
document.getElementById('next-chapter').addEventListener('click', () => goToChapter(state.ci + 1));

// --- Keyboard -------------------------------------------------------------
// ←/→ and PageUp/PageDown flip pages; Home/End jump chapter start/end;
// [ / ] previous/next chapter; t toggles the TOC; Esc closes it.
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (tocPanel.classList.contains('open')) { closeTOC(); e.preventDefault(); }
    if (!comfortPanel.hidden || !voicePanel.hidden) { closePopovers(); e.preventDefault(); }
    return;
  }
  // don't hijack typing in inputs
  if (e.target instanceof HTMLInputElement) return;

  switch (e.key) {
    case 'ArrowLeft':
    case 'PageUp':
      scrollOrFlip(-1); e.preventDefault(); break;
    case 'ArrowRight':
    case 'PageDown':
      scrollOrFlip(1); e.preventDefault(); break;
    case 'Home':
      jumpChapterEdge(false); e.preventDefault(); break;
    case 'End':
      jumpChapterEdge(true); e.preventDefault(); break;
    case '[':
      goToChapter(state.ci - 1); e.preventDefault(); break;
    case ']':
      goToChapter(state.ci + 1); e.preventDefault(); break;
    case 't':
    case 'T':
      toggleTOC(); e.preventDefault(); break;
    case ' ':
    case 'Spacebar':
      // Space = play/pause. resumeAudio() runs first (autoplay-policy gesture).
      if (P2()) { resumeAudio().then(() => { P2().toggle(); updatePlayButton(); }); }
      e.preventDefault(); break;
    default: break;
  }
});

// In paged modes the arrows flip pages; in scroll mode they nudge the column.
function scrollOrFlip(dir) {
  if (!state.doc) return;
  if (currentView() === 'continuous') {
    viewport.scrollBy({ top: dir * viewport.clientHeight * 0.9, behavior: 'smooth' });
  } else {
    flipPage(dir);
  }
}
function jumpChapterEdge(toEnd) {
  if (!state.doc) return;
  if (currentView() === 'continuous') {
    viewport.scrollTo({ top: toEnd ? viewport.scrollHeight : 0 });
  } else {
    state.page = toEnd ? state.pageCount - 1 : 0;
    applyTransform();
    updateOrientation();
  }
}

// --- Add button + drag-and-drop ------------------------------------------

document.getElementById('add-btn').addEventListener('click', async () => {
  const picked = await window.reader.pickFileBytes();
  if (picked) addAndOpen(new Uint8Array(picked.bytes), picked.fileName);
});

// Critical: preventDefault on dragover/drop, or Electron navigates the window
// to the dropped file and the whole UI disappears.
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  dropOverlay.hidden = false;
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', (e) => {
  e.preventDefault();
  if (--dragDepth <= 0) {
    dragDepth = 0;
    dropOverlay.hidden = true;
  }
});
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.hidden = true;

  const file = e.dataTransfer && e.dataTransfer.files[0];
  if (!file) return;
  const buf = await file.arrayBuffer();
  addAndOpen(new Uint8Array(buf), file.name);
});

// --- View modes -----------------------------------------------------------

document.getElementById('view-toggle').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]');
  if (!btn) return;
  setView(btn.dataset.view);
  saveSettings();
});

function setView(view) {
  document.body.dataset.view = view;
  for (const b of document.querySelectorAll('#view-toggle button')) {
    b.classList.toggle('active', b.dataset.view === view);
  }
  // Re-layout for the new mode (column geometry / scroll differ).
  paginate();
}

// --- Comfort controls -----------------------------------------------------

// Two mutually-exclusive popovers: "Aa" → Comfort (look), "Voice" → Voice (sound).
// Opening one closes the other; clicking the same button again toggles it closed.
const comfortPanel = document.getElementById('comfort-panel');
const voicePanel = document.getElementById('voice-panel');
function openOnly(panel) {
  for (const p of [comfortPanel, voicePanel]) p.hidden = (p !== panel) ? true : !p.hidden;
}
function closePopovers() { comfortPanel.hidden = true; voicePanel.hidden = true; }
document.getElementById('settings-btn').addEventListener('click', () => openOnly(comfortPanel));
document.getElementById('voice-btn').addEventListener('click', () => openOnly(voicePanel));
// An outside click closes both; clicks on the panels or their buttons don't (guard).
document.addEventListener('click', (e) => {
  if (e.target.closest('#comfort-panel,#voice-panel,#settings-btn,#voice-btn')) return;
  closePopovers();
});

function setFontSize(px) {
  const next = Math.min(40, Math.max(14, px));
  rootStyle.setProperty('--reading-font-size', `${next}px`);
  return next;
}
function currentFontSize() {
  return parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--reading-font-size')
  );
}
function adjustFont(deltaPx) {
  setFontSize(currentFontSize() + deltaPx);
  paginate();   // metrics changed -> page breaks move
  saveSettings();
}
document.getElementById('font-larger').addEventListener('click', () => adjustFont(2));
document.getElementById('font-smaller').addEventListener('click', () => adjustFont(-2));

document.getElementById('theme-toggle').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-theme]');
  if (!btn) return;
  setTheme(btn.dataset.theme);
  saveSettings();
});
function setTheme(theme) {
  document.body.dataset.theme = theme;
  for (const b of document.querySelectorAll('#theme-toggle button')) {
    b.classList.toggle('active', b.dataset.theme === theme);
  }
}

const widthRange = document.getElementById('width-range');
widthRange.addEventListener('input', (e) => {
  rootStyle.setProperty('--reading-max-width', `${e.target.value}rem`);
  paginate();   // page-width change -> re-paginate
});
widthRange.addEventListener('change', saveSettings);

// --- Font picker ----------------------------------------------------------

const fontList = document.getElementById('font-list');
function buildFontList() {
  fontList.innerHTML = '';
  // The default (serif stack) entry first, then the bundled families.
  const entries = [{ label: 'Default (serif)', family: null, fallback: 'serif' }, ...FONTS];
  for (const f of entries) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = f.label;
    btn.dataset.family = f.family || '';
    if (f.family) btn.style.fontFamily = `"${f.family}", ${f.fallback}`;
    btn.addEventListener('click', () => applyFont(f.family, f.fallback));
    fontList.appendChild(btn);
  }
  markActiveFont();
}
function markActiveFont() {
  for (const b of fontList.children) {
    b.classList.toggle('active', (b.dataset.family || null) === (state.font || null));
  }
}
async function applyFont(family, fallback) {
  state.font = family || null;
  if (family) {
    rootStyle.setProperty('--reading-font', `"${family}", ${fallback || 'serif'}`);
  } else {
    rootStyle.removeProperty('--reading-font'); // back to the :root serif stack
  }
  markActiveFont();
  // Wait for the webfont's real metrics before measuring pages, or the first
  // pagination runs against fallback metrics and the page count is wrong.
  if (family && document.fonts) {
    try { await document.fonts.load(`1em "${family}"`); } catch (_) { /* offline-safe */ }
  }
  paginate();
  saveSettings();
}

// --- Voice picker + reading speed + end-of-chapter pause -------------------
// Curated best English voices, grouped US/UK × male/female. Every `id` is verified
// present in the installed kokoro-js voices (28 total; these are the standouts).
// Curated English (US/UK) voices, best-first within each group. `top: true` marks
// the A/B-grade standouts with a ★ in the picker. Grades are Kokoro's (VOICES.md);
// every id must exist in node_modules/kokoro-js/voices/*.bin (asserted in a test).
// D/F-grade voices are deliberately excluded. All 54 voices ship bundled — adding a
// row is the whole cost (cache/preview/persistence are already per-voice).
const VOICES = [
  { group: 'US · Female', items: [
    { id: 'af_heart',    label: 'Heart',    top: true },
    { id: 'af_bella',    label: 'Bella',    top: true },
    { id: 'af_nicole',   label: 'Nicole',   top: true },
    { id: 'af_aoede',    label: 'Aoede' },
    { id: 'af_kore',     label: 'Kore' },
    { id: 'af_sarah',    label: 'Sarah' },
    { id: 'af_nova',     label: 'Nova' },
    { id: 'af_alloy',    label: 'Alloy' },
    { id: 'af_jessica',  label: 'Jessica' },
    { id: 'af_river',    label: 'River' },
    { id: 'af_sky',      label: 'Sky' },
  ] },
  { group: 'US · Male', items: [
    { id: 'am_michael',  label: 'Michael' },
    { id: 'am_fenrir',   label: 'Fenrir' },
    { id: 'am_puck',     label: 'Puck' },
  ] },
  { group: 'UK · Female', items: [
    { id: 'bf_emma',     label: 'Emma',     top: true },
    { id: 'bf_isabella', label: 'Isabella' },
    { id: 'bf_alice',    label: 'Alice' },
    { id: 'bf_lily',     label: 'Lily' },
  ] },
  { group: 'UK · Male', items: [
    { id: 'bm_george',   label: 'George' },
    { id: 'bm_fable',    label: 'Fable' },
    { id: 'bm_lewis',    label: 'Lewis' },
    { id: 'bm_daniel',   label: 'Daniel' },
  ] },
];
const SAMPLE_TEXT = 'The quick brown fox jumps over the lazy dog.';

const voiceListEl = document.getElementById('voice-list');
function buildVoiceList() {
  voiceListEl.innerHTML = '';
  for (const grp of VOICES) {
    const h = document.createElement('div');
    h.className = 'voice-group';
    h.textContent = grp.group;
    voiceListEl.appendChild(h);
    for (const v of grp.items) {
      const row = document.createElement('div');
      row.className = 'voice-row';
      const fullLabel = `${v.label} — ${grp.group}`; // accent/gender for screen readers
      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'voice-pick';
      pick.dataset.voice = v.id;
      if (v.top) pick.classList.add('voice-top');
      pick.textContent = v.top ? `★ ${v.label}` : v.label;
      pick.setAttribute('aria-label', v.top ? `${fullLabel} (recommended)` : fullLabel);
      pick.addEventListener('click', () => { setVoice(v.id); markActiveVoice(); });
      const prev = document.createElement('button');
      prev.type = 'button';
      prev.className = 'voice-preview';
      prev.title = 'Preview';
      prev.setAttribute('aria-label', `Preview ${fullLabel}`);
      prev.textContent = '▶';
      prev.addEventListener('click', (e) => { e.stopPropagation(); previewVoice(v.id); });
      row.append(pick, prev);
      voiceListEl.appendChild(row);
    }
  }
  markActiveVoice();
}
function markActiveVoice() {
  for (const b of voiceListEl.querySelectorAll('.voice-pick')) {
    b.classList.toggle('active', b.dataset.voice === state.voice);
  }
}

// All 28 server (Chatterbox-class) voices, grouped Male/Female — all US English (user
// confirmed by ear 2026-07-01; no accent sub-grouping yet). `id` is the server filename
// (predefined_voice_id), mirroring the Kokoro VOICES array above.
const EXPRESSIVE_VOICES = [
  { group: 'Female', items: [
    'Abigail', 'Alice', 'Cora', 'Elena', 'Emily', 'Gianna', 'Jade', 'Layla', 'Olivia', 'Taylor',
  ].map((n) => ({ id: `${n}.wav`, label: n })) },
  { group: 'Male', items: [
    'Adrian', 'Alexander', 'Austin', 'Axel', 'Connor', 'Eli', 'Everett', 'Gabriel', 'Henry', 'Ian',
    'Jeremiah', 'Jordan', 'Julian', 'Leonardo', 'Michael', 'Miles', 'Ryan', 'Thomas',
  ].map((n) => ({ id: `${n}.wav`, label: n })) },
];

const expressiveVoiceListEl = document.getElementById('expressive-voice-list');

// One row for one voice, shared by both the "My Voices" (clone) and predefined groups —
// only the click handlers' `mode` differs. `top`/preview button are predefined-only bits
// folded in via optional args so the clone rows stay simple (no ▶ preview for v1).
function makeVoiceRow(id, label, fullLabel, mode, { withPreview } = {}) {
  const row = document.createElement('div');
  row.className = 'voice-row';
  const pick = document.createElement('button');
  pick.type = 'button';
  pick.className = 'voice-pick';
  pick.dataset.voice = id;
  pick.dataset.voiceMode = mode;
  pick.textContent = label;
  pick.setAttribute('aria-label', fullLabel);
  pick.addEventListener('click', () => { setExpressiveVoice(id, mode); markActiveExpressiveVoice(); });
  row.append(pick);
  if (withPreview) {
    const prev = document.createElement('button');
    prev.type = 'button';
    prev.className = 'voice-preview';
    prev.title = 'Preview';
    prev.setAttribute('aria-label', `Preview ${fullLabel}`);
    prev.textContent = '▶';
    prev.addEventListener('click', (e) => { e.stopPropagation(); previewExpressiveVoice(id, mode); });
    row.appendChild(prev);
  }
  return row;
}

// Predefined voices are a static list (unchanged DOM shape/selectors — smoke drives
// `#expressive-voice-list button.voice-pick[data-voice="Alice.wav"]` directly).
function buildExpressiveVoiceList() {
  expressiveVoiceListEl.innerHTML = '';
  renderMyVoicesGroup(); // "My Voices" + "＋ Add a voice" always sits above the predefined list
  for (const grp of EXPRESSIVE_VOICES) {
    const h = document.createElement('div');
    h.className = 'voice-group';
    h.textContent = grp.group;
    expressiveVoiceListEl.appendChild(h);
    for (const v of grp.items) {
      const fullLabel = `${v.label} — ${grp.group}`;
      expressiveVoiceListEl.appendChild(
        makeVoiceRow(v.id, v.label, fullLabel, 'predefined', { withPreview: true })
      );
    }
  }
  markActiveExpressiveVoice();
}
function markActiveExpressiveVoice() {
  for (const b of expressiveVoiceListEl.querySelectorAll('.voice-pick')) {
    b.classList.toggle(
      'active',
      b.dataset.voice === state.expressiveVoice && b.dataset.voiceMode === state.expressiveVoiceMode
    );
  }
}

// --- BYO-reference voice cloning: "My Voices" group + "＋ Add a voice" ------------------
// Reader-LOCAL and upload-only: My Voices lists only the clips the user uploaded THROUGH Reader
// (persisted in settings as `expressiveMyVoices`). Reader never queries the server's
// reference_audio/ dir, so any other clones on the server stay invisible until explicitly added
// here — an intentional curation boundary (user decision 2026-07-01).
// A My Voices row's display label: the user's local alias if set, else the filename with the
// extension dropped and underscores/hyphens shown as spaces (matches the server's own display
// convention, and lets long names wrap at spaces instead of overflowing). The underlying
// filename (the synth id) is unchanged — only the label differs.
function myVoiceLabel(filename) {
  const alias = state.expressiveVoiceNames && state.expressiveVoiceNames[filename];
  if (alias && alias.trim()) return alias.trim();
  return filename.replace(/\.(wav|mp3)$/i, '').replace(/[_-]+/g, ' ');
}
function renderMyVoicesGroup() {
  const h = document.createElement('div');
  h.className = 'voice-group';
  h.textContent = 'My Voices';
  expressiveVoiceListEl.appendChild(h);
  for (const filename of state.myVoices) {
    const label = myVoiceLabel(filename);
    const row = makeVoiceRow(filename, label, `${label} — My Voices`, 'clone');
    // ✎ rename: a Reader-side display alias (no server rename endpoint). Sits alongside the pick.
    const ren = document.createElement('button');
    ren.type = 'button';
    ren.className = 'voice-rename';
    ren.title = 'Rename';
    ren.setAttribute('aria-label', `Rename ${label}`);
    ren.textContent = '✎';
    ren.addEventListener('click', (e) => { e.stopPropagation(); openRenameVoicePopover(filename); });
    row.appendChild(ren);
    // ✕ remove: drops the voice from Reader's local list only (the clip stays on the server —
    // upload-only, no server delete). Lets the user clear a bad entry and re-add it.
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'voice-remove';
    rm.title = 'Remove from My Voices';
    rm.setAttribute('aria-label', `Remove ${label} from My Voices`);
    rm.textContent = '✕';
    rm.addEventListener('click', (e) => {
      e.stopPropagation();
      state.myVoices = state.myVoices.filter((f) => f !== filename);
      delete state.expressiveVoiceNames[filename];
      if (state.expressiveVoiceMode === 'clone' && state.expressiveVoice === filename) {
        setExpressiveVoice('Axel.wav', 'predefined'); // deselect a removed voice → safe default
      } else {
        saveSettings();
      }
      buildExpressiveVoiceList();
    });
    row.appendChild(rm);
    expressiveVoiceListEl.appendChild(row);
  }
  const addRow = document.createElement('div');
  addRow.className = 'voice-row';
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.id = 'add-voice-btn';
  addBtn.className = 'voice-add';
  addBtn.textContent = '＋ Add a voice';
  addBtn.addEventListener('click', openAddVoicePopover);
  addRow.appendChild(addBtn);
  expressiveVoiceListEl.appendChild(addRow);
}

// Inline "name it" popover for the Add-a-voice flow. window.prompt() is NOT usable in
// Electron (throws) — this is a small inline text input instead, mirroring the rest of
// the app's popover pattern. One at a time: closes if already open.
let addVoicePopoverEl = null;
function closeAddVoicePopover() {
  if (addVoicePopoverEl) { addVoicePopoverEl.remove(); addVoicePopoverEl = null; }
}
function openAddVoicePopover() {
  closeAddVoicePopover();
  const wrap = document.createElement('div');
  wrap.className = 'add-voice-popover';
  wrap.innerHTML = `
    <p class="add-voice-hint">Only add voices you have permission to use.</p>
    <p class="add-voice-hint">Best result: ~10–20s of clean, single-speaker speech.</p>
    <p class="add-voice-hint">To remove a voice, delete its file on the Voice Engine server (no in-app remove yet).</p>
    <input type="text" class="add-voice-name" placeholder="Name this voice" maxlength="60" />
    <div class="add-voice-actions">
      <button type="button" class="add-voice-pick">Choose file…</button>
      <button type="button" class="add-voice-cancel">Cancel</button>
    </div>
    <p class="add-voice-status" hidden></p>
  `;
  const nameInput = wrap.querySelector('.add-voice-name');
  const statusEl = wrap.querySelector('.add-voice-status');
  const setStatus = (msg, isError) => {
    statusEl.hidden = !msg;
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('is-error', !!isError);
  };
  wrap.querySelector('.add-voice-cancel').addEventListener('click', closeAddVoicePopover);
  wrap.querySelector('.add-voice-pick').addEventListener('click', async () => {
    if (!window.reader || !window.reader.pickAudioBytes) return;
    try {
      const picked = await window.reader.pickAudioBytes();
      if (!picked) return; // user cancelled the dialog
      const typedName = nameInput.value.trim();
      const ext = (picked.fileName.match(/\.[^.]+$/) || ['.wav'])[0];
      // Sanitize the display name into a safe filename the server will store and Reader
      // will later select/synthesize with as reference_audio_filename.
      const safeName = (typedName || picked.fileName.replace(/\.[^.]+$/, ''))
        .replace(/[^A-Za-z0-9 _-]/g, '').trim() || 'my-voice';
      const uploadName = `${safeName}${ext}`;
      setStatus('Uploading…', false);
      const res = await window.reader.expressiveUploadReference(picked.bytes, uploadName);
      // Use the filename the SERVER actually saved (it sanitizes spaces->underscores etc.) — the
      // name we sent may differ, and selecting the wrong name 404s on the server -> Kokoro fallback.
      const savedName = (res && res.savedName) || uploadName;
      // Upload-only + local: record the voice in Reader's own persisted list (dedup), then
      // re-render and select it. Reader never re-reads the server folder to discover voices.
      if (!state.myVoices.includes(savedName)) state.myVoices.push(savedName);
      // If the user typed a friendlier display name, keep it as a local alias on the saved file.
      if (typedName && typedName !== savedName.replace(/\.(wav|mp3)$/i, '')) {
        state.expressiveVoiceNames[savedName] = typedName;
      }
      buildExpressiveVoiceList();
      setExpressiveVoice(savedName, 'clone'); // persists myVoices + selection via saveSettings
      markActiveExpressiveVoice();
      closeAddVoicePopover();
    } catch (e) {
      console.warn('[Reader] add-voice failed:', e);
      setStatus(e && e.message ? `Couldn't add: ${e.message}` : 'Could not add this voice — check the server.', true);
    }
  });
  expressiveSectionEl.appendChild(wrap);
  addVoicePopoverEl = wrap;
  nameInput.focus();
}

// Rename a My Voices entry — a Reader-side display alias only (no server rename endpoint), so
// the underlying reference filename / synth id is untouched. Blank name clears the alias
// (reverts to the filename). Reuses the add-voice popover slot (one popover at a time).
function openRenameVoicePopover(filename) {
  closeAddVoicePopover();
  const current = myVoiceLabel(filename);
  const wrap = document.createElement('div');
  wrap.className = 'add-voice-popover';
  wrap.innerHTML = `
    <p class="add-voice-hint">Rename this voice (display name only — the clip on the server is unchanged).</p>
    <input type="text" class="add-voice-name" maxlength="60" />
    <div class="add-voice-actions">
      <button type="button" class="add-voice-save">Save</button>
      <button type="button" class="add-voice-cancel">Cancel</button>
    </div>
  `;
  const nameInput = wrap.querySelector('.add-voice-name');
  nameInput.value = current;
  const save = () => {
    const typed = nameInput.value.trim();
    if (typed) state.expressiveVoiceNames[filename] = typed;
    else delete state.expressiveVoiceNames[filename]; // blank → revert to the filename
    saveSettings();
    closeAddVoicePopover();
    buildExpressiveVoiceList(); // re-render with the new label; keeps the active mark
  };
  wrap.querySelector('.add-voice-cancel').addEventListener('click', closeAddVoicePopover);
  wrap.querySelector('.add-voice-save').addEventListener('click', save);
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  expressiveSectionEl.appendChild(wrap);
  addVoicePopoverEl = wrap;
  nameInput.focus();
  nameInput.select();
}

// ▶ preview: play a short sample in the given voice. Ducks narration first (the
// user resumes manually) and is one-shot — it never touches the player's state.
let previewClip = null;
async function previewVoice(voiceId) {
  if (state.player && state.player.isPlaying()) state.player.pause(); // duck narration
  updatePlayButton();
  await resumeAudio();
  try {
    if (previewClip) previewClip.stop();
    const { wav, sampleRate } = await window.reader.synthesize(SAMPLE_TEXT, { voice: voiceId, speed: state.speed });
    previewClip = await makeClip(wav, sampleRate);
    previewClip.play(() => {});
  } catch (e) { console.warn('[Reader] voice preview failed:', e); }
}

// ▶ preview for an expressive voice: same duck/one-shot pattern, but posts through the
// expressive engine with the CURRENT sliders so the preview matches what play will sound like.
// `mode` defaults to 'predefined' (the only mode with a ▶ button in v1 — My Voices rows are
// built without `withPreview`, but this stays mode-aware so it never mis-shapes a clone request).
async function previewExpressiveVoice(voiceId, mode = 'predefined') {
  if (state.player && state.player.isPlaying()) state.player.pause(); // duck narration
  updatePlayButton();
  await resumeAudio();
  try {
    if (previewClip) previewClip.stop();
    const { wav, sampleRate } = await window.reader.synthesize(SAMPLE_TEXT, {
      engine: 'expressive',
      expressiveVoice: voiceId,
      expressiveVoiceMode: mode,
      voice: state.voice,
      speed: state.speed,
      exaggeration: state.exaggeration,
      cfgWeight: state.cfgWeight,
      temperature: state.temperature,
      speedFactor: state.speedFactor,
    });
    previewClip = await makeClip(wav, sampleRate);
    previewClip.play(() => {});
  } catch (e) { console.warn('[Reader] expressive voice preview failed:', e); }
}

// Speed slider: track the live label on every drag tick (`input`), but only apply
// (one restart) on release (`change`) so a drag isn't a storm of re-synths.
const speedRange = document.getElementById('speed-range');
const speedLabel = document.getElementById('speed-label');
function fmtSpeed(x) { return `${(+x).toFixed(2).replace(/0$/, '')}×`; }
speedRange.addEventListener('input', () => { speedLabel.textContent = fmtSpeed(speedRange.value); });
speedRange.addEventListener('change', () => setSpeed(+speedRange.value));

document.getElementById('pause-toggle').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-pause]');
  if (!btn) return;
  setEndChapterPause(btn.dataset.pause);
  for (const b of document.querySelectorAll('#pause-toggle button')) b.classList.toggle('active', b === btn);
});

// --- Engine toggle (Offline Kokoro <-> Expressive GPU) + generation sliders ---

const engineToggleEl = document.getElementById('engine-toggle');
const engineHintEl = document.getElementById('engine-hint');
const kokoroSectionEl = document.getElementById('kokoro-voice-section');
const expressiveSectionEl = document.getElementById('expressive-voice-section');

function showEngineSection(engine) {
  kokoroSectionEl.hidden = engine === 'expressive';
  expressiveSectionEl.hidden = engine !== 'expressive';
  for (const b of engineToggleEl.querySelectorAll('button[data-engine]')) {
    b.classList.toggle('active', b.dataset.engine === engine);
  }
}

engineToggleEl.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-engine]');
  if (!btn || btn.disabled) return;
  setEngine(btn.dataset.engine, { prompt: true }); // a real click: OK to pop the locate dialog
});

// On Voice-panel open, probe the expressive server so a dead server disables the segment
// with a hint instead of letting the user pick a backend that will just fall back silently.
// My Voices is Reader-local (upload-only), so panel-open only needs the reachability probe —
// there's no server list to fetch.
document.getElementById('voice-btn').addEventListener('click', () => {
  checkExpressiveHealth();
});
async function checkExpressiveHealth() {
  const expressiveBtn = engineToggleEl.querySelector('button[data-engine="expressive"]');
  if (!window.reader || !window.reader.expressiveHealth) return;
  // Where Reader can auto-launch the engine (Windows), the toggle must stay CLICKABLE even when
  // the server is down — that click is what starts it (locate → spawn). Only disable when there
  // is no path to bring it up (non-Windows + server down).
  const canAutoLaunch = !!(window.reader && window.reader.canAutoLaunchEngine);
  try {
    const { ok } = await window.reader.expressiveHealth();
    expressiveBtn.disabled = !ok && !canAutoLaunch;
    engineHintEl.hidden = ok;
    if (!ok && canAutoLaunch) engineHintEl.textContent = 'Click Expressive to start the Voice Engine.';
  } catch (_) {
    expressiveBtn.disabled = !canAutoLaunch;
    engineHintEl.hidden = false;
    if (canAutoLaunch) engineHintEl.textContent = 'Click Expressive to start the Voice Engine.';
  }
}

// --- Voice Engine auto-launch (Windows-only) --------------------------------------------
// Switching to Expressive (or restoring a persisted Expressive engine at boot) ensures the
// optional Chatterbox server is up: reuse if already running, else spawn it (Windows-only,
// needs a configured voiceEngineDir) and wait for readiness. `prompt` gates whether a locate
// (folder-picker) dialog may be shown on 'no-dir' -- ONLY a real user click on the engine
// toggle sets prompt:true. The __test_setEngine seam and boot restore both pass prompt:false,
// so neither ever pops a native dialog with no user gesture behind it (that would block the
// window with nothing to dismiss it -- see the smoke's restart-persistence check, which
// restores ttsEngine='expressive' with voiceEngineDir unset).
async function ensureVoiceEngineForExpressive({ prompt }) {
  if (!window.reader || !window.reader.engineEnsureRunning) return;
  const setHint = (text, show) => {
    engineHintEl.textContent = text || 'Start the Voice Engine to use this option.';
    engineHintEl.hidden = !show;
  };
  setHint('Starting Voice Engine…', true);
  try {
    let result = await window.reader.engineEnsureRunning(undefined, state.voiceEngineDir);
    let cancelled = false;
    if (!result.ok && result.reason === 'no-dir' && prompt && window.reader.engineLocate) {
      const dir = await window.reader.engineLocate();
      if (dir) {
        state.voiceEngineDir = dir;
        saveSettings();
        setHint('Starting Voice Engine…', true);
        result = await window.reader.engineEnsureRunning(undefined, state.voiceEngineDir);
      } else {
        cancelled = true; // user dismissed the folder picker
      }
    }
    if (result.ok) {
      // Persist the folder Reader used (auto-detected or reused) so it's remembered next time.
      if (result.dir && result.dir !== state.voiceEngineDir) {
        state.voiceEngineDir = result.dir;
        saveSettings();
      }
      setHint('', false);
      checkExpressiveHealth();
    } else if (cancelled) {
      // Plan-locked UX: declining to locate the folder reverts to Kokoro (never leaves a
      // persisted dead-Expressive state) -- prompt:false so this revert itself can't re-open
      // the picker (setEngine('kokoro') never calls ensureVoiceEngineForExpressive anyway).
      setEngine('kokoro', { prompt: false });
      setHint('Start the Voice Engine to use this option.', true);
    } else {
      // Never break narration: leave Kokoro usable and show a gentle explanation. The engine
      // toggle itself is unaffected -- the user can flip back to Kokoro or retry later.
      setHint(
        result.reason === 'no-dir'
          ? 'Locate your Voice Engine folder to use this option.'
          : "Couldn't start the Voice Engine.",
        true,
      );
    }
  } catch (_) {
    setHint("Couldn't start the Voice Engine.", true);
  }
}

// Four Chatterbox generation sliders: track the live label on every drag tick (`input`), but
// only apply (state + reload + save) on release (`change`) — same rule the speed slider follows,
// so a drag isn't a storm of re-synths.
function fmtParam(x) { return (+x).toFixed(2); }
function wireParamSlider(rangeId, labelId, setter) {
  const range = document.getElementById(rangeId);
  const label = document.getElementById(labelId);
  range.addEventListener('input', () => { label.textContent = fmtParam(range.value); });
  range.addEventListener('change', () => setter(+range.value));
  return { range, label };
}
const exaggerationSlider = wireParamSlider('exaggeration-range', 'exaggeration-label', setExaggeration);
const cfgSlider = wireParamSlider('cfg-range', 'cfg-label', setCfgWeight);
const temperatureSlider = wireParamSlider('temperature-range', 'temperature-label', setTemperature);
const speedFactorSlider = wireParamSlider('speedfactor-range', 'speedfactor-label', setSpeedFactor);

// --- Persisted comfort settings (global only; wired to main in this phase) --

function gatherSettings() {
  return {
    font: state.font,
    theme: document.body.dataset.theme,
    textSize: currentFontSize(),
    pageWidth: parseFloat(widthRange.value),
    viewMode: document.body.dataset.view,
    voice: state.voice,
    speed: state.speed,
    endChapterPause: state.endChapterPause,
    ttsEngine: state.ttsEngine,
    expressiveVoice: state.expressiveVoice,
    expressiveVoiceMode: state.expressiveVoiceMode,
    exaggeration: state.exaggeration,
    cfgWeight: state.cfgWeight,
    temperature: state.temperature,
    speedFactor: state.speedFactor,
    expressiveMyVoices: state.myVoices,
    expressiveVoiceNames: state.expressiveVoiceNames,
    voiceEngineDir: state.voiceEngineDir,
    pronunciations: state.pronunciations,
  };
}

let saveTimer = null;
function saveSettings() {
  if (!window.reader || !window.reader.saveSettings) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    window.reader.saveSettings(gatherSettings()).catch((err) =>
      console.warn('[Reader] could not save settings:', err)
    );
  }, 250);
}

function applySettings(s) {
  if (!s || typeof s !== 'object') return;
  if (s.theme) setTheme(s.theme);
  if (Number.isFinite(s.textSize)) setFontSize(s.textSize);
  if (Number.isFinite(s.pageWidth)) {
    widthRange.value = String(s.pageWidth);
    rootStyle.setProperty('--reading-max-width', `${s.pageWidth}rem`);
  }
  if (s.viewMode) setView(s.viewMode);
  if ('font' in s) {
    const f = FONTS.find((x) => x.family === s.font);
    applyFont(s.font || null, f ? f.fallback : 'serif');
  }
  // Voice/speed/pause: set state + reflect the UI directly. NOT via setVoice/setSpeed —
  // those reload()+save, which would be a needless storm during a boot-time load (and
  // there's no player yet). The live synth closure reads state.voice/speed on first play.
  if (typeof s.voice === 'string') { state.voice = s.voice; markActiveVoice(); }
  if (Number.isFinite(s.speed)) {
    state.speed = s.speed;
    speedRange.value = String(s.speed);
    speedLabel.textContent = fmtSpeed(s.speed);
  }
  if (s.endChapterPause in PAUSE_MS) {
    state.endChapterPause = s.endChapterPause;
    for (const b of document.querySelectorAll('#pause-toggle button')) {
      b.classList.toggle('active', b.dataset.pause === s.endChapterPause);
    }
  }
  // Expressive GPU voice: same rule as voice/speed/pause above — set state + reflect the UI
  // directly, NOT via setEngine/setExpressiveVoice/setExaggeration/etc (they reload()+save,
  // a boot storm, and there's no player yet). The live synthOpts() closure reads state on
  // the first play.
  if (typeof s.expressiveVoice === 'string') {
    state.expressiveVoice = s.expressiveVoice;
    state.expressiveVoiceMode = (s.expressiveVoiceMode === 'clone') ? 'clone' : 'predefined';
    markActiveExpressiveVoice();
  }
  if (Number.isFinite(s.exaggeration)) {
    state.exaggeration = s.exaggeration;
    exaggerationSlider.range.value = String(s.exaggeration);
    exaggerationSlider.label.textContent = fmtParam(s.exaggeration);
  }
  if (Number.isFinite(s.cfgWeight)) {
    state.cfgWeight = s.cfgWeight;
    cfgSlider.range.value = String(s.cfgWeight);
    cfgSlider.label.textContent = fmtParam(s.cfgWeight);
  }
  if (Number.isFinite(s.temperature)) {
    state.temperature = s.temperature;
    temperatureSlider.range.value = String(s.temperature);
    temperatureSlider.label.textContent = fmtParam(s.temperature);
  }
  if (Number.isFinite(s.speedFactor)) {
    state.speedFactor = s.speedFactor;
    speedFactorSlider.range.value = String(s.speedFactor);
    speedFactorSlider.label.textContent = fmtParam(s.speedFactor);
  }
  // Restore the local My Voices list + aliases, then rebuild once so the restored clone voices
  // (upload-only, never re-fetched from the server) render with their friendly labels.
  if (Array.isArray(s.expressiveMyVoices)) {
    state.myVoices = s.expressiveMyVoices.filter((f) => typeof f === 'string');
  }
  if (s.expressiveVoiceNames && typeof s.expressiveVoiceNames === 'object') {
    state.expressiveVoiceNames = s.expressiveVoiceNames;
  }
  if (typeof s.voiceEngineDir === 'string') {
    state.voiceEngineDir = s.voiceEngineDir;
  }
  if (s.pronunciations && typeof s.pronunciations === 'object') {
    state.pronunciations = s.pronunciations;
  }
  buildExpressiveVoiceList();
  // Engine last, after voice/params are in state, so the visible section + toggle match
  // the restored engine right away (no reload — showEngineSection is CSS-only).
  if (s.ttsEngine === 'kokoro' || s.ttsEngine === 'expressive') {
    state.ttsEngine = s.ttsEngine;
    showEngineSection(state.ttsEngine);
    // Boot restore of a persisted Expressive engine: ensure the Voice Engine is up, same as a
    // live switch, but NEVER with a folder-picker prompt (prompt:false) -- a boot-time dialog
    // would block the window with no user gesture behind it (and would hang the smoke's
    // restart-persistence check, which restores ttsEngine='expressive' with no dir configured).
    if (state.ttsEngine === 'expressive') ensureVoiceEngineForExpressive({ prompt: false });
  }
}

async function loadSettings() {
  if (!window.reader || !window.reader.loadSettings) return;
  try {
    const s = await window.reader.loadSettings();
    if (s) applySettings(s);
  } catch (err) {
    console.warn('[Reader] could not load settings:', err);
  }
}

// --- Re-paginate on the things that move page breaks ----------------------

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(paginate, 150);
});
// Custom fonts load async; re-paginate once they're ready so the count is right.
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => { if (state.doc) paginate(); });
}

// --------------------------------------------------------------------------
// PHASE 2 SEAM — voice + sentence highlighting hooks in HERE.
//
// The reading view renders every sentence as:
//   <span class="sentence" data-chapter data-paragraph data-sentence>
// and window.__readerDoc.doc holds the parsed { title, chapters[] } with
// chapters[ci].paragraphs[pi].sentences[si] matching those data-* indices.
//
// IMPORTANT (Phase 1.5 change): only the CURRENT chapter is mounted at a time.
// So both seams below resolve spans within state.ci only. A Phase 2 cross-chapter
// highlight must first switch chapters (goToChapter(ci)) so the target span is in
// the DOM, THEN call highlightSentence / goToPageContaining.
// --------------------------------------------------------------------------

// Toggle the soft highlight on sentence (ci, pi, si) of the current chapter.
function highlightSentence(ci, pi, si) {
  for (const el of readingEl.querySelectorAll('.sentence.is-reading')) {
    el.classList.remove('is-reading');
  }
  const sel = `.sentence[data-chapter="${ci}"][data-paragraph="${pi}"][data-sentence="${si}"]`;
  const el = readingEl.querySelector(sel);
  if (el) el.classList.add('is-reading');
  return el;
}
window.highlightSentence = highlightSentence;

// PHASE 2 HOOK (not wired to anything yet): flip the paged view to the page that
// contains `sentenceEl`. Computes the span's horizontal offset within the column
// flow and converts it to a page index via the pagination math. In scroll mode it
// scrolls the span into view instead. Phase 2 will call this as each clip plays.
function goToPageContaining(sentenceEl) {
  if (!sentenceEl || !state.doc) return;
  if (currentView() === 'continuous') {
    sentenceEl.scrollIntoView({ block: 'center' });
    return;
  }
  const { colWidth, gap, per } = state.geom;
  const page = P.pageForOffset(sentenceEl.offsetLeft, colWidth, gap, per);
  state.page = P.clampPage(page, state.pageCount);
  applyTransform();
  updateOrientation();
}
window.goToPageContaining = goToPageContaining;

// --------------------------------------------------------------------------
// PHASE 2 — narration: Web Audio backend, the view adapter, and controls.
// --------------------------------------------------------------------------

// --- Audio playback backend (Web Audio; decodes WAV bytes from the engine) ---
let audioCtx = null;
function getAudioCtx() {
  return (audioCtx ||= new (window.AudioContext || window.webkitAudioContext)());
}
// An AudioContext starts `suspended` under the autoplay policy — the FIRST clip
// plays silently (no error!) unless resumed inside a user gesture. Call this from
// the play/click/space handlers (all real gestures).
async function resumeAudio() {
  const c = getAudioCtx();
  if (c.state === 'suspended') await c.resume();
}

// makeClip: WAV bytes -> a clip object the controller can play()/stop().
async function makeClip(wav, _sampleRate) {
  const ctx = getAudioCtx();
  // decodeAudioData wants an ArrayBuffer it can detach; copy out of the IPC view.
  const bytes = wav instanceof Uint8Array ? wav : new Uint8Array(wav);
  const buf = await ctx.decodeAudioData(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  );
  let src = null;
  return {
    play(onEnded) {
      src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.onended = () => onEnded();
      src.start();
    },
    stop() {
      if (src) { src.onended = null; try { src.stop(); } catch (_) {} src = null; }
    },
  };
}

// view.show(addr): make sentence (ci,pi,si) visible + highlighted, mounting its
// chapter first (only one chapter is mounted at a time — see app.js Phase 2 seam).
const ReaderView = {
  show(addr) {
    const { ci, pi, si } = addr;
    if (ci !== state.ci) goToChapter(ci);          // mount the target chapter first
    const el = highlightSentence(ci, pi, si);       // existing seam (toggles .is-reading)
    recordProgress(addr);                           // Phase 3: capture at every sentence advance
    if (!el) return;
    if (currentView() === 'continuous') scrollSentenceThreeQuarters(el);
    else goToPageContaining(el);                    // existing seam (flips to its page)
  },
};

// design.md §5: in scroll mode hold the highlighted line ~¾ up so the eyes rest.
function scrollSentenceThreeQuarters(el) {
  const vpRect = viewport.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  const target = viewport.scrollTop + (elRect.top - vpRect.top) - vpRect.height * 0.25;
  viewport.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
}

function updatePlayButton() {
  const btn = document.getElementById('play-pause');
  const on = !!(state.player && state.player.isPlaying());
  // CSS swaps the play-triangle / pause-bars SVGs off this class (no glyph writes,
  // which would clobber the inline <svg> children).
  btn.classList.toggle('is-playing', on);
  btn.setAttribute('aria-label', on ? 'Pause' : 'Play');
  if (!on) flushProgress(); // Phase 3: pause / book-end → persist immediately
}

// --- Apply-change helpers (wired to the UI in Task 4; also used by settings-load) ---
// Voice/speed changes restart the current sentence immediately via player.reload()
// (flush stale prefetch + replay). Pause only affects the NEXT chapter crossing, so
// it needs no reload. All three persist globally.
function setVoice(voiceId) {
  state.voice = voiceId || 'af_heart';
  if (state.player) state.player.reload(); // flush + restart current sentence in the new voice
  saveSettings();
}
function setSpeed(x) {
  state.speed = Math.min(1.5, Math.max(0.7, Number(x) || 1));
  if (state.player) state.player.reload(); // restart current sentence at the new speed
  saveSettings();
}
function setEndChapterPause(mode) {
  state.endChapterPause = (mode in PAUSE_MS) ? mode : 'off';
  // no reload — endChapterPauseMs() is read live on the next crossing
  saveSettings();
}

// Expressive GPU voice: engine switch, voice pick, and the four generation-param sliders.
// Same reload()+saveSettings() pattern as setVoice/setSpeed above — the live synthOpts()
// closure reads state on the next synth call. `opts.prompt` (default true, a real click) gates
// whether ensureVoiceEngineForExpressive may pop the locate dialog on 'no-dir' -- see its
// comment. The section is shown/hidden SYNCHRONOUSLY before the (async, Windows-only) engine
// ensure-running call, so callers never block on a health probe just to see the right panel.
function setEngine(engine, opts) {
  const prompt = !opts || opts.prompt !== false;
  state.ttsEngine = (engine === 'expressive') ? 'expressive' : 'kokoro';
  showEngineSection(state.ttsEngine);
  if (state.player) state.player.reload();
  saveSettings();
  if (state.ttsEngine === 'expressive') ensureVoiceEngineForExpressive({ prompt });
}
// Test-only seam (mirrors window.highlightSentence/goToPageContaining above): lets the smoke
// suite drive an engine switch the way a restored persisted setting would, independent of the
// engine-toggle button's disabled state (which correctly blocks a real click when the
// expressive server is unreachable — see the panel-open health check). Always prompt:false
// (mirrors boot restore, NOT a real click) so it never pops the native locate dialog with no
// user gesture behind it -- the smoke drives this with voiceEngineDir unset.
window.__test_setEngine = (engine) => setEngine(engine, { prompt: false });
function setExpressiveVoice(voiceId, mode = 'predefined') {
  state.expressiveVoice = voiceId || 'Axel.wav';
  state.expressiveVoiceMode = mode === 'clone' ? 'clone' : 'predefined';
  if (state.player) state.player.reload();
  saveSettings();
}
function setExaggeration(x) {
  state.exaggeration = Math.min(1.5, Math.max(0.25, Number(x) || 0.5));
  if (state.player) state.player.reload();
  saveSettings();
}
function setCfgWeight(x) {
  state.cfgWeight = Math.min(1, Math.max(0, Number(x) || 0.3));
  if (state.player) state.player.reload();
  saveSettings();
}
function setTemperature(x) {
  state.temperature = Math.min(1, Math.max(0.5, Number(x) || 0.75));
  if (state.player) state.player.reload();
  saveSettings();
}
function setSpeedFactor(x) {
  state.speedFactor = Math.min(1.5, Math.max(0.5, Number(x) || 1.0));
  if (state.player) state.player.reload();
  saveSettings();
}

// --- Wire the playback controls + keyboard + click-to-play ----------------
const P2 = () => state.player;
document.getElementById('play-pause').addEventListener('click', async (e) => {
  await resumeAudio();
  P2()?.toggle();          // not awaited: `playing` flips synchronously, so the
  updatePlayButton();      // button updates instantly instead of after first decode
  // Drop focus so a subsequent Space flows only through the keydown handler (avoids
  // a focused-button native re-activation double-toggling play/pause).
  e.currentTarget.blur();
});
document.getElementById('library-btn').addEventListener('click', showLibrary);
document.getElementById('back-sent').addEventListener('click', () => P2()?.backSentence());
document.getElementById('fwd-sent').addEventListener('click', () => P2()?.forwardSentence());
document.getElementById('back-para').addEventListener('click', () => P2()?.backParagraph());

// Click a sentence to start reading there. Delegated on readingEl (survives the
// innerHTML swaps in renderChapter) so we attach exactly one listener.
readingEl.addEventListener('click', async (e) => {
  const span = e.target.closest('.sentence');
  if (!span || !P2()) return;
  await resumeAudio();
  P2().jumpTo({
    ci: +span.dataset.chapter,
    pi: +span.dataset.paragraph,
    si: +span.dataset.sentence,
  });
  updatePlayButton();
});

// Quit-flush: a debounced write can be in flight when the window closes.
// Use a synchronous IPC on beforeunload to guarantee the latest address persists.
window.addEventListener('beforeunload', () => {
  if (state.currentBookId && pendingAddr) {
    try { window.reader.libraryUpdateProgressSync(state.currentBookId, pendingAddr); } catch (_) {}
  }
});

// --- Boot -----------------------------------------------------------------
buildFontList();
buildVoiceList(); // before loadSettings() so applySettings' markActiveVoice has buttons
buildExpressiveVoiceList(); // before loadSettings() so applySettings' markActiveExpressiveVoice has buttons
loadSettings();
showLibrary().catch((e) => console.error('[Reader] boot showLibrary failed:', e)); // shelf is home (Phase 3)

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
    // Read voice+speed LIVE at call time so a setting change takes effect via the
    // player's reload() (flush + restart) without rebuilding the player.
    synth: (text) => window.reader.synthesize(text, { voice: state.voice, speed: state.speed })
      .catch((e) => {
        console.warn('[Reader] synth failed:', e);
        throw e;
      }),
    makeClip,
    view: ReaderView,
    prefetchAhead: 3,   // synth runs ~0.4x realtime, so 3 stays comfortably ahead during play
    prefetchBehind: 1,  // keep the prior sentence warm so back-a-sentence is instant
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

function reportError(err) {
  console.error('[Reader] failed to open book:', err);
  emptyState.querySelector('.empty-card').innerHTML =
    '<h1>Couldn’t open that file</h1><p>It may not be a valid EPUB. ' +
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
  try {
    const result = await window.reader.pickAndParse();
    if (result) showDocument(result.doc, result.fileName);
  } catch (err) {
    reportError(err);
  }
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
  try {
    const buf = await file.arrayBuffer();
    const doc = await window.reader.parseBuffer(new Uint8Array(buf));
    showDocument(doc, file.name);
  } catch (err) {
    reportError(err);
  }
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
const VOICES = [
  { group: 'US', items: [
    { id: 'af_heart',    label: 'Heart — US, female' },
    { id: 'af_bella',    label: 'Bella — US, female' },
    { id: 'am_michael',  label: 'Michael — US, male' },
    { id: 'am_fenrir',   label: 'Fenrir — US, male' },
  ] },
  { group: 'UK', items: [
    { id: 'bf_emma',     label: 'Emma — UK, female' },
    { id: 'bf_isabella', label: 'Isabella — UK, female' },
    { id: 'bm_george',   label: 'George — UK, male' },
    { id: 'bm_fable',    label: 'Fable — UK, male' },
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
      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'voice-pick';
      pick.dataset.voice = v.id;
      pick.textContent = v.label;
      pick.addEventListener('click', () => { setVoice(v.id); markActiveVoice(); });
      const prev = document.createElement('button');
      prev.type = 'button';
      prev.className = 'voice-preview';
      prev.title = 'Preview';
      prev.setAttribute('aria-label', `Preview ${v.label}`);
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

// --- Boot -----------------------------------------------------------------
buildFontList();
buildVoiceList(); // before loadSettings() so applySettings' markActiveVoice has buttons
loadSettings();

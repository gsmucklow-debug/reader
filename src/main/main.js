'use strict';

const { app, BrowserWindow, ipcMain, dialog, utilityProcess, Menu } = require('electron');
const fs = require('node:fs/promises');
const fssync = require('node:fs');
const path = require('node:path');
const { parseEpub } = require('../parse/epub');
const { makeCache } = require('./clip-cache');
const { normalizeTTS } = require('./tts-normalize');
const { makeLibrary } = require('./library');
const { synthesizeRemote, wavSampleRate } = require('./expressive-tts');

// SPIKE (2026-07-01): the optional expressive GPU voice. When READER_EXPRESSIVE_URL points at a
// running Chatterbox server, synth routes there (cached under the 'chatterbox' engine) and falls
// back to Kokoro on any failure. Unset → Reader is 100% the offline Kokoro default. Env-gated for
// the spike only; a Voice-panel toggle + companion installer are Phase 2 (if the by-ear gate passes).
const EXPRESSIVE_URL = process.env.READER_EXPRESSIVE_URL || null;
const EXPRESSIVE_VOICE = process.env.READER_EXPRESSIVE_VOICE || undefined; // a predefined_voice_id

let library = null;
function getLibrary() {
  return (library ||= makeLibrary(path.join(app.getPath('userData'), 'library')));
}

let mainWindow = null;
let clipCache = null; // lazily created after app is ready (needs userData path)

// --- TTS utilityProcess (the Kokoro engine runs in its own Node child) ---------
// Forked lazily on first synthesize/ping, kept alive for the app's lifetime so the
// model loads once. Requests are id-keyed so concurrent calls don't cross wires.
let ttsChild = null;
let ttsSeq = 0;
const ttsPending = new Map(); // id -> { resolve, reject }

function modelsDir() {
  // Packaged: resources/assets/models (assets ships via build.files). Dev: repo assets.
  return app.isPackaged
    ? path.join(process.resourcesPath, 'assets', 'models')
    : path.join(__dirname, '..', '..', 'assets', 'models');
}

function getTtsChild() {
  if (ttsChild) return ttsChild;
  ttsChild = utilityProcess.fork(path.join(__dirname, 'tts-service.js'), [], {
    env: { ...process.env, READER_MODELS_DIR: modelsDir() },
  });
  ttsChild.on('message', (msg) => {
    const p = ttsPending.get(msg.id);
    if (!p) return;
    ttsPending.delete(msg.id);
    if (msg.ok) p.resolve(msg);
    else p.reject(new Error(msg.error || 'TTS failed'));
  });
  ttsChild.on('exit', () => {
    ttsChild = null;
    for (const p of ttsPending.values()) p.reject(new Error('TTS process exited'));
    ttsPending.clear();
  });
  return ttsChild;
}

function ttsRequest(payload, timeoutMs = 60000) {
  const id = ++ttsSeq;
  return new Promise((resolve, reject) => {
    // Guards against a wedged child: if its async work never settles (a stalled
    // model load or a hung generate posts no reply and fires no 'exit'), the
    // pending entry would leak and the renderer's await would hang forever.
    // Generous default so a slow first cold-CPU load isn't false-tripped.
    const timer = setTimeout(() => {
      if (ttsPending.delete(id)) reject(new Error('TTS request timed out'));
    }, timeoutMs);
    ttsPending.set(id, {
      resolve: (m) => { clearTimeout(timer); resolve(m); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    getTtsChild().postMessage({ id, ...payload });
  });
}

// Global comfort settings live in a single JSON file in the OS app-data folder.
// This is NOT per-book memory or reading position (Phase 3) — only the few global
// fields: font, theme, textSize, pageWidth, viewMode, voice, speed, endChapterPause.
function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}
const SETTINGS_KEYS = ['font', 'theme', 'textSize', 'pageWidth', 'viewMode', 'voice', 'speed', 'endChapterPause'];

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: '#f4f1ea', // calm paper tone; avoids white flash on load
    title: 'Reader',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload uses require(); parsing stays in main regardless
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // A dropped file must never navigate the window away from the app.
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

// Parse raw EPUB bytes coming from a renderer drag-and-drop.
ipcMain.handle('parse-buffer', async (_evt, bytes) => {
  const buffer = Buffer.from(bytes);
  return parseEpub(buffer);
});

// Open a native file picker, read + parse the chosen EPUB.
ipcMain.handle('pick-and-parse', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Open a book',
    properties: ['openFile'],
    filters: [{ name: 'Books', extensions: ['epub', 'md', 'markdown', 'docx'] }],
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  const filePath = res.filePaths[0];
  const buffer = await fs.readFile(filePath);
  const doc = await parseEpub(buffer);
  return { doc, fileName: path.basename(filePath) };
});

// Load global comfort settings (returns null if none saved yet).
ipcMain.handle('load-settings', async () => {
  try {
    const raw = await fs.readFile(settingsPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null; // missing/corrupt file => start with defaults
  }
});

// Persist global comfort settings, whitelisting the known fields.
ipcMain.handle('save-settings', async (_evt, incoming) => {
  if (!incoming || typeof incoming !== 'object') return false;
  const clean = {};
  for (const k of SETTINGS_KEYS) {
    if (k in incoming) clean[k] = incoming[k];
  }
  await fs.writeFile(settingsPath(), JSON.stringify(clean, null, 2), 'utf8');
  return true;
});

// --- Library IPC (Phase 3) ------------------------------------------------

ipcMain.handle('library:list', async () => getLibrary().list());

// The shelf, pre-split into active/finished by the TESTED splitShelf (so the UI renders the
// same logic the unit tests cover, instead of re-deriving the split in the renderer).
ipcMain.handle('library:shelf', async () => {
  const { splitShelf } = require('./library');
  return splitShelf(await getLibrary().list());
});

ipcMain.handle('library:add', async (_evt, bytes, fileName) => {
  return getLibrary().add(Buffer.from(bytes), fileName);
});

ipcMain.handle('library:open', async (_evt, id) => getLibrary().open(id));

ipcMain.handle('library:remove', async (_evt, id) => getLibrary().remove(id));

ipcMain.handle('library:updateProgress', async (_evt, id, addr) =>
  getLibrary().updateProgress(id, addr));

// Cover bytes as a data: URL (CSP-safe under img-src 'self' data:). null if no cover.
ipcMain.handle('library:coverDataUrl', async (_evt, id, coverName) => {
  if (!coverName) return null;
  try {
    const p = path.join(app.getPath('userData'), 'library', 'books', id, coverName);
    const bytes = await fs.readFile(p);
    const mime = coverName.endsWith('.png') ? 'image/png'
      : coverName.endsWith('.svg') ? 'image/svg+xml'
      : coverName.endsWith('.gif') ? 'image/gif'
      : coverName.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
    return `data:${mime};base64,${bytes.toString('base64')}`;
  } catch { return null; }
});

// Synchronous progress flush for renderer 'beforeunload' (quit-flush race fix).
ipcMain.on('library:updateProgressSync', (evt, id, addr) => {
  evt.returnValue = getLibrary().updateProgressSync(id, addr);
});

// Native file picker returning raw bytes (so the add path can hash + store the original).
// Replaces pick-and-parse for the library flow (option (a): one add path via library:add).
ipcMain.handle('pick-file-bytes', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Open a book', properties: ['openFile'],
    filters: [{ name: 'Books', extensions: ['epub', 'md', 'markdown', 'docx'] }],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const fp = res.filePaths[0];
  return { bytes: await fs.readFile(fp), fileName: path.basename(fp) };
});

// Synthesize one sentence → { wav, sampleRate }, served from the on-disk clip cache
// when present. Preload sends ONE object { text, voice, speed }; keep that shape here.
// Each (voice, speed, text) caches independently (clipKey includes all three).
// res.wav is the typed array carried in the utilityProcess message; Electron
// structured-clones it across the renderer IPC boundary, so return it as-is.
ipcMain.handle('synthesize', async (_evt, { text, voice, speed }) => {
  voice = voice || 'af_heart';
  const normalized = normalizeTTS(text);
  clipCache ||= makeCache(path.join(app.getPath('userData'), 'clips'));

  // Optional expressive GPU backend (spike). Cache under the 'chatterbox' engine namespace so
  // its clips never collide with Kokoro's. ANY failure (server down, CUDA error, timeout) falls
  // through to the in-process Kokoro engine below — narration must never break.
  if (EXPRESSIVE_URL) {
    const cacheVoice = EXPRESSIVE_VOICE || 'default'; // stable key per chosen server voice
    const exHit = await clipCache.get(normalized, cacheVoice, speed, 'chatterbox');
    if (exHit) return { wav: exHit, sampleRate: wavSampleRate(exHit) };
    try {
      const out = await synthesizeRemote({ text: normalized, voice: EXPRESSIVE_VOICE, url: EXPRESSIVE_URL });
      await clipCache.put(normalized, cacheVoice, speed, out.wav, 'chatterbox');
      return { wav: out.wav, sampleRate: out.sampleRate };
    } catch (err) {
      console.warn('[expressive] falling back to Kokoro:', err && err.message);
      // fall through to Kokoro
    }
  }

  const hit = await clipCache.get(normalized, voice, speed);
  if (hit) return { wav: hit, sampleRate: 24000 }; // Kokoro is fixed 24 kHz
  const res = await ttsRequest({ type: 'synthesize', text: normalized, voice, speed });
  const bytes = res.wav;
  await clipCache.put(normalized, voice, speed, bytes);
  return { wav: bytes, sampleRate: res.sampleRate };
});

app.whenReady().then(() => {
  // Calm reading UI — no File/Edit/View/Window/Help bar. This drops the default
  // accelerators (nothing to copy/paste in a reader; the close button quits).
  // macOS gets a minimal app-menu (Quit) at the mac build — revisit then.
  Menu.setApplicationMenu(null);
  createWindow();
  ttsRequest({ type: 'ping' }).catch(() => {}); // model warm-up; ignore failures (offline-safe)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  if (ttsChild) ttsChild.kill();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

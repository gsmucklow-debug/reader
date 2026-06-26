'use strict';

const { app, BrowserWindow, ipcMain, dialog, utilityProcess } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { parseEpub } = require('../parse/epub');

let mainWindow = null;

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

function ttsRequest(payload) {
  const id = ++ttsSeq;
  return new Promise((resolve, reject) => {
    ttsPending.set(id, { resolve, reject });
    getTtsChild().postMessage({ id, ...payload });
  });
}

// Global comfort settings live in a single JSON file in the OS app-data folder.
// This is NOT per-book memory or reading position (Phase 3) — only the few
// global fields: font, theme, textSize, pageWidth, viewMode.
function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}
const SETTINGS_KEYS = ['font', 'theme', 'textSize', 'pageWidth', 'viewMode'];

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
    title: 'Open an EPUB',
    properties: ['openFile'],
    filters: [{ name: 'EPUB books', extensions: ['epub'] }],
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

// Synthesize one sentence → { wav, sampleRate }. (Task 3 adds the disk cache in
// front of this.) Preload sends ONE object { text, voice }; keep that shape here.
// res.wav is the typed array carried in the utilityProcess message; Electron
// structured-clones it across the renderer IPC boundary, so return it as-is.
ipcMain.handle('synthesize', async (_evt, { text, voice }) => {
  const res = await ttsRequest({ type: 'synthesize', text, voice });
  return { wav: res.wav, sampleRate: res.sampleRate };
});

app.whenReady().then(() => {
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

'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { parseEpub } = require('../parse/epub');

let mainWindow = null;

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

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

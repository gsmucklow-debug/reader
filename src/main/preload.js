'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Minimal, explicit surface exposed to the renderer. No Node, no ipcRenderer
// leaked directly — only these three calls.
contextBridge.exposeInMainWorld('reader', {
  // Open the native file picker; resolves to { doc, fileName } or null if cancelled.
  pickAndParse: () => ipcRenderer.invoke('pick-and-parse'),

  // Parse EPUB bytes from a drag-and-drop. `bytes` is a Uint8Array.
  parseBuffer: (bytes) => ipcRenderer.invoke('parse-buffer', bytes),

  // Global comfort settings (font/theme/textSize/pageWidth/viewMode).
  loadSettings: () => ipcRenderer.invoke('load-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  // Renderer calls reader.synthesize(text, { voice }); we send ONE object so the
  // main handler can destructure { text, voice } — keep this arg shape everywhere.
  synthesize: (text, opts) => ipcRenderer.invoke('synthesize', { text, ...(opts || {}) }),
});

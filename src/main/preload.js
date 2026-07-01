'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Minimal, explicit surface exposed to the renderer. No Node, no ipcRenderer
// leaked directly — only these calls.
contextBridge.exposeInMainWorld('reader', {
  // Open the native file picker; resolves to { doc, fileName } or null if cancelled.
  pickAndParse: () => ipcRenderer.invoke('pick-and-parse'),

  // Parse EPUB bytes from a drag-and-drop. `bytes` is a Uint8Array.
  parseBuffer: (bytes) => ipcRenderer.invoke('parse-buffer', bytes),

  // Global comfort settings (font/theme/textSize/pageWidth/viewMode).
  loadSettings: () => ipcRenderer.invoke('load-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  // Renderer calls reader.synthesize(text, { voice, speed }); we send ONE object so
  // the main handler can destructure { text, voice, speed } — keep this shape everywhere.
  // For the expressive engine, opts also carries { engine, expressiveVoice, exaggeration,
  // cfgWeight, temperature, speedFactor, serverUrl } — all forwarded as-is via the spread.
  synthesize: (text, opts) => ipcRenderer.invoke('synthesize', { text, ...(opts || {}) }),

  // Reachability probe for the optional expressive GPU server (Voice-panel engine toggle).
  expressiveHealth: (url) => ipcRenderer.invoke('expressive:health', url),

  // Library (Phase 3)
  libraryList: () => ipcRenderer.invoke('library:list'),
  libraryShelf: () => ipcRenderer.invoke('library:shelf'),
  libraryAdd: (bytes, fileName) => ipcRenderer.invoke('library:add', bytes, fileName),
  libraryOpen: (id) => ipcRenderer.invoke('library:open', id),
  libraryRemove: (id) => ipcRenderer.invoke('library:remove', id),
  libraryUpdateProgress: (id, addr) => ipcRenderer.invoke('library:updateProgress', id, addr),
  libraryCoverDataUrl: (id, coverName) => ipcRenderer.invoke('library:coverDataUrl', id, coverName),
  libraryUpdateProgressSync: (id, addr) => ipcRenderer.sendSync('library:updateProgressSync', id, addr),

  // File picker returning raw bytes (for library:add). Replaces pick-and-parse for the library flow.
  pickFileBytes: () => ipcRenderer.invoke('pick-file-bytes'),
});

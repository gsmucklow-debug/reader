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
  // For the expressive engine, opts also carries { engine, expressiveVoice, expressiveVoiceMode,
  // exaggeration, cfgWeight, temperature, speedFactor, serverUrl } — all forwarded as-is via the spread.
  // opts may also carry { pronunciations } — the global sounds-like map, applied in main before normalize/cache-key.
  synthesize: (text, opts) => ipcRenderer.invoke('synthesize', { text, ...(opts || {}) }),

  // Reachability probe for the optional expressive GPU server (Voice-panel engine toggle).
  expressiveHealth: (url) => ipcRenderer.invoke('expressive:health', url),

  // BYO-reference voice cloning: list uploaded reference clips ("My Voices"), and upload a
  // new one (bytes read in the renderer via pickAudioBytes; the multipart POST happens in
  // main so the renderer never touches the network directly).
  expressiveUploadReference: (bytes, fileName, url) =>
    ipcRenderer.invoke('expressive:uploadReference', bytes, fileName, url),

  // File picker for a reference audio clip (.wav/.mp3), for the "Add a voice" flow.
  pickAudioBytes: () => ipcRenderer.invoke('pick-audio-bytes'),

  // Voice Engine auto-launch (Windows-only): ensure the optional Chatterbox server is up
  // (reusing an already-running one, or spawning it), a one-time folder picker to locate it,
  // and a quick status probe.
  engineEnsureRunning: (url, dir) => ipcRenderer.invoke('engine:ensureRunning', url, dir),
  engineLocate: () => ipcRenderer.invoke('engine:locate'),
  engineStatus: (url) => ipcRenderer.invoke('engine:status', url),
  // True where Reader can spawn the Voice Engine itself (Windows only). The renderer uses this
  // to keep the Expressive toggle CLICKABLE when the server is down — clicking it auto-starts.
  canAutoLaunchEngine: process.platform === 'win32',

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

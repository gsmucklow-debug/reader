'use strict';

const { app, BrowserWindow, ipcMain, dialog, utilityProcess, Menu } = require('electron');
const fs = require('node:fs/promises');
const fssync = require('node:fs');
const path = require('node:path');
const { parseEpub } = require('../parse/epub');
const { makeCache } = require('./clip-cache');
const { normalizeTTS } = require('./tts-normalize');
const { makeLibrary } = require('./library');
const { synthesizeRemote, wavSampleRate, expressiveCacheVoice } = require('./expressive-tts');
const { mergeExpressiveParams } = require('./expressive-params');
const { spawn } = require('node:child_process');
const { engineCommand, validateEngineDir, pollUntilReady } = require('./voice-engine');

// The optional expressive GPU voice (Chatterbox-class server on localhost). Routing is
// opts-driven: the renderer sends `engine: 'expressive'` (+ params) per synthesize call, chosen
// via the Voice-panel engine toggle and persisted in settings.json. Kokoro stays the default —
// no engine (or any other value) falls straight through to the Kokoro path below. The env var
// survives only as a fallback URL / dev override, never as the routing trigger, so the default
// (no server, no env) smoke path is unaffected. Cached under the 'chatterbox' engine namespace
// (clip-cache.test.js pins this tag) and falls back to Kokoro on any failure.
const EXPRESSIVE_DEFAULT_URL = process.env.READER_EXPRESSIVE_URL || 'http://localhost:8004';

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
const SETTINGS_KEYS = [
  'font', 'theme', 'textSize', 'pageWidth', 'viewMode', 'voice', 'speed', 'endChapterPause',
  // Expressive GPU voice (opt-in, global — same persistence model as voice/speed above).
  'ttsEngine', 'expressiveVoice', 'exaggeration', 'cfgWeight', 'temperature', 'speedFactor',
  // BYO-reference voice cloning: which mode the persisted expressiveVoice was picked under,
  // so a persisted clone re-selects correctly (a predefined id and a clone filename could
  // otherwise collide on re-select).
  'expressiveVoiceMode',
  // Reader-local clone voices (upload-only; filenames) + their display-name aliases. Reader
  // never lists the server's reference dir — a voice exists here only if the user uploaded it.
  'expressiveMyVoices', 'expressiveVoiceNames',
  // Voice Engine auto-launch (Windows-only): the folder containing python_embedded\python.exe
  // + start.py. Persisted once picked via the folder-picker prompt; never hardcoded.
  'voiceEngineDir',
];

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
ipcMain.handle('synthesize', async (_evt, {
  text, voice, speed, engine, expressiveVoice, expressiveVoiceMode, exaggeration, cfgWeight, temperature, speedFactor, serverUrl,
}) => {
  voice = voice || 'af_heart';
  const normalized = normalizeTTS(text);
  clipCache ||= makeCache(path.join(app.getPath('userData'), 'clips'));

  // Optional expressive GPU backend. Routed purely on the renderer-sent `engine` flag (never
  // an env var) so a change of setting takes effect on the next call, and the default (no
  // engine) path never touches this branch. Cache under the 'chatterbox' engine namespace so
  // its clips never collide with Kokoro's. ANY failure (server down, CUDA error, timeout) falls
  // through to the in-process Kokoro engine below — narration must never break.
  if (engine === 'expressive') {
    const p = mergeExpressiveParams({ exaggeration, cfgWeight, temperature, speedFactor });
    const url = serverUrl || EXPRESSIVE_DEFAULT_URL;
    const mode = expressiveVoiceMode === 'clone' ? 'clone' : 'predefined';
    // The cache key must fold in mode + voice + every generation param (see expressiveCacheVoice
    // in expressive-tts.js, unit-tested) — speed is the Kokoro slider, unused here (Chatterbox
    // pacing is cfg_weight/speed_factor). Note: with temperature > 0 the server is
    // non-deterministic; we cache the first sample and reuse it for consistency.
    const cacheVoice = expressiveCacheVoice({ mode, voice: expressiveVoice, params: p });
    const exHit = await clipCache.get(normalized, cacheVoice, speed, 'chatterbox');
    if (exHit) return { wav: exHit, sampleRate: wavSampleRate(exHit) };
    // Crash-safety: don't send NEW GPU work while the engine is shutting down — that's how the
    // stop keeps the GPU idle before it kills the process. Fall through to Kokoro instead.
    // `inFlight` lets stopVoiceEngine() wait for an in-progress synth to finish before stopping.
    if (!voiceEngine.stopping) {
      voiceEngine.inFlight++;
      try {
        const out = await synthesizeRemote({ text: normalized, voice: expressiveVoice, mode, params: p, url });
        await clipCache.put(normalized, cacheVoice, speed, out.wav, 'chatterbox');
        return { wav: out.wav, sampleRate: out.sampleRate };
      } catch (err) {
        console.warn('[expressive] falling back to Kokoro:', err && err.message);
      } finally {
        voiceEngine.inFlight--;
      }
    }
    // fall through to Kokoro (server down/error, or engine stopping)
  }

  const hit = await clipCache.get(normalized, voice, speed);
  if (hit) return { wav: hit, sampleRate: 24000 }; // Kokoro is fixed 24 kHz
  const res = await ttsRequest({ type: 'synthesize', text: normalized, voice, speed });
  const bytes = res.wav;
  await clipCache.put(normalized, voice, speed, bytes);
  return { wav: bytes, sampleRate: res.sampleRate };
});

// Quick reachability probe for the optional expressive server, so the Voice panel can disable
// the Expressive engine option (with a hint) instead of letting the user pick a dead backend.
// Short timeout (~2s) since this runs on panel-open, on the UI thread's behalf. Also reused by
// the VoiceEngine manager below (both the reuse check and the readiness poll).
async function expressiveHealthCheck(url, timeoutMs = 2000) {
  const base = url || EXPRESSIVE_DEFAULT_URL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/get_predefined_voices`, { signal: controller.signal });
    return !!(res && res.ok);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

ipcMain.handle('expressive:health', async (_evt, url) => {
  return { ok: await expressiveHealthCheck(url, 2000) };
});

// --- Voice Engine lifecycle manager (Windows-only auto start/stop of the optional Chatterbox
// server) -------------------------------------------------------------------------------------
// Reader spawns `<voiceEngineDir>\python_embedded\python.exe start.py --portable` (cwd=dir,
// hidden) when the user switches to the Expressive engine and it isn't already reachable, and
// kills the process TREE on quit -- but ONLY if Reader itself started it (never a server the
// user already had running, e.g. via the Start Voice Engine.vbs or a terminal). See
// docs/plans/phase-voice-engine-autolaunch.md for the full design.
const voiceEngine = {
  child: null,        // the spawned ChildProcess, or null
  startedByUs: false,  // true only if WE spawned it (guards quit-time kill against hijacking)
  starting: null,      // in-flight ensureRunning() promise, for the concurrency guard
  inFlight: 0,         // count of expressive synth requests currently hitting the GPU
  stopping: false,     // true while we're shutting the engine down (block new GPU work)
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Health-check first (reuse a server the user already has running -- never kill it), else spawn
// (Windows-only, and only with a validated voiceEngineDir), then poll until ready (~60s).
// Concurrency-guarded: a rapid double-toggle returns the SAME in-flight promise rather than
// spawning twice.
function ensureVoiceEngineRunning(url, dir) {
  if (voiceEngine.starting) return voiceEngine.starting;
  voiceEngine.starting = (async () => {
    try {
      if (await expressiveHealthCheck(url, 2000)) {
        return { ok: true, external: true };
      }
      if (process.platform !== 'win32') {
        return { ok: false, reason: 'unsupported' };
      }
      if (!validateEngineDir(dir, fssync.existsSync)) {
        return { ok: false, reason: 'no-dir' };
      }
      const { exe, args, cwd } = engineCommand(dir);
      let child;
      try {
        child = spawn(exe, args, { cwd, windowsHide: true, stdio: 'ignore' });
      } catch (err) {
        return { ok: false, reason: 'start-failed' };
      }
      voiceEngine.child = child;
      voiceEngine.startedByUs = true;
      child.on('exit', () => {
        if (voiceEngine.child === child) {
          voiceEngine.child = null;
          voiceEngine.startedByUs = false;
        }
      });
      child.on('error', () => {
        if (voiceEngine.child === child) {
          voiceEngine.child = null;
          voiceEngine.startedByUs = false;
        }
      });

      const ready = await pollUntilReady({
        healthFn: () => expressiveHealthCheck(url, 2000),
        intervalMs: 1500,
        timeoutMs: 60000,
        sleepFn: sleep,
      });
      if (!ready) {
        await stopVoiceEngine();
        return { ok: false, reason: 'start-failed' };
      }
      return { ok: true, started: true };
    } finally {
      voiceEngine.starting = null;
    }
  })();
  return voiceEngine.starting;
}

// Stop the Voice Engine WE started, as GPU-safely as we can. The one real safety step is
// DRAIN-TO-IDLE: force-killing a CUDA process mid-kernel is what can wedge the driver; killing an
// IDLE one is safe (the driver reclaims the context on process death). So:
//   1. mark `stopping` -> the synth handler stops sending new GPU work (falls back to Kokoro)
//   2. wait for any in-flight synth to finish, so the GPU goes idle, then a brief settle
//   3. force-kill the tree. We DON'T try a no-/F "graceful" taskkill first: this process is
//      spawned windowless (windowsHide + stdio:'ignore'), so it has no window to receive the
//      WM_CLOSE a no-/F taskkill sends -- it'd survive and get /F'd anyway, only adding a quit
//      stall. `/T` kills the tree (start.py's child uvicorn is the actual :8004 listener).
// NOTE: this reduces the kill-mid-inference vector only. It does NOT make heavy inference on a
// bleeding-edge GPU/driver stack safe -- that's a current-driver + watched-run concern, not code.
// Idempotent: nulls `child` first, so a second call (e.g. before-quit racing) is a no-op.
async function stopVoiceEngine({ drainMs = 8000 } = {}) {
  const child = voiceEngine.child;
  const wasOurs = voiceEngine.startedByUs;
  voiceEngine.child = null;
  voiceEngine.startedByUs = false;
  if (!child || !child.pid || !wasOurs) return;
  voiceEngine.stopping = true;
  try {
    await pollUntilReady({
      healthFn: () => voiceEngine.inFlight === 0, intervalMs: 200, timeoutMs: drainMs, sleepFn: sleep,
    });
    await sleep(300); // brief settle so the last CUDA kernel has fully returned before we terminate
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
  } finally {
    voiceEngine.stopping = false;
  }
}

ipcMain.handle('engine:ensureRunning', async (_evt, url, dir) => {
  return ensureVoiceEngineRunning(url, dir);
});

ipcMain.handle('engine:locate', async () => {
  if (process.platform !== 'win32') return null;
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Locate your Voice Engine folder', properties: ['openDirectory'],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const dir = res.filePaths[0];
  if (!validateEngineDir(dir, fssync.existsSync)) return null;
  return dir;
});

ipcMain.handle('engine:status', async (_evt, url) => {
  const running = await expressiveHealthCheck(url, 2000);
  return { running, startedByUs: voiceEngine.startedByUs };
});

// (No reference-listing IPC: My Voices is Reader-local and upload-only — Reader never queries
// the server's reference_audio/ dir. See the add flow + `expressiveMyVoices` in the renderer.)

// Proxy the multipart reference upload — the renderer reads the picked file to bytes and never
// touches the network itself (mirrors library:add). Field name 'file' per the server contract.
// Any failure (server down, bad file, network) surfaces as a rejected promise with a short
// message the renderer can show gently; it must never crash the app.
ipcMain.handle('expressive:uploadReference', async (_evt, bytes, fileName, url) => {
  const base = url || EXPRESSIVE_DEFAULT_URL;
  try {
    const fd = new FormData();
    // Field name is 'files' (plural) — the server's /upload_reference takes a list (FastAPI
    // `files: List[UploadFile]`); 'file' 422s with "field required: files".
    fd.append('files', new Blob([Buffer.from(bytes)]), fileName);
    const res = await fetch(`${base.replace(/\/$/, '')}/upload_reference`, { method: 'POST', body: fd });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`upload failed (${res.status}): ${detail.slice(0, 200)}`);
    }
    return { ok: true };
  } catch (err) {
    throw new Error(err && err.message ? err.message : 'reference upload failed');
  }
});

// Native file picker for a reference audio clip (.wav/.mp3), returning raw bytes — the
// add-a-voice counterpart to pick-file-bytes (which is book-format-filtered).
ipcMain.handle('pick-audio-bytes', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Add a reference voice', properties: ['openFile'],
    filters: [{ name: 'Audio', extensions: ['wav', 'mp3'] }],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const fp = res.filePaths[0];
  return { bytes: await fs.readFile(fp), fileName: path.basename(fp) };
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

// Stop the Voice Engine on quit -- but ONLY if Reader itself started it (never a server the user
// already had running). The stop is async (drain-to-idle → graceful → escalate), which quit won't
// await on its own, so we defer the quit until the stop finishes: preventDefault once, run the
// GPU-safe stop, then quit for real. Capped windows so quit is never hung more than a few seconds.
let engineQuitCleanup = false;
app.on('before-quit', (e) => {
  if (engineQuitCleanup) return;                       // second pass: let the real quit proceed
  if (!(voiceEngine.startedByUs && voiceEngine.child)) return;
  e.preventDefault();
  engineQuitCleanup = true;
  stopVoiceEngine({ drainMs: 4000 }).finally(() => app.quit());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

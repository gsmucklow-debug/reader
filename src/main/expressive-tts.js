'use strict';
// Alternate TTS backend: an expressive GPU voice (Chatterbox-class) running in a SEPARATE
// local process that exposes an HTTP endpoint on localhost. This is the opt-in counterpart to
// the in-process Kokoro engine in tts-service.js — Reader itself never touches Python/CUDA/GPU;
// it just POSTs a sentence and gets WAV bytes back. For the spike we target the off-the-shelf
// devnen/Chatterbox-TTS-Server `/tts` endpoint (predefined-voice mode). Whole-clip per sentence
// (no streaming) — the one-clip-per-sentence design invariant is preserved.
//
// `fetchImpl` is injected so this edge is unit-testable with a fake (mirroring how audio/IPC
// are the injected edges elsewhere). In the app it defaults to the global fetch.

async function synthesizeRemote({ text, voice, mode, params, url, timeoutMs = 60000, fetchImpl }) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (!doFetch) throw new Error('no fetch available for expressive TTS');
  const p = params || {};
  // 'clone' is the BYO-reference path (voice is a reference_audio_filename uploaded via
  // /upload_reference); anything else (including omitted) is the existing predefined-voice
  // path, so old callers (and the smoke path) are byte-for-byte unaffected.
  const isClone = mode === 'clone';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(`${url.replace(/\/$/, '')}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        // Predefined-voice mode: `voice` is a predefined_voice_id (a .wav filename from the
        // server's voices/ dir). Undefined → the server uses its own default voice. Clone mode:
        // `voice` is a reference_audio_filename (a user-uploaded reference clip's filename).
        voice_mode: isClone ? 'clone' : 'predefined',
        ...(isClone
          ? { reference_audio_filename: voice || undefined }
          : { predefined_voice_id: voice || undefined }),
        output_format: 'wav',
        split_text: false, // Reader already sends one sentence; don't let the server re-chunk.
        stream: false,     // whole clip back in one response (design invariant)
        // Generation params (Chatterbox levers). Only send the ones provided so the server
        // falls back to its own config.yaml defaults for anything omitted. cfg_weight is the
        // natural pacing control (lower = slower); speed_factor is a post time-stretch (keep 1).
        ...(p.exaggeration != null && { exaggeration: p.exaggeration }),
        ...(p.cfgWeight != null && { cfg_weight: p.cfgWeight }),
        ...(p.temperature != null && { temperature: p.temperature }),
        ...(p.speedFactor != null && { speed_factor: p.speedFactor }),
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`expressive TTS ${res.status}: ${detail.slice(0, 200)}`);
    }
    const wav = new Uint8Array(await res.arrayBuffer());
    return { wav, sampleRate: wavSampleRate(wav) };
  } finally {
    clearTimeout(timer);
  }
}

// Read the sample rate out of a RIFF/WAVE header (bytes 24..27, little-endian). The renderer
// decodes via decodeAudioData (which reads the header itself), so this is informational, but
// returning the true rate keeps the contract honest across engines. Falls back to 24000.
function wavSampleRate(bytes) {
  try {
    if (bytes.length >= 28
      && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) { // "RIFF"
      return bytes[24] | (bytes[25] << 8) | (bytes[26] << 16) | (bytes[27] << 24);
    }
  } catch { /* fall through */ }
  return 24000;
}

// Build the clip-cache "voice" key for the expressive engine: folds in the mode ('predefined'
// | 'clone') alongside the voice id + every generation param, so (a) changing any knob, or
// flipping predefined<->clone, re-synthesizes rather than serving a stale clip, and (b) a
// predefined_voice_id and a cloned reference_audio_filename that happen to share a name can
// never collide on the same cache entry. Pulled out of main.js (which can't be require()'d
// directly — it's the Electron app entry) so this is unit-testable, mirroring the
// expressive-params.js "extracted for testability" pattern.
function expressiveCacheVoice({ mode, voice, params }) {
  const m = mode === 'clone' ? 'clone' : 'predefined';
  const p = params || {};
  return `${m}:${voice || 'default'} e${p.exaggeration} c${p.cfgWeight} t${p.temperature} s${p.speedFactor}`;
}

module.exports = { synthesizeRemote, wavSampleRate, expressiveCacheVoice };

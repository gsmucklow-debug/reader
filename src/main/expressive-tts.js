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

async function synthesizeRemote({ text, voice, url, timeoutMs = 60000, fetchImpl }) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (!doFetch) throw new Error('no fetch available for expressive TTS');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(`${url.replace(/\/$/, '')}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        // Curated-voice mode: `voice` is a predefined_voice_id (a .wav filename from the
        // server's voices/ dir). Undefined → the server uses its own default voice.
        voice_mode: 'predefined',
        predefined_voice_id: voice || undefined,
        output_format: 'wav',
        split_text: false, // Reader already sends one sentence; don't let the server re-chunk.
        stream: false,     // whole clip back in one response (design invariant)
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

module.exports = { synthesizeRemote, wavSampleRate };

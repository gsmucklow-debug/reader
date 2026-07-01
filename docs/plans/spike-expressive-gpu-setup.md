# Spike — Standing up the Chatterbox GPU voice server (Windows / RTX 5070 Ti)

> **Goal of the spike:** hear Chatterbox narrate *your own drafts* through Reader and decide,
> by ear, whether it's clearly better than Kokoro. If yes → we build the companion installer.
> If no → we stop and keep Kokoro. Design: [`2026-07-01-expressive-gpu-voice-design.md`](./2026-07-01-expressive-gpu-voice-design.md).
>
> This is a **dev-time spike**, not the shipped experience. You'll run the server by hand and
> launch Reader in dev mode with one env var. The polished, double-clickable companion app is
> Phase 2, only if the gate passes.

---

## Part 1 — The GPU server (this is the long pole — start here)

We reuse the off-the-shelf **[devnen/Chatterbox-TTS-Server](https://github.com/devnen/Chatterbox-TTS-Server)**
(FastAPI, OpenAI-compatible, already exists). We do **not** build our own server for the spike.

### Prereqs
- **Python 3.10** specifically (3.11+ lacks prebuilt wheels for some deps). Check: `python --version`.
  If you don't have 3.10, install it from python.org and use its launcher (`py -3.10`).
- **NVIDIA driver** recent enough for CUDA 12.8 (any 2025+ Game Ready/Studio driver is fine).
- **Git** (to clone).
- ~10 GB free disk (model + CUDA wheels).

### Steps
1. Clone and enter:
   ```
   git clone https://github.com/devnen/Chatterbox-TTS-Server.git
   cd Chatterbox-TTS-Server
   ```
2. **Easiest path — the launcher auto-detects your GPU:**
   ```
   start.bat
   ```
   When it shows the install menu, **choose the CUDA 12.8 / Blackwell option** (option 3 —
   "RTX 50-series"). This is **required** for the 5070 Ti (sm_120); the default CUDA 12.1 build
   will *not* drive a Blackwell card.
3. **If you prefer manual** (equivalent to option 3):
   ```
   py -3.10 -m venv venv
   .\venv\Scripts\activate
   pip install --upgrade pip
   pip install -r requirements-nvidia-cu128.txt
   pip install --no-deps git+https://github.com/devnen/chatterbox-v2.git@master
   ```
   The `--no-deps` on the last line is **load-bearing** — it stops pip from downgrading PyTorch
   to a non-Blackwell version. Don't drop it.
4. **First run downloads the Chatterbox model from Hugging Face** ("several minutes"). Let it finish.
5. Server is up on **`http://localhost:8004`** (its default port; there's a Web UI there too).

### Confirm it works *before* touching Reader
- Open `http://localhost:8004` in a browser → the built-in Web UI. Type a sentence, pick a
  predefined voice, generate, listen. If you hear expressive speech here, the GPU path is good.
- Note the **predefined voice filenames** (the `voices/` dropdown, e.g. `Abigail.wav`) — those
  ids are what Reader will send. Pick 1–2 you like for the listen test.
- Watch the server console on that first synth: confirm it says it's using **CUDA**, not CPU
  (CPU would be the wrong test — slow and beside the point).

> **If `start.bat` / CUDA install fights you:** stop and tell me the exact error. Blackwell +
> PyTorch is the one genuinely finicky part; we debug that before anything else. Do **not** fall
> back to a CPU install "just to see it" — a CPU Chatterbox run is slow and would mislead the gate.

---

## Part 2 — Reader talks to the server (I'm wiring this; here's how you'll run it)

Once the wiring lands (I'm doing it now), you test the voice like this — **no installer, no UI yet**:

1. Make sure the server (Part 1) is running.
2. From the Reader repo, launch dev mode with the expressive backend pointed at the server:
   ```
   # PowerShell
   $env:READER_EXPRESSIVE_URL = "http://localhost:8004"
   npm start
   ```
   (When that env var is **unset**, Reader is 100% unchanged — Kokoro-CPU, offline. Setting it is
   the only thing that turns on the GPU voice, and it applies to the whole session.)
3. Drop one of **your own drafts** (a `.md` or `.docx` you wrote) onto the shelf, open it, press
   Space, and **listen**.
4. If the server is down or errors on a sentence, Reader **automatically falls back to Kokoro**
   for that sentence — narration never breaks. (So if you suddenly hear Kokoro, check the server.)

### Choosing which curated voice to hear
For the spike I'll wire a small env override so you can audition specific server voices without a
UI:
```
$env:READER_EXPRESSIVE_VOICE = "Abigail.wav"   # a predefined_voice_id from the server's voices/
```
Leave it unset to use the server's default. (Phase 2 turns this into a real Voice-panel picker.)

---

## The gate — what you're deciding by ear

Listen to a few paragraphs of **your own prose** and judge:
- **Expressiveness:** is it *clearly* more natural/varied than Kokoro on your flat narration —
  enough to justify a multi-GB GPU companion app? (Not just different — clearly better.)
- **Latency:** does it keep ahead in continuous play? Is a cold jump to a new sentence tolerable?
  (Rough numbers are enough — "instant / a beat / annoying.")
- **Reliability:** any **hallucinations / runaway generations** (Chatterbox's known failure mode) —
  wrong words, repeated syllables, garbled tails? Note how often.

Tell me those three, and we decide: **build the installer, or keep Kokoro.** That's the whole point
of the spike — spend a day, not an installer, finding out.

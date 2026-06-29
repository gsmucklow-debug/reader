# NSIS Installer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Switch the Windows build from a `portable` single-exe to an **assisted NSIS
installer** (per-user, no admin, Desktop + Start-menu shortcuts, library-preserving), so
the app installs once instead of self-extracting its whole payload on every cold launch.

**Architecture:** Build-config only — **no application source is touched**. NSIS wraps the
*same* `win-unpacked/` tree the portable target was wrapping, so the model path, the
onnx-unpacked native binary, and `app.getPath('userData')` (= `%APPDATA%\Reader`, where
the library/clips/settings live) all resolve identically. Changing delivery, not payload.

**Tech Stack:** electron-builder (NSIS target), Node `node:test`, Playwright-Electron smoke,
the existing `test/manual/verify-packaged.js` offline-synth harness.

**Design:** [`2026-06-29-nsis-installer-design.md`](./2026-06-29-nsis-installer-design.md)
— read it for the *why* and the locked decisions.

**Branch:** work on `nsis-installer` off `master`.

---

## Pre-flight (read before Task 1)

- This plan has **no unit tests to write** — packaging config is proven by *building* and by
  the packaged-offline gate, not by `node:test`. The existing suites are **regression nets**:
  they must stay green because the swap must not perturb source.
- **You cannot drive the install wizard headlessly.** Tasks 1–4 are everything an agent can
  verify (config valid → installer + `win-unpacked` produced → offline synth works → docs
  match). The wizard run + upgrade-preserves-library check are the **user's** manual gate and
  are listed at the end — do **not** claim them done.
- **Environment gotcha:** this dev shell exports `ELECTRON_RUN_AS_NODE=1`. The unit tests and
  `dist:win` are fine, but anything that *launches* Electron (the smoke, hand-launching the
  packaged exe) must clear it: `env -u ELECTRON_RUN_AS_NODE <cmd>`.
- Baseline before you start: **113 unit tests, smoke green.** Confirm with `npm test` first.

---

### Task 1: Switch the build target to NSIS

**Files:**
- Modify: `package.json` (the `build.win` block + a new `build.nsis` block)

**Step 1: Confirm the baseline is green**

Run: `npm test`
Expected: `pass 113`, `fail 0`.

**Step 2: Edit `package.json` `build.win`**

Replace the current `win` block:

```jsonc
"win": {
  "target": "portable",
  "artifactName": "Reader-${version}-portable.exe",
  "files": [
    "!**/node_modules/onnxruntime-node/bin/napi-v3/darwin/**"
  ]
},
```

with (drop the portable `target` + `artifactName`; keep `files` exactly):

```jsonc
"win": {
  "target": "nsis",
  "files": [
    "!**/node_modules/onnxruntime-node/bin/napi-v3/darwin/**"
  ]
},
```

**Step 3: Add a `build.nsis` block** (sibling of `win`/`mac`, e.g. immediately after the
`win` block):

```jsonc
"nsis": {
  "oneClick": false,
  "perMachine": false,
  "allowToChangeInstallationDirectory": true,
  "createDesktopShortcut": true,
  "createStartMenuShortcut": true,
  "runAfterFinish": false,
  "deleteAppDataOnUninstall": false,
  "artifactName": "Reader-${version}-setup.exe"
},
```

**Step 4: Validate the JSON parses**

Run: `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('package.json OK')"`
Expected: `package.json OK` (catches a stray/trailing comma before you spend a build on it).

**Step 5: Commit**

```bash
git add package.json
git commit -m "build(win): switch portable -> NSIS installer (assisted, per-user)"
```

---

### Task 2: Build the installer and confirm both artifacts

**Files:** none (build step).

**Step 1: Fetch the model if it isn't present** (the build needs it loose; it's gitignored)

Run: `node -e "const fs=require('fs');process.exit(fs.existsSync('assets/models')?0:1)" || node scripts/fetch-model.js`
Expected: either nothing (already present) or the fetch script downloads ~88 MB and exits 0.

**Step 2: Build**

Run: `npm run dist:win`
Expected: electron-builder completes without error and prints a `• building target=nsis` line
(not `target=portable`).

**Step 3: Assert BOTH outputs exist** (the installer *and* the unpacked tree the gates use)

Run:
```bash
ls -la "dist/Reader-0.1.0-setup.exe" "dist/win-unpacked/Reader.exe"
```
Expected: both files listed. **If `dist/Reader-0.1.0-portable.exe` still exists, it is a stale
leftover** from the old target — delete it so nobody ships the wrong file:
`rm -f "dist/Reader-0.1.0-portable.exe"`.

**Step 4: Commit** — nothing to commit (build outputs are gitignored). Skip.

---

### Task 3: Package gate — prove the installed app's payload still synthesizes offline

This is the real proof that the NSIS-shipped tree works (model + native binary resolve).

**Files:** none (runs the existing manual harness against `win-unpacked`).

**Step 1: Run the offline-synth harness**

Run: `env -u ELECTRON_RUN_AS_NODE node test/manual/verify-packaged.js`
Expected: it loads the model from `win-unpacked/resources/assets/models`, uses the unpacked
`.node`, and prints a valid WAV size — **`201644 bytes @ 24000 Hz`** (the known-good figure;
exact bytes may differ by a few if the model/text changed, but it must be a non-trivial WAV at
24000 Hz, not an error).

**Step 2: Re-run the automated regression nets** (the swap must not perturb source)

Run: `npm test`
Expected: `pass 113`.

Run: `env -u ELECTRON_RUN_AS_NODE npm run smoke`
Expected: `SMOKE OK`.

**Step 3: Commit** — nothing to commit. Skip.

---

### Task 4: Update the docs to match the new install flow

**Files:**
- Modify: `HOW-TO-RUN.md` (lines ~7–11, the Windows install steps)
- Modify: `docs/HANDOFF.md` (deferred-item flip + Decisions log + artifact-name mentions)

**Step 1: Fix `HOW-TO-RUN.md`**

The current Windows steps say to double-click `Reader-0.1.0-portable.exe` and that "nothing
to install — copy it anywhere / a USB stick." That is now **wrong**. Replace those steps with:

```markdown
1. Double-click **`Reader-0.1.0-setup.exe`**.
2. Follow the short install wizard (choose a folder if you like — no admin password needed).
3. Launch **Reader** from the Desktop shortcut or the Start menu.
```

Remove the "that single `.exe` is the whole app — copy it to a USB stick" paragraph (no longer
true). Leave the macOS section unchanged.

**Step 2: Update `docs/HANDOFF.md`**

- In **Next up**, flip the deferred NSIS item (currently under the launch-speed / item-6 note
  and the item-8 candidate list) to **done**: NSIS installer built & verified (2026-06-29);
  artifact is now `Reader-0.1.0-setup.exe`; launch re-extraction root cause **closed**.
- In the **Decisions log**, add a line: *"Windows packaging: `portable` → **NSIS installer**
  (2026-06-29) — extract once at install, fixes slow cold launch; assisted wizard, per-user
  (no admin), library/progress preserved (`deleteAppDataOnUninstall:false`)."*
- Search the file for `Reader-0.1.0-portable.exe` and, for any forward-looking "run the
  packaged exe" instruction, note the artifact is now `Reader-0.1.0-setup.exe` (installed, not
  copied). Leave **historical** entries (past phase reports that say a portable exe was rebuilt
  on a given date) as-is — they're an accurate record of that moment.
- Add the standard caveat: the **wizard run + upgrade-preserves-library** check are the user's
  manual gate (below) — not automatable.

**Step 3: Sanity-check no portable references remain in forward-looking docs**

Run: `grep -rn "portable" HOW-TO-RUN.md docs/HANDOFF.md`
Expected: only **historical** mentions remain (dated past-tense build notes). No current
"this is how you run it" line should say "portable."

**Step 4: Commit**

```bash
git add HOW-TO-RUN.md docs/HANDOFF.md
git commit -m "docs: NSIS install flow (setup.exe + shortcuts); close launch-speed root cause"
```

---

## Done when

- `package.json` builds `target=nsis`; JSON valid.
- `npm run dist:win` produces **`dist/Reader-0.1.0-setup.exe`** *and* `dist/win-unpacked/`.
- `node test/manual/verify-packaged.js` → valid WAV @ 24000 Hz (offline synth intact).
- `npm test` 113 green; `npm run smoke` SMOKE OK.
- `HOW-TO-RUN.md` + `HANDOFF.md` describe the installer, not the portable exe.

## NOT done by the agent — user's manual gate (state these as open, do not check them)

- Run `Reader-0.1.0-setup.exe`: wizard appears, lets you pick a folder, **no UAC prompt**,
  Desktop + Start-menu shortcuts created, app launches and reads a book.
- **Upgrade preserves library:** install → add a book → rebuild → reinstall over it → the book
  and its reading progress are still present.
- First-run **SmartScreen** warning is expected (unsigned) — same as the portable exe; out of
  scope.

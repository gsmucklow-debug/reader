# NSIS Installer — Design (2026-06-29)

> Switch the Windows build from a `portable` single-exe to an **NSIS installer**.
> Decided with the user; brainstormed 2026-06-29. Builder plan:
> [`phase-nsis-installer.md`](./phase-nsis-installer.md) (written after this).

## Why

The `portable` target self-extracts its **entire payload on every cold launch**
(the onnx binary, the model, the asar). Even after the binary trim (231 MB → 39 MB
unpacked), each launch still re-extracts and Defender re-scans that payload, so the
app is slow to open. An **NSIS installer extracts once at install time**; subsequent
launches run the already-unpacked tree directly. This is the structural fix that the
binary trim only mitigated — deferred by the user 2026-06-28, now taken.

## Decisions (locked with the user)

| Decision | Choice | electron-builder `nsis` key |
|---|---|---|
| Installer style | **Assisted wizard** (Next/Next/Finish) | `oneClick: false` |
| Pick install folder | **Yes** | `allowToChangeInstallationDirectory: true` |
| Install scope | **Current user, no admin/UAC** | `perMachine: false` |
| Desktop shortcut | **Yes** | `createDesktopShortcut: true` |
| Start-menu shortcut | **Yes** | `createStartMenuShortcut: true` |
| Auto-launch after install | **No** | `runAfterFinish: false` |
| Clean upgrade (remove old first) | **Yes** (NSIS default behaviour) | — |
| Preserve library/progress on uninstall | **Yes** | `deleteAppDataOnUninstall: false` |
| Artifact name | `Reader-${version}-setup.exe` | `artifactName` |

## The change (build config only — no source touched)

In `package.json` → `build`:

```jsonc
"win": {
  "target": "nsis",                 // was "portable"
  "files": [                         // unchanged
    "!**/node_modules/onnxruntime-node/bin/napi-v3/darwin/**"
  ]
  // remove the portable-only "artifactName": "Reader-${version}-portable.exe"
},
"nsis": {
  "oneClick": false,
  "perMachine": false,
  "allowToChangeInstallationDirectory": true,
  "createDesktopShortcut": true,
  "createStartMenuShortcut": true,
  "runAfterFinish": false,
  "deleteAppDataOnUninstall": false,
  "artifactName": "Reader-${version}-setup.exe"
}
```

Everything else in `build` (`files`, `asarUnpack` for onnxruntime, `extraResources`
for the model, `mac`) is **unchanged**.

## Why the existing gates still hold

NSIS packages the **same `win-unpacked/` tree** that `portable` was wrapping; it
changes *delivery*, not the app payload. Therefore:

- **`app.getPath('userData')` = `%APPDATA%\Reader` (Roaming)** is independent of the
  install location and is the **same path the portable build used**. Library
  (`userData/library`), clip cache (`userData/clips`), and `settings.json` all live
  there → **existing books and reading progress survive the switch untouched**, and
  survive every future reinstall/upgrade (`deleteAppDataOnUninstall:false`). This was
  the one real risk; it is resolved by the path being install-independent.
- The model still lands loose at `resources/assets/models` (`extraResources`) and the
  native `.node` still ships in `app.asar.unpacked` (`asarUnpack`) — both resolve from
  `process.resourcesPath` exactly as in `win-unpacked`, which the installer ships verbatim.
- `npm test` and `npm run smoke` drive dev / `win-unpacked`, **not** the portable exe,
  so they are unaffected by the target swap.

## Verification plan

**Automated (regression nets — must stay green):**
- `npm test` → 113/113.
- `npm run smoke` → SMOKE OK.

**Build + package gate (the real proof the installed app works):**
- `npm run dist:win` must produce **`dist/Reader-0.1.0-setup.exe`** *and* still emit
  `dist/win-unpacked/`.
- `node test/manual/verify-packaged.js` against `win-unpacked` → offline synth returns a
  valid WAV (`201644 bytes @ 24000 Hz`). Proves the model + onnx-unpacked path resolves
  in the tree the installer ships.

**Manual-only (can't be driven headlessly — the user's gate):**
- Run `Reader-0.1.0-setup.exe` → wizard lets you pick a folder → no UAC prompt →
  Desktop + Start-menu shortcuts created → launch → add a book, press Play.
- **Upgrade preserves library:** install, add a book, rebuild, reinstall over it →
  the book and its progress are still there.

## Docs to update

- `HOW-TO-RUN.md` lines 7–11: the "nothing to install — copy the exe anywhere / USB
  stick" copy is now **wrong**. Replace with: run `Reader-0.1.0-setup.exe`, follow the
  wizard, launch from the Desktop / Start menu.
- `docs/HANDOFF.md`: flip the deferred NSIS item to done; update the **Decisions log**
  (`portable → NSIS`, why = launch speed, taken 2026-06-29); update the new artifact
  name wherever the old `Reader-0.1.0-portable.exe` filename appears.

## Out of scope (YAGNI)

- Code signing / a trusted publisher cert (SmartScreen will warn on first run —
  unchanged from the unsigned portable; acceptable for a personal app).
- Auto-update (`electron-updater`) — no update server; not wanted.
- A custom NSIS `installer.nsh` script, license page, or custom install graphics.
- macOS packaging — still deferred until the Windows version is finished.

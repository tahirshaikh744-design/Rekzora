# Rekzora — Test Report (v1.1)

**Product:** Rekzora — Screen Recorder for Windows (NEURON TS LABS)
**Report scope:** the v1.1 repair-and-hardening pass (audit directive: *Rekzora 1.1*)
**App version under test:** `1.1.0` · Electron `45.2.3` (exact pin) · Node `v22.21.1` (toolchain)
**Repository state:** commits `444a6d3` (v1.0.0 baseline) through `ac43300`
**Date:** 2026-11-06

> Every claim in this report is backed by a reproduced log line, test run,
> or commit hash. Non-executed items are **explicitly marked NOT EXECUTED** —
> the absence of a claim is not silent; it is stated.

---

## 1. Test strategy

The v1.1 work added testable core modules (`lib/`) that carry no Electron
imports, so the highest-risk logic — the recording state machine, IPC guard,
share-launch registry, crash manifests, WebM probing, settings schema and
atomic storage — is covered by a dependency-free regression suite
(`node --test`). Behavior that a unit suite cannot cover (real capture, real
files, real windows) is validated by the headless smoke test, which drives
the *actual* app: `REKZORA_SMOKE=1 electron .` records ~3 s of the primary
screen end-to-end (source pick → capture → chunk pump → temp file → atomic
finalize → library entry → WebM verification → metadata probe → playback
probe through the custom protocol), and exits **0 only if every assertion
passed**.

## 2. Environments

| Machine | OS | Notes |
|---|---|---|
| Development + smoke host (this report) | Windows 10/11 Pro, 64-bit, single physical display (1920×1080) | repo at `C:\Users\tayyab\Desktop\SCREEN RECORDER OPEN SOURCE FOR WINDOWS` |

Repeatedly reproducible on this host. Wider hardware
coverage — see §9 (NOT EXECUTED matrix).

## 3. Results summary

| Suite | Count | Result |
|---|---|---|
| `node --test` (regression suite) | **70 tests** | **70 pass · 0 fail · 0 skip** |
| Headless smoke (`scripts\smoke-run.bat` → `npm run smoke`) | 11 assertions per run | **PASS (exit 0)** after every phase commit; final run evidence below |
| Live crash-recovery injection test | scan + channels | **PASS** (§6.4) |
| Corrupt-settings recovery drill | `.bak` restore | covered by 11 unit tests + no `[store]` errors in live logs |

## 4. Regression suite inventory (70)

| Module | File | Coverage |
|---|---|---|
| Recording session registry | `tests/recording-session.test.js` | id validation (hex-32), no FS paths leak through the API, owner/role authorization, state machine legality (incl. the v1.1 **zero-chunk finish shape**: `CREATED→FAILED` + `forget()`), double-finalize/discard rejection, chunk bounds (64 MB/chunk, flood cutoff at 32 pending), finish-meta validation (thumb ≤ 512 KB jpeg data URL, types, duration envelope) |
| WebM container probe | `tests/webm-check.test.js` | EBML walker v1/v2 semantic: valid data, bogus doctype rejected, empty/0-buffers, truncated stream tolerance, real-recording fixture behavior |
| Manifest store | `tests/manifest.test.js` | debounced writes land atomically, debounced/internal save coherency, `flushPending` snapshot semantics, removal, recovery listing |
| IPC guard | `tests/ipc-guard.test.js` | sender auth (wc id + role), role/channel matrix incl. **preload↔guard parity** (every channel the preload exposes is allow-listed for the right role), trusted-URL checks, schema enforcement |
| Share launcher | `tests/share-registry.test.js` | id-based launch (no renderer-supplied exe paths), ARGS_BY_APP policy, executable plausibility filter, unknown-id refusal |
| Settings schema | `tests/settings-schema.test.js` | per-key type/domain validation, unknown-key dropping, hotkey grammar, saveDir guards (NUL, relative, non-string), coerce-to-default-not-store policy, full-load sanitize sweep |
| JSON store | `tests/json-store.test.js` | round-trip persistence, atomic rename (no `.tmp` residue, no torn files across 75 writes), **corrupt-primary recovery from `.bak`** (incl. backup intactness across a second corruption), loud fallback to defaults with report, remove persistence + defaults-shape semantics, sanitize hooks, reload liveness |

Run command: `npm test` (script runs `node --test` from the repo root; on
the portable toolchain: `& .\tools\node\node.exe --test`).

## 5. Smoke test evidence (final run with v1.1 code, Electron 45.2.3)

`logs/rekzora.log` — run of 2026-11-06 10:06 (commit `98bffed`-era tree):

```
[main] 10:06:41 [smoke] dispatching to renderer
[main] 10:06:45 [smoke] result: {"ok":true,"detail":{"discarded":false,
  "durationMs":3248,"status":"completed","reason":null,
  "recordingId":"ace8a99af1976496f6da072245ed74c1",
  "id":"r_bo3vfbruchdb","size":114623,...}}
[main] 10:06:46 [smoke] file: true | size: 114623 | webm ok: true |
  duration: 3248 ms | library entry: true
[main] 10:06:46 [smoke] playback: {"ok":true,"w":1920,"h":1080,"dur":null}
[main] 10:06:46 [smoke] result: PASS (exit 0)
```

Assertions exercised inside the smoke:

1. source enumeration works (5 sources, ≥1 screen),
2. recording session opens via main-owned id (`rec:begin`),
3. 3 s of real capture flows through the bounded chunk pump,
4. finalization lands the file in the configured folder,
5. WebM structure check passes (EBML-valid, cluster present),
6. duration means 3 s of real footage (tolerance 2–12 s),
7. library metadata entry exists (opaque `r_…` id),
8. **playback probe**: a fresh `<video>` streams the take via
   `rekzora-video://<id>/video` and reports real dimensions — this
   validates `protocol.handle` + Range streaming under Electron 45.2.3.

Earlier runs during this pass: PASS on `7e537fb`, `160b5bf`/`e31590a`
(logs at 09:25, 09:27, 09:32, 09:34, 09:46), with the same assertion set
(plus playback probe from `160b5bf` onward).

**Failure evidence turned into a fix** (§7.2): one run on a stalled
desktop-capture source exposed the zero-frame hang — after the fix every
subsequent run passed and the class of hang is bounded by the 45 s race.

## 6. Live scenario validation

### 6.1 Real-recorded file verification
388 KB/486 KB/114-301 KB real WebM takes produced during the pass were
checked with `checkWebM` (EBML walk: doctype webm/matroska, tracks,
cluster presence, size accounting). All valid.

### 6.2 Settings migration (Phase E)
The developer's real `settings.json` (v1.0 content) was re-loaded through
`sanitizeStored`: values preserved exactly
(`fps 30, quality high, saveDir C:\Users\tayyab\Videos\Rekzora Recordings`
verified in log-based smoke PASS), unknown keys dropped, `.bak` created on
the next write (`library.json.bak`, 56 KB, observed in
`%APPDATA%\Rekzora`), zero `[store]` errors in logs.

### 6.3 Crash-recovery injection
Synthetic crashed session injected into `%APPDATA%\Rekzora\recordings-tmp`
(a real manifest JSON with a 32-hex id + a real playable temp file):
startup log detected it (`recovery candidates from a previous session: 1`),
the manifest survived the app run untouched (by design — only the user's
Keep/Delete/Dismiss decides), the `recovery:*` channels registered, and a
later smoke ran clean after manual artifact cleanup. The full banner
click-flow (renderer button → `recovery:recover` → library entry with
`recovered: true` badge) is **code-validated but NOT EXECUTED as a manual
click-through** on this host (see §9).

### 6.4 Electron upgrade (Phase D) — no-regression evidence
Electron 45.2.3 binary verified (`ProductVersion 45.2.3`). `desktopCapturer`,
`sandbox:true` + role-scoped preload, `protocol.handle` of
`rekzora-video:`, loopback system audio path, permission handlers and the
whole record→save→library→playback chain re-validated by the smoke above.

### 6.5 CI pipeline (Phase G)
`release.yml` rewritten and syntactically clean (no tabs; SHA pins
verified by regex over the file content for both actions —
`checkout@3d3c42e5…` (v7.0.1), `setup-node@949feb24…` (v7.1.0), SHAs
fetched from the GitHub API tag refs during this work). **NOT EXECUTED:**
an actual CI run requires pushing to GitHub, which requires separate
authorization (§10).

## 7. Failure handling validation

1. **Disk-slow/stuck chunk queue** — bounded pump caps queued chunks at
   16; beyond that the recording ends with an honest warning note (unit +
   code-reviewed; the 16-cap hash `QUEUE_HARD_CAP`).
2. **Zero-frame capture** — live-validated failure class (DXGI stall):
   now yields named error `No video frames were captured…`, FAILED→clean
   removal; regression test locks the state shape.
3. **Quit during recording** — modal handshake (Stop & save /
   Quit-without-saving / Cancel) with bounded 15 s wait; manifests always
   flushed on quit. NOT EXECUTED as an interactive manual test on this
   host (dialog requires a user click-through); state-machine wiring is
   code-reviewed and smoke-adjacent paths pass.
4. **Corrupt settings file** — drilled in unit tests (11) covering:
   recover-from-bak, corrupt-bak-doesn't-destroy-good-bak, defaults with
   loud report, sanitize hooks. Live corruptions observed zero.
5. **Hung smoke** — 45 s race: exits honestly (added after observing the
   zero-frame hang).

## 8. Security posture checks (regression-locked)

- No renderer-owned temp file paths: renderer sessions speak only opaque
  ids (unit-tested; temp targets hidden in a non-enumerable closure).
- Share launch accepts app ids only (policy ARGS_BY_APP), executables
  validated for existence + plausibility before spawn.
- All IPC flows through `createGuard` with role/channel matrix and schema
  checks; preload↔guard parity test prevents silent drift.
- `sandbox: true` on every window; navigation/window-open/webview guards
  on every window (code + smoke live run).
- Permissions deny-by-default; only `media`/`desktopCapturer`/
  `display-capture`, only from Rekzora's own windows.
- Publish pipeline: tag↔version gate, no `npm install` drift, checksums
  emitted, third-party actions SHA-pinned.

## 9. NOT EXECUTED (honesty ledger)

| Item | Why | Required to close |
|---|---|---|
| Multi-monitor (2+, mixed DPI) capture | single-display dev host | VM or second monitor scenario + repeat smoke |
| External/hardware audio devices (USB mics, Bluetooth headsets) | none available on host | device matrix, repeat smoke with `mic: true` |
| Webcam overlay across vendors | no attached camera on host | one camera run |
| Real crash injection via process kill mid-recording | risk to host tooling during this pass | deliberate kill-test script + verify recovery banner result |
| Full manual click-through of the recovery banner (Keep→Library) | banner behavior code-reviewed + channels live-validated; host validation was scan-level | 1 manual interactive session |
| Interactive quit-dialog choice validation | dialog is modal; cannot be driven by the smoke | manual session |
| CI end-to-end run (tag → artifacts → release) | requires repo push (no remote configured here; publishing is separately authorized) | push access + tag |
| Installer artifacts (Setup/Portable) on a clean VM, upgrade-over-1.0 path | requires the electron-builder build to run and a clean VM | build + VM test matrix |
| Keyboard-only / accessibility pass | out of scope for this repair pass | separate audit |
| Performance profiling (4K/Ultra sustained capture) | beyond functional verification | perf harness |
| antivirus false-positive sweep (4 AV engines) | requires VirusTotal/3rd-party process | external service run |

## 10. Publish authorization boundary

This pass **did not push, tag, or publish anything**. No git remote is
configured in this working tree. All commits are local (`main` at
`ac43300` …). Tagging/pushing/releasing requires the owner's explicit
authorization and GitHub credentials.

## 11. Known limitations (disclosed, by design)

- Auto resolution caps at the 2560-px long edge (documented in README).
- Quality presets scale bitrate (24 Mbps @ FHD target for Ultra, 42 Mbps
  ceiling) — not a fixed number (documented in README).
- The AudioContext mixing path falls back to the first source unmixed
  with a visible note if the context cannot run (rare).
- Recovered takes carry `durationMs: 0` until re-measured; the player
  shows the filename and `Recovered`/`Partial` badges.

— end of report —

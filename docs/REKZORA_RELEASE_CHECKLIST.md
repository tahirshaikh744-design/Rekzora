# Rekzora — Release Checklist (v1.1.0)

**Product:** Rekzora — Screen Recorder for Windows (NEURON TS LABS)
**Target version:** `1.1.0` · strategy: local commits on `main`, release via
CI after separate publish authorization
**Rule:** a checkbox is checked **only** with evidence (hash, log line, or
explicit command output) — no claims without reproduction.

---

## A. Code & feature gates

| Gate | Status | Evidence |
|---|---|---|
| Phase A: all 18 audit findings re-validated before any fix | ✅ | `docs/REKZORA_TECHNICAL_AUDIT.md` (issue matrix with line refs vs. baseline `444a6d3`) |
| Phase B: P0 trust boundary (renderer no longer owns paths/exe picks) | ✅ | commit `1f1ecb9` — main-owned crypto session ids, share registry `{appId, recordingId}`, opaque library ids, IPC guard + role-scoped preload, `sandbox:true` |
| Phase C: recording reliability (bounded chunk queue, quit handshake, crash-recovery UI, capture cleanup) | ✅ | commit `7e537fb`; smoke runs after it PASS |
| Phase D: Electron 45.2.3 (EOL 38 retired), permission handlers, hardened CSP, playback probe | ✅ | commit `160b5bf`; binary `ProductVersion 45.2.3`; smoke with `playback: {ok:true,w:1920,h:1080}` |
| Phase E: typed settings schema + atomic store + save-dir provisioning + thumb bounds | ✅ | commit `e31590a`; 20 new tests (json-store 11, settings-schema 9); live settings migration preserved values |
| Phase F: README truthfulness (bitrate/Auto-cap/crash-safe claims) + Recovered/Partial badges + version bump | ✅ | commit `a60b196` |
| Zero-frame capture honesty fix (found during validation) | ✅ | commit `98bffed` + regression test |
| Phase G: CI quality gates (tag↔version, `npm ci`, tests+smoke before build, checksums, SHA-pinned actions) | ✅ | commit `ac43300`; SHA pins verified for `checkout@v7.0.1` / `setup-node@v7.1.0` |
| Unit tests green | ✅ | `node --test` → **70/70 pass** (final run before `ac43300`) |
| Headless smoke green | ✅ | `scripts\smoke-run.bat` → `smoke exit code: 0` with full record→save→verify→playback flow in `logs/rekzora.log` |
| Docs: test report | ✅ | `docs/REKZORA_TEST_REPORT.md` (NOT EXECUTED items marked) |
| Docs: audit + fix ledger | ✅ | `docs/REKZORA_TECHNICAL_AUDIT.md` §5 |
| Docs: README/privacy/EULA consistency | ✅ | Phase F sweep + this checklist; `build/license.txt` unchanged (v1.0 statements remain accurate) |

## B. Build gates (require a build run)

| Gate | Status | Evidence needed |
|---|---|---|
| `npm ci` succeeds on a clean checkout | ⬜ NOT EXECUTED (local working tree already installed) | CI run log or clean clone run |
| `npm run dist` produces Setup + Portable artifacts | ⬜ NOT EXECUTED in this pass | `dist\Rekzora-Setup-1.1.0.exe`, `dist\Rekzora-Portable-1.1.0.exe` |
| Installer EULA page renders from `build/license.rtf` | ⬜ NOT EXECUTED | installed run screenshot |
| SHA256SUMS.txt generated with 2 entries | ⬜ NOT EXECUTED | CI checksums step output |
| Artifacts open/run: install → record → save → play on **clean Windows VM** | ⬜ NOT EXECUTED | VM session |
| Upgrade-over-1.0 keeps recordings + settings | ⬜ NOT EXECUTED | VM with old build + new build |
| SmartScreen behavior documented for unsigned exe | ✅ (docs) | README "Code signing" §Step 7 |

## C. Publish gates (require owner authorization)

| Gate | Status | Notes |
|---|---|---|
| Add git remote / repo access | ⬜ NOT EXECUTED | no remote configured in this working tree |
| Push `main` with Phases B–H commits | ⬜ awaiting explicit authorization | local `main`: `444a6d3 → 1f1ecb9 → 7e537fb → 160b5bf → e31590a → a60b196 → 98bffed → ac43300` |
| Verify CI green on the push (gates: version-equiv, tests, smoke) | ⬜ | requires pushed branch |
| Tag `v1.1.0` only after CI green | ⬜ | tag must equal package.json |
| Release artifacts + checksums attached; verify SHA-256 by re-download & hash | ⬜ | `SHA256SUMS.txt` |
| Update New/Cloudflare-broken screenshots if UI changed | ⬜ optional | recovery banner not present in `docs/screenshots/*` |
| Post-release: pin release notes to actual features shipped in 1.1.0 | ⬜ | `RELEASE-NOTES.md` |

## D. Known-not-executed validation matrix

See **§9 NOT EXECUTED** in `docs/REKZORA_TEST_REPORT.md` (multi-monitor,
external mics, webcam, clean-VM installer drill, interactive
recovery-banner and quit-dialog click-throughs, CI end-to-end run,
VirusTotal sweep). Each row names the closure path.

## E. Rollback plan

- The v1.1 work is additive and gated by phases: every phase is a separate
  commit and each phase's test+smoke evidence exists. If a v1.1 regression
  appears post-release, `git revert` the specific phase commit (state
  `main` at the pre-incident hash) and re-cut the tag (patch version).
- The store's `.bak` recovery guarantees a bad settings write cannot
  strand users: previous good state is restored with a logged warning.

## F. Release timeline proposal

1. Owner: review commits `1f1ecb9…ac43300`; run the §B build gates on a VM.
2. Authorize the push + tag; CI executes §C.
3. Publish with `RELEASE-NOTES.md` updated per §C.

— end of checklist —

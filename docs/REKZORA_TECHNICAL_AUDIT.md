# Rekzora — Technical Audit (v1.1 Repair Cycle)

**Project:** Rekzora — offline-first screen recorder for Windows (NEURON TS LABS)
**Starting commit:** `444a6d3` (`main`, v1.0.0 rebrand commit, clean tree)
**Audit date:** 2 Nov 2026
**Runtime baseline:** Electron 38.8.6 · electron-builder 26.18.0 · Node toolchain 22.21.1
**Method:** every finding from the previous static audit was revalidated against the repository at the starting commit by reading the exact code paths; findings that are no longer present are recorded as *mitigated (history only)*. Nothing was assumed still-broken without fresh evidence, and no defect was assumed fixed without evidence either.

---

## 1. Baseline architecture

| Component | File | Notes |
|---|---|---|
| Main process | `main.js` (~1,023 lines) | windows, IPC, capture permission handler, storage, tray, hotkeys, smoke test |
| Preload bridge | `preload.js` (103 lines) | single `window.rekzora` bridge shared by **all** windows |
| Recorder engine | `src/renderer/recorder.js` (623 lines) | canvas-pipeline MediaRecorder, mic/webcam compositing |
| Main UI (renderer) | `src/renderer/app.js` (~1,100 lines), `index.html` | library, settings, share sheet, player, EULA gate |
| Floating toolbar | `src/floating/` | non-focusable always-on-top bar |
| Region picker | `src/region/` | transparent screenshot overlay |
| Packaging | `package.json` (`build` block), `build/installer.nsh` | NSIS per-user + portable |
| Release CI | `.github/workflows/release.yml` | tag-triggered, publishes immediately after build |
| Smoke test | `runSmokeTest()` in `main.js` + `scripts/smoke-run.bat` | headless 3 s capture |

Recordings stream as ~1 s MediaRecorder chunks: renderer `rec:begin` → `rec:chunk` (file handle in main) → `rec:finish` (main renames temp → `%Videos%\Rekzora Recordings`) → library DB (`%APPDATA%\Rekzora\library.json`).

---

## 2. Revalidated issue matrix

Severity key: **P0** critical security / data-integrity · **P1** high-impact reliability / security · **P2** functional / robustness · **P3** docs / polish.

### P0 — trust boundary

| # | Status | Finding | Evidence (line refs at 444a6d3) | Root cause |
|---|---|---|---|---|
| A1 | **CONFIRMED** | Recording IPC trusts renderer-supplied `tempPath`. `rec:begin/chunk/finish/discard` all take it from the renderer; `rec:finish` renames that path into the save folder **without any containment check**. A compromised renderer can move any file the user can read into the recordings folder ("recording" it) or link a temp file of one session into another's handle. | `main.js` 767–770, 419–443; `preload.js` 49–55 | main process holds the file handle but lets the renderer name the file |
| A2 | **CONFIRMED** | `share:launch({ exe, args })` spawns a renderer-chosen executable with renderer-chosen arguments (`spawn(exe, args)`). The renderer relays the exe path that the main process first handed out — but nothing stops a compromised renderer from sending any other exe/args. | `main.js` 904–911; `src/renderer/app.js` 919 | launcher identity round-trips through the renderer |
| A3 | **CONFIRMED** | `share:openwith(filePath)` spawns `OpenWith.exe` with a raw renderer-supplied path; no ownership check. | `main.js` 912–918 | same class as A2 |
| A4 | **CONFIRMED** | `recording:open` → `shell.showItemInFolder(anyString)` with no validation — arbitrary file reveal from renderer. | `main.js` 806–809 | path-arg IPC without a guard |
| A5 | **CONFIRMED** | `app:drag-start(filePath)` accepts any existing path (only `existsSync`) — can drag arbitrary files out to other apps. | `main.js` 890–900 | file ownership not derived from library |
| A6 | **CONFIRMED** | No schema/shape validation on most IPC payloads (`region:begin` bounds, `rec:finish.meta`, `settings:set` patch values, etc.). | `main.js` 688–700, 824; `recorder.js` 550–566 | handlers trust callers |

### P0/P1 — recording data integrity

| # | Status | Finding | Evidence | Root cause |
|---|---|---|---|---|
| B1 | **CONFIRMED** | Chunk write failures are counted (`writeErrors`) and only force-stop after ≥5 failures; after any stop, finalization still takes the *normal* success path — a recording that lost chunks completes and lands in the library with no partial marker. | `recorder.js` 447–461, 549–569; `main.js` 419–443 | no shared failure state between write path and finalizer |
| B2 | **CONFIRMED** | Chunk write queue is unbounded: `s.writeChain` serialises every chunk but nothing limits pending count/bytes; a slow disk grows renderer memory indefinitely. | `recorder.js` 444–462 | backpressure never designed |
| B3 | **CONFIRMED** | `beforeunload` calls `stop()` (async, un-awaited) when the window is destroyed; on app quit the renderer may be torn down mid-finalization → footage already flushed is kept only as an unmanaged temp file. | `recorder.js` 399–401 | no quit handshake |
| B4 | **CONFIRMED** | No crash-recovery manifests; every temp older than 24 h is **silently deleted** by `beginRecordingFile()` — including recoverable crash footage. | `main.js` 393–409 | retention policy conflates "old" with "abandoned" |
| B5 | **CONFIRMED** | Canvas `captureStream` track (`cTrack` and the `captureStream(fps)` fallback stream) is never stopped in `cleanup()` — leaks an encoder-side track per recording. | `recorder.js` 98–106 (`outVideoStream` never stored), 371–385, 102–116 | cleanup list written before canvas stream existed |
| B6 | **CONFIRMED** | `withTimeout()` rejects on timeout but the underlying `getDisplayMedia`/`getUserMedia` promise keeps running: a late-resolving capture produces an unowned live stream (hidden indicator active). | `recorder.js` 48–56, 119–184 | timeouts not bound to attempt lifecycle |
| B7 | **CONFIRMED** | `mixTracks()` never resumes/verifies the `AudioContext` (`state` may be `suspended` on cold starts) — recording proceeds with a silent audio track. | `recorder.js` 76–100 | audio path assumed live |
| B8 | **MITIGATED (1.0, keep)** | Mic/webcam streams resolving after abort are released (`rec.pendingSession !== session` guard). Preserved as-is; regression-tested in the new suite. | `recorder.js` 219–223, 241–245 | — |

### P1 — Electron security & platform

| # | Status | Finding | Evidence | Root cause |
|---|---|---|---|---|
| C1 | **CONFIRMED** | Main window runs with `sandbox: false` (preload uses only `contextBridge`/`ipcRenderer`, so nothing actually requires it). Float/region windows inherit default sandboxing (fine) but not declared. | `main.js` 207–214 | historical preload caution |
| C2 | **CONFIRMED** | One shared bridge for MAIN / FLOATING / REGION roles: the region picker's JS can invoke `recording:delete`, `share:launch`, settings writes, etc. | `preload.js` (single allowlist for all windows) | no role model |
| C3 | **CONFIRMED** | No centralized sender authorization: handlers never check `event.sender` identity, frame, or URL (e.g. any WebContents of any Rekzora window — or a devtools context — can call privileged channels). | all of `registerIpc()` | handlers written before threat model |
| C4 | **CONFIRMED** | No navigation guard: a `will-navigate`/`window.open` in any renderer is unrestricted (`setWindowOpenHandler` never set). | `main.js` window construction | — |
| C5 | **CONFIRMED** | `app:open-external` accepts `http:` (not just `https:`) and any URL matching `/^https?:\/\//` with no further validation. | `main.js` 877–879 | weak scheme gate |
| C6 | **CONFIRMED** | **Electron 38.8.6 is End-of-Life since 10 Mar 2026** — no security patches for 8 months. Supported lines as of 2 Nov 2026: 43, 44, 45 (45.2.1 newest). `package.json` also uses a caret range `^38.0.0` (forbidden for the core runtime). | `package.json` 35; endoflife.date/electron (1 Nov 2026) | v1.0 shipped on the then-current line |
| C7 | **MITIGATED (audit found solid)** | CSP present on all three HTML documents with explicit `default-src 'self'; script-src 'self'`; only `unsafe-inline` in `style-src` + justified `data:/blob:`/`file:` media allowances (`meta`-embedded, cannot spread to remote). Tighten with `object-src 'none'; base-uri 'self'; frame-src 'none'; form-action 'none'` during Phase D. | `index.html` 5–6, `floating` 5–6, `region` 5–6 | — |

### P1/P2 — data, settings, filesystem

| # | Status | Finding | Evidence | Root cause |
|---|---|---|---|---|
| D1 | **CONFIRMED** | `Store` writes synchronously, swallows all errors (`console.error` only), no atomicity, no backup, no corruption recovery. A killed write corrupts settings/library with no recovery. | `main.js` 28–54 | simple v1 persistence |
| D2 | **CONFIRMED** | Settings values unvalidated beyond key allowlisting (`fps:"potato"` persists; `saveDir` accepted without a write test; no type/enum/range checks). | `main.js` 688–700 | allowlist ≠ schema |
| D3 | **CONFIRMED** | Library is keyed by **raw filesystem path strings** — case-insensitive on Windows, breaks on rename-by-band, and forces every renderer feature (delete/rename/reveal/share/drag/player) to pass full paths over IPC (see A4/A5). | `main.js` 92–94, 458–495 | v1 data model |
| D4 | **CONFIRMED** | Thumbnails stored as base64 data URLs inside `library.json` (~40–120 KB each) — unbounded single-file growth. | `recorder.js` 357–365; `main.js` 96–114 | v1 choice; needs bounded sidecar files |
| D5 | **CONFIRMED** | `recordings:folder-pick` commits `saveDir` with no provision (write-test) before persisting. | `main.js` 810–820 | same as D2 |
| D6 | **CONFIRMED** | Library DB entries whose file vanished are pruned only when in `saveDir` — recordings in a *changed* saveDir are pruned harmlessly, but a stale entry's metadata is silently lost. Documented behaviour; keep + handle gracefully. | `main.js` 490–493 | — |

### P2 — quality & documentation

| # | Status | Finding | Evidence | Root cause |
|---|---|---|---|---|
| E1 | **CONFIRMED** | "Auto" resolution silently caps the long edge at 2560 px (`auto: 2560`) — 4K source is downscaled with no UI/README disclosure. Decision (kept): cap stays for CPU/quality safety, **disclosed** in README + recorder comment. Changing to native 4K would hurt recording reliability on mid-tier hardware. | `recorder.js` 295–298 | undocumented smart default |
| E2 | **CONFIRMED (doc-side)** | README says "Ultra (24 Mbps)"; implementation computes `24 Mbps × (pixels / 1080p)`, clamped 1.5–42 Mbps — accurate *at 1080p only*, higher at 1440p/4K. Fix the doc to state the actual formula (implementation is sane; the claim was imprecise). | `recorder.js` 58–62; README quality table | doc not tied to formula |
| E3 | **CONFIRMED** | Smoke test logs failures but always exits 0 (`app.exit(0)` fallback even after `[smoke] FAILED`), and does not validate WebM structure/tracks/library — a CI run can publish a broken build. | `main.js` 963–969 | exit path written before result semantics |
| E4 | **CONFIRMED** | Release CI: `npm install` (not `npm ci`), no test stage, unpinned action tags, `workflow_dispatch` can publish with no tag↔version check, no SHA-256 checksums, `permissions: contents: write` workflow-wide. | `.github/workflows/release.yml` 13–45 | — |
| E5 | **CONFIRMED** | `package.json` has no `test` script at all. | `package.json` 27–33 | — |
| E6 | **CONFIRMED (P3, doc)** | MIT source license vs binary EULA branding restriction ambiguity; privacy wording ("zero network connections") vs. crash-recovery retained temp files. Phase H review. | `LICENSE`, `build/license.txt`, README | — |

### Already correct (no action, verified)

- Quit coordination post-1.0 fixes: `quitting` flag, `tray.destroy()` in `before-quit`, `AppUserModelId` set, smoke `app.quit()` path (`main.js` 25, 221–226, 968, 1013–1020).
- First-run EULA gate verified live in 1.0 testing (agree persisted / decline exits clean).
- `isInsideDir` containment checks exist on `recording:delete/rename` (still upgraded to ID-based in Phase E).
- Share detection script (`SHARE_PS_SCRIPT`) runs `powershell.exe -NoProfile -NonInteractive` with a fixed script string — no injection from renderer data (renderer only forces a boolean refresh).
- Recording profile paths: `%APPDATA%\Rekzora` for settings/library TMP; `%Videos%\Rekzora Recordings` for finals (matches README).

---

## 3. Repair plan (phases A–H)

- **A. Baseline** (this document) — done: matrix above is the resolved truth at `444a6d3`.
- **B. P0 security** — recording session registry (crypto-random IDs, state machine, ownership, payload validation, safe finalization); share registry (`share:launch({appId, recordingId})`); opaque library IDs for delete/rename/reveal/share/drag/open-with; sender-validation foundation.
- **C. Recording reliability** — quit handshake, crash manifests + recovery UI, canvas-track/late-promise/AudioContext fixes, bounded chunk queue with PARTIAL semantics.
- **D. Electron hardening** — runtime upgrade to a supported line (45.x, fallback 44.x), `sandbox: true` everywhere, role-scoped bridges, `will-navigate`/`window.open` gates, CSP touch-up, permission handler.
- **E. Data integrity** — schema-validated settings, atomic async store with `.bak` recovery, provisioned save-dir, bounded thumbnail files.
- **F. Quality** — README bitrate/Auto truthfulness; codec fallback already feature-detected (`pickMime`); measured metadata (actual fps/size/duration) where cheaply measurable.
- **G. Release** — `npm ci`, unit-test stage before packaging, tag↔version gate, checksums, pinned action SHAs, smoke test with real exit codes.
- **H. Docs** — README/privacy/EULA consistency sweep; this audit + test report + release checklist finalized.

Fixes are committed in order; each phase lands with its regression tests. Nothing here re-designs the product — every workflow, window, visual, and user behaviour stays.

---

## 4. Remaining risks / environment limits (live list)

Full Windows hardware matrix (BT/USB mics, multi-monitor rigs, clean-VM installer runs, sleep/suspend paths) cannot execute in this environment; the test report marks such entries explicitly as *not executed (environment)* — never as passed.

---

*Updated as phases land — see §5 (created after Phase B) for the implemented-fix ledger.*

# 🎬 Rekzora 1.0.0 — first public release

**Rekzora** is a minimal, offline-first **screen recorder for Windows** — no account, no cloud, no watermark.
Built with Electron 38 · MIT licensed · by **NEURON TS LABS** (Mohd Tahir Shaikh).

<p align="center">
  <a href="docs/screenshots/record.png"><img src="docs/screenshots/record.png" width="49%" alt="Record page"></a>
  <a href="docs/screenshots/picker.png"><img src="docs/screenshots/picker.png" width="49%" alt="Source picker"></a>
  <a href="docs/screenshots/library.png"><img src="docs/screenshots/library.png" width="49%" alt="Library"></a>
  <a href="docs/screenshots/settings.png"><img src="docs/screenshots/settings.png" width="49%" alt="Settings"></a>
</p>

---

## ✨ What's new in v1.0.0

### 🎥 Recording
- **Fullscreen** — capture any connected display, with a live screen picker.
- **Window** — record a specific application window; the capture **follows it even when it moves**.
- **Region** — drag any rectangle with a live size readout; `Esc` cancels the selection.
- **Countdown with capture pre-arming** — `3·2·1` runs in parallel with stream setup, so recording **starts the instant it hits zero** (configurable: none / 3 s / 5 s).
- **Resolution control** — Auto / 240p / 360p / 480p / 720p / 1080p / 1440p / 2160p.
- 🖼 **Webcam overlay** — picture-in-picture bubble composited into the video.
- ⏸ **Pause / resume** — media-quality pause, no gaps in the timeline.
- 💾 **Crash-safe by design** — video is appended to disk **every second** as 1-second chunks; even a hard crash preserves your footage.

### 🔊 Audio
- **System audio** — real Windows loopback through the main-process display-media handler ("what you hear is what you get").
- **Microphone** — with noise suppression, auto gain *and* a gentle compressor to prevent clipping.
- **Proper mixing** — mic + system audio are mixed through an `AudioContext` graph, not pasted together after the fact.

### 🎛 Workflow
- **Floating control bar** — always-on-top timer + play/pause/stop; created *non-focusable* so it never steals your keyboard focus.
- **Global hotkeys** — `F9` start/stop, `F10` pause/resume. Works anywhere in Windows, **rebindable** from Settings.
- **Library** — searchable list with live thumbnails, duration/size/quality/fps chips, badge counter.
- **In-app player** — play, rename, delete, reveal in Explorer.
- **Item actions** — Play, Share, Rename, Show in folder, Copy path, Properties, Delete — from the `⋮` menu *or a right-click* on any card.
- **Share sheet** — matches your installed sharing apps automatically (Google Quick Share, SHAREit, LocalSend, Send Anywhere, Xender, Telegram), plus any app via **"Open with…"**.
- **Native drag-out** — drag a Library card (or the open player video) *straight into* Quick Share, SHAREit, an email attachment… the OS hands the real file over (no temp-file copies).
- **Save toasts** — every recording confirms with its title + full file path and Show / Share / Play buttons.
- **Tray + battery-friendliness** — live tray state ("Rekzora — Recording / Ready"), close-to-tray behaviour, and **automatic pause when your PC sleeps** (resume manually with `F10`).

### 🎨 Design & settings
- **Light & dark themes** — rooted design tokens, translucent sidebar, Windows-style window controls.
- **Quality dial** — 24 / 30 / 60 fps and Low / Medium / High / **Ultra (24 Mbps)**.
- **Save folder** — configurable (default: `Videos\Rekzora Recordings`).
- **First-class tray settings** — choose close-to-tray vs. quit-and-go.

---

## 🔐 Enterprise-friendly & private by design

| Guarantee | How |
|---|---|
| **No account, no cloud, no upload** | Rekzora makes **zero** network connections of its own. |
| **No telemetry** | Nothing is ever beamed home — a phones-home-to-nobody architecture. |
| **First-run consent** | A full **Privacy Policy / EULA** is presented on first start. Declining closes the app; nothing is stored if you decline. |
| **No-admin installation** | The Setup is **per-user** (`asInvoker`, NSIS `perMachine: false`) — **no UAC prompt**, no admin password, no reboot. |
| **Clean data model** | Recordings + settings + library database are plain files you can delete any time. No registry keys are ever written. |

---

## ⌨️ Default shortcuts

| Key | Action | Scope |
|---|---|---|
| `F9` | Start / stop recording | global (works in any app) |
| `F10` | Pause / resume | global |
| `Esc` | Cancel region selection | while selecting |

---

## 📥 Installation (3 options)

**Option A — Installer (recommended):**

```text
1. Download Rekzora-Setup-1.0.0.exe (from the Assets below)
2. Run it — per-user install, no UAC, EULA included
3. Click I Agree → Finish
```

**Option B — Portable (no install):**

```text
1. Download Rekzora-Portable-1.0.0.exe
2. Double-click it from any folder (even a USB stick)
```

**Option C — From source:**

```powershell
git clone https://github.com/tahirshaikh744-design/rekzora.git
cd rekzora
npm install
npm start        # run in dev mode
npm run dist     # build both Windows artifacts
```

Where things live: recordings `Videos\Rekzora Recordings` · settings `%APPDATA%\Rekzora\settings.json` · library DB `%APPDATA%\Rekzora\library.json`.

---

## 📦 Artifacts

| Artifact | Type | Size |
|---|---|---|
| `Rekzora-Setup-1.0.0.exe` | NSIS installer · per-user · EULA page | ≈ 98 MB |
| `Rekzora-Portable-1.0.0.exe` | single-file portable exe | ≈ 90 MB |
| `Rekzora-Setup-1.0.0.exe.blockmap` | delta-update metadata | ≈ 100 KB |

<details>
<summary>Verify checksums (after downloading)</summary>

```powershell
Get-FileHash .\Rekzora-Setup-1.0.0.exe -Algorithm SHA256
Get-FileHash .\Rekzora-Portable-1.0.0.exe -Algorithm SHA256
```
Certificate-based checksums will be published with each release once the project obtains an Authenticode code-signing certificate (tracked in [RELEASE.md §4](https://github.com/tahirshaikh744-design/rekzora/blob/main/RELEASE.md)).
</details>

---

## 🧯 Known limitations in 1.0.0

- **Storage format is WebM (VP9 + Opus).** Universal on Windows, plays in the in-app player, VLC and modern browsers; MP4 export via ffmpeg is on the roadmap.
- **DRM-protected windows record as black** (Netflix, some protected browser content) — this is a Windows-level restriction no screen recorder can bypass.
- **Windows privacy gates** — microphone/camera access must be allowed for desktop apps in `Settings → Privacy & security` (standard for any recorder).
- **Unsigned binaries** — Windows SmartScreen may show "unknown publisher" on first run (click *More info → Run anyway*). This goes away only with a paid Authenticode certificate.
- **Hotkeys can be claimed** — if OBS / Game Bar etc. already own F9/F10, rebind Rekzora's in Settings.

---

## 🚀 What's next (Roadmap)

- [ ] MP4 export (ffmpeg post-processing)
- [ ] Trim editor
- [ ] Auto-start with Windows
- [ ] Auto-updates via GitHub Releases (payload already blockmap-ready)
- [ ] Optional small always-on-top webcam window

See the full list in the README's Roadmap section.

---

## 🙌 Credits

Built by **Mohd Tahir Shaikh** ([@tahirshaikh744-design](https://github.com/tahirshaikh744-design)) · Brand: **NEURON TS LABS** 🇮🇳
Stack: Electron 38 · Chromium display-capture · zero runtime npm dependencies.

**Full Changelog**: https://github.com/tahirshaikh744-design/rekzora/commits/v1.0.0

---

> *Rekzora is open source under the MIT license. If it saves you time, a GitHub ⭐ helps others find it.*

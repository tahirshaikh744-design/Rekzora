# Rekzora — GitHub Release Guide

**Brand:** NEURON TS LABS · **Author:** Mohd Tahir Shaikh · <tahirshaikh744@gmail.com>

## 0. One-time setup
1. Create the GitHub repository (e.g. `github.com/tahirshaikh744-design/rekzora`).
2. In `package.json`, update `homepage`, `repository.url`, and `bugs.url`
   if your repo path differs (currently `tahirshaikh744-design/rekzora`).

## 1. Prepare the local git repo
```powershell
powershell -ExecutionPolicy Bypass -File scripts\prepare-release.ps1 -RepoUrl https://github.com/tahirshaikh744-design/rekzora.git
```
This initializes git, sets your identity (name/email), adds the remote,
creates `.gitignore`-based commit, and is safe to re-run.

Then push:
```powershell
git push -u origin main
```

## 2. Build the installers locally (both types)
```powershell
powershell -ExecutionPolicy Bypass -File scripts\build.ps1
```
Outputs (in `dist\`):
- `Rekzora-Setup-<version>.exe` — assisted installer with the enterprise
  privacy-policy page (**I Agree / I Disagree** radio gates, brand header)
- `Rekzora-Portable-<version>.exe` — single-file portable; its first launch
  shows the same policy in-app with **I Agree / I Disagree**

Both EXEs carry publisher metadata **NEURON TS LABS**
(File version info: CompanyName, Product, Copyright © 2026 NEURON TS LABS —
Mohd Tahir Shaikh).

## 3. Publish to GitHub Releases
### Option A — fully automatic (recommended)
Push a version tag; the provided workflow builds and publishes:
```powershell
git tag v1.0.0
git push origin v1.0.0
```

### Option B — from your local build (needs GitHub CLI)
```powershell
gh release create v1.0.0 .\dist\Rekzora-Setup-*.exe .\dist\Rekzora-Portable-*.exe `
  --title "Rekzora 1.0.0 — by NEURON TS LABS" `
  --notes-file RELEASE-NOTES.md
```

### Option C — from the build script
```powershell
$env:GH_TOKEN = "<your GitHub personal-access-token with repo scope>"
powershell -File scripts\build.ps1 -Publish   # uploads a draft release
```

## 4. "Unknown publisher" in UAC (code signing)
**Why it happens:** UAC reads the *digital signature* of the EXE, not its
version-info text. Unsigned files always show "Unknown publisher" on any
admin prompt — no metadata can change that.

### What Rekzora already does (no certificate needed)
- `perMachine: false` → the installer asks **no admin rights at all**, so
  there is **no UAC prompt** when running the Setup (installs per-user to
  `%LOCALAPPDATA%\Programs\Rekzora`, VS Code-style).
- `portable.requestExecutionLevel: "user"` + `requestedExecutionLevel: "asInvoker"`
  → the portable EXE never triggers UAC either.

### To get the real "NEURON TS LABS" verified publisher
1. Buy an Authenticode **OV or EV** code-signing certificate issued to
   exactly **NEURON TS LABS** (SSL.com, Certum, Sectigo, DigiCert…).
2. Sign **without editing package.json** — electron-builder signs
   everything automatically when these env vars are set:
   ```powershell
   $env:CSC_LINK = "C:\path\to\NEURON_TS_LABS.pfx"   # or a URL / Azure URI
   $env:CSC_KEY_PASSWORD = "<pfx password>"
   powershell -File scripts\build.ps1
   ```
   (Options for the traditional way: add `"certificateSubjectName":
   "NEURON TS LABS"` or `"certificateFile"` to the `"win"` section.)
3. Rebuild — UAC, file Properties and Windows' app list all show
   **NEURON TS LABS** as the *verified* publisher.

EV certificates give instant SmartScreen reputation; OV builds
reputation gradually from download counts.

**SmartScreen note (unsigned/first runs):** on other people's PCs the
blue "Windows protected your PC" banner may appear on first launch of
an unsigned download — that's SmartScreen, not UAC. "More info → Run
anyway" proceeds normally. Signing removes both banners.

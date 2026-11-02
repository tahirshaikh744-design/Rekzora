<#
.SYNOPSIS
  Rekzora production build script — produces BOTH installers in .\dist\
    - Rekzora-Setup-<version>.exe      (NSIS assisted installer, EULA page)
    - Rekzora-Portable-<version>.exe   (single-file portable)

.DESCRIPTION
  Brand: NEURON TS LABS. Author: Mohd Tahir Shaikh.
  Uses the portable Node bundled in tools\node - no global Node needed.

  Usage (from the project folder):
      powershell -ExecutionPolicy Bypass -File scripts\build.ps1

  Optional:
      -Publish        publish to GitHub Releases (needs GH_TOKEN env var)
      -Version X.Y.Z  override version for this build

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\build.ps1 -Publish
#>
param(
  [switch]$Publish,
  [string]$Version = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    Write-Host ""
    Write-Host "================ Rekzora build (NEURON TS LABS) ================" -ForegroundColor Cyan
    Write-Host "  Per-user install: the Setup asks NO admin -> no UAC prompt," -ForegroundColor DarkGray
    Write-Host "  so unsigned builds show no 'Unknown publisher' box at all." -ForegroundColor DarkGray
    Write-Host "  To show 'NEURON TS LABS' as verified publisher: set CSC_LINK" -ForegroundColor DarkGray
    Write-Host "  and CSC_KEY_PASSWORD env vars (see RELEASE.md #4), rebuild." -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  With an Authenticode cert for NEURON TS LABS add to the"
    Write-Host "  'win' section of package.json:"
    Write-Host '    "certificateSubjectName": "NEURON TS LABS"'
    Write-Host ""

    # --- 1. Put bundled Node on PATH --------------------------------------
    $nodeBin = Join-Path $root "tools\node"
    if (-not (Test-Path (Join-Path $nodeBin "node.exe"))) {
        throw "tools\node\node.exe not found (portable Node bundle missing)."
    }
    $env:PATH = "$nodeBin;$env:PATH"

    # --- 2. Install JS dependencies if missing ----------------------------
    $haveElectron = Test-Path "$root\node_modules\electron\dist\electron.exe"
    $haveBuilder  = Test-Path "$root\node_modules\electron-builder"
    if (-not ($haveElectron -and $haveBuilder)) {
        Write-Host "[1/4] Installing JS dependencies (first run only)..."
        & "$nodeBin\npm.cmd" install --no-audit --no-fund 2>&1 | ForEach-Object { "$_" } | Select-Object -Last 3
        if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
    } else {
        Write-Host "[1/4] Dependencies present - skipping npm install"
    }

    # --- 3. Generate the RTF EULA shown on the installer license page -----
    Write-Host "[2/4] Generating Privacy Policy / EULA page (build\license.rtf)..."
    & "$nodeBin\node.exe" (Join-Path $PSScriptRoot "make-license-rtf.cjs")
    if ($LASTEXITCODE -ne 0) { throw "license.rtf generation failed" }

    # --- 4. Build: NSIS setup + portable (BOTH) ---------------------------
    Write-Host "[3/4] Building Windows targets (NSIS setup + portable)..."
    $ebArgs = @("--win", "nsis", "portable")
    if ($Publish) {
        if (-not $env:GH_TOKEN) { throw "-Publish requires the GH_TOKEN environment variable" }
        $ebArgs += "--publish", "always"
    }
    & "$root\node_modules\.bin\electron-builder.cmd" @ebArgs
    if ($LASTEXITCODE -ne 0) { throw "electron-builder failed" }

    # --- 5. Report outputs ------------------------------------------------
    Write-Host "[4/4] Done. Installer outputs in .\dist\ :" -ForegroundColor Green
    $exes = Get-ChildItem "$root\dist" -Filter *.exe -ErrorAction SilentlyContinue
    foreach ($e in $exes) {
        $mb = [math]::Round($e.Length / 1MB, 1)
        Write-Host "      $($e.Name)  ($mb MB)"
    }

    Write-Host ""
    Write-Host "Next steps for a GitHub release:" -ForegroundColor Cyan
    Write-Host "  1) Set your repo URL in package.json (repository / homepage / bugs)"
    Write-Host "  2) powershell -File scripts\prepare-release.ps1 -RepoUrl https://github.com/tahirshaikh744-design/rekzora.git"
    Write-Host "  3) git commit + push, then tag v1.0.0 to publish via GitHub Actions"
    Write-Host "  4) or: gh release create v<version> .\dist\Rekzora-Setup-1.0.0.exe .\dist\Rekzora-Portable-1.0.0.exe -t Rekzora -F RELEASE-NOTES.md"
} finally {
    Pop-Location
}

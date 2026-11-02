<# Prepares the local repo for a GitHub release.
   Brand: NEURON TS LABS · Author: Mohd Tahir Shaikh #>
param(
  [Parameter(Mandatory = $true)]
  [string]$RepoUrl,                      # e.g. https://github.com/tahirshaikh744-design/rekzora.git
  [string]$Name = "Mohd Tahir Shaikh",
  [string]$Email = "tahirshaikh744@gmail.com"
)
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw "git not found. Install it from https://git-scm.com then re-run."
}

# Init repo if needed
if (-not (Test-Path .git)) {
  git init
  if (-not $?) { throw "git init failed" }
}

# Author identity (yours, used for every commit + release)
git config user.name  "$Name"
git config user.email "$Email"
Write-Host "[git] identity: $Name <$Email>"

# Default branch
git branch -M main 2>$null | Out-Null

# Remote (replace or add)
$existing = git remote | Out-String
if ($existing -match "origin") {
  git remote set-url origin "$RepoUrl"
  Write-Host "[git] origin updated → $RepoUrl"
} else {
  git remote add origin "$RepoUrl"
  Write-Host "[git] origin added → $RepoUrl"
}

# Stage everything except ignored files
git add -A
Write-Host "[git] all files staged (see .gitignore)."

Write-Host ""
Write-Host "Done. Review and commit:" -ForegroundColor Green
Write-Host "  git commit -m 'Rekzora: first release by NEURON TS LABS'"
Write-Host "  git push -u origin main"
Write-Host "  git tag v1.0.0 ; git push origin v1.0.0   # triggers the release workflow"

param([string]$File)
$t = $null; $e = $null
[System.Management.Automation.Language.Parser]::ParseFile($File, [ref]$t, [ref]$e) | Out-Null
if ($e -and $e.Count -gt 0) {
  foreach ($x in $e) { Write-Host "PARSE ERROR: $($x.Message)" }
  exit 1
}
Write-Host "PARSE OK: $File"

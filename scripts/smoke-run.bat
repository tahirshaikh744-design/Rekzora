@echo off
rem Headless smoke test: records 3s of the primary screen, verifies the
rem WebM structure + library entry + duration, then quits. Same check
rem GitHub CI runs. The app's exit code is propagated honestly:
rem 0 = all assertions passed, non-zero = failure (CI must gate on this).
cd /d "%~dp0.."
set REKZORA_SMOKE=1
if not exist logs mkdir logs
rem Since electron 45, npm install does NOT fetch the runtime binary
rem (no postinstall hook). Verify it up front and fail with a clear
rem reason instead of cmd's silent "exit code 3" (path not found):
if not exist node_modules\electron\dist\electron.exe (
  echo [smoke] ABORTING: node_modules\electron\dist\electron.exe is missing.
  echo [smoke] electron 45+ does not auto-install its binary; run: node node_modules\electron\install.js
  exit /b 1
)
rem Launch the app. The exit code alone is not enough here: when the log
rem file cannot be opened for the redirect, cmd skips the launch line and
rem silently leaves %ERRORLEVEL% at 0 — a false PASS. So we build two
rem defenses: a non-zero pre-set sentinel, and a size check that refuses
rem exit 0 unless the log actually grew during this run:
set SMOKE_EXIT=2
for %%A in (logs\rekzora.log) do set LOG_START_BYTES=%%~zA
node_modules\electron\dist\electron.exe . >> logs\rekzora.log 2>&1
set SMOKE_EXIT=%ERRORLEVEL%
if not exist logs\rekzora.log set SMOKE_EXIT=2
for %%A in (logs\rekzora.log) do if %%~zA EQU %LOG_START_BYTES% set SMOKE_EXIT=2
if "%SMOKE_EXIT%"=="2" echo [smoke] ABORTING: there is no evidence the app ran - the log did not grow, so the launch was skipped or the log was unwritable - a PASS cannot be claimed.
echo smoke exit code: %SMOKE_EXIT%
if not "%SMOKE_EXIT%"=="0" echo see logs\rekzora.log for details ([smoke] / [smkdbg] lines)
exit /b %SMOKE_EXIT%

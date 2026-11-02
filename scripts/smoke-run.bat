@echo off
rem Headless smoke test: records 3s of the primary screen, verifies the
rem WebM structure + library entry + duration, then quits. Same check
rem GitHub CI runs. The app's exit code is propagated honestly:
rem 0 = all assertions passed, non-zero = failure (CI must gate on this).
cd /d "%~dp0.."
set REKZORA_SMOKE=1
if not exist logs mkdir logs
node_modules\electron\dist\electron.exe . >> logs\rekzora.log 2>&1
set SMOKE_EXIT=%ERRORLEVEL%
echo smoke exit code: %SMOKE_EXIT%
if not "%SMOKE_EXIT%"=="0" echo see logs\rekzora.log for details ([smoke] / [smkdbg] lines)
exit /b %SMOKE_EXIT%

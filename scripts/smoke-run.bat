@echo off
rem Headless smoke test: records 3s of the primary screen, verifies the
rem file lands in the library, then quits. Same check GitHub CI runs.
cd /d "%~dp0.."
set REKZORA_SMOKE=1
if not exist logs mkdir logs
node_modules\electron\dist\electron.exe . >> logs\rekzora.log 2>&1

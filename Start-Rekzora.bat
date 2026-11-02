@echo off
cd /d "%~dp0"
if not exist logs mkdir logs
echo [%date% %time%] Starting Rekzora... >> logs\rekzora.log
"node_modules\electron\dist\electron.exe" . >> logs\rekzora.log 2>&1

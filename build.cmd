@echo off
rem ============================================================
rem  Rekzora - local release build script
rem  Brand: NEURON TS LABS   |   Author: Mohd Tahir Shaikh
rem  Usage: build.cmd [all / installer / portable]     (default: all)
rem
rem  Honest by design: every step's exit code is captured and
rem  returned by this script. A completion banner is printed only
rem  when the artifacts were actually produced and verified.
rem ============================================================
setlocal EnableExtensions
chcp 65001 >nul
title Rekzora build - NEURON TS LABS / Mohd Tahir Shaikh
cd /d "%~dp0"

set "F_CODE=0"
set "F_WHY="

call :banner

rem -------- toolchain: prefer the bundled tools\node, fall back to PATH --------
set "NODE_EXE="
set "NPM_CMD="
if exist "tools\node\node.exe" set "NODE_EXE=%~dp0tools\node\node.exe"
if exist "tools\node\npm.cmd" set "NPM_CMD=%~dp0tools\node\npm.cmd"
if not defined NODE_EXE (
  where node >nul 2>nul
  if not errorlevel 1 set "NODE_EXE=node"
  where npm >nul 2>nul
  if not errorlevel 1 set "NPM_CMD=npm"
)
if not defined NODE_EXE (
  set "F_CODE=11"
  set "F_WHY=Node.js was not found - install Node 22 or restore tools\node"
  goto :finale
)

rem -------- build target --------
set "TARGET=%~1"
if "%TARGET%"=="" set "TARGET=all"
set "DIST_SCRIPT="
if /i "%TARGET%"=="all" set "DIST_SCRIPT=dist"
if /i "%TARGET%"=="installer" set "DIST_SCRIPT=dist:installer"
if /i "%TARGET%"=="portable" set "DIST_SCRIPT=dist:portable"
if not defined DIST_SCRIPT (
  set "F_CODE=60"
  set "F_WHY=unknown target %TARGET% - usage: build.cmd [all / installer / portable]"
  goto :finale
)

rem -------- version from package.json --------
set "VERSION="
for /f "usebackq delims=" %%V in (`powershell -NoProfile -Command "(Get-Content package.json -Raw | ConvertFrom-Json).version"`) do set "VERSION=%%V"
if "%VERSION%"=="" (
  set "F_CODE=12"
  set "F_WHY=could not read the version from package.json"
  goto :finale
)

rem =====================================================================
rem  Step 1 - dependencies: npm ci only when node_modules is incomplete
rem =====================================================================
call :pc Cyan " STEP 1/5 - Dependencies"
set "NEED_CI=0"
if not exist "node_modules\" set "NEED_CI=1"
if not exist "node_modules\electron\package.json" set "NEED_CI=1"
if not exist "node_modules\electron-builder\package.json" set "NEED_CI=1"
if "%NEED_CI%"=="1" (
  call :pc DarkCyan "  installing dependencies with npm ci - reproducible from package-lock.json ..."
  call "%NPM_CMD%" ci --no-audit --no-fund
  if errorlevel 1 (
    set "F_CODE=20"
    set "F_WHY=npm ci failed - see the npm output above"
    goto :finale
  )
) else (
  call :pc DarkGray "  node_modules already complete - skipping npm ci"
)

rem -------- electron runtime: since electron 45, npm does not fetch it --------
if not exist "node_modules\electron\dist\electron.exe" (
  call :pc DarkCyan "  electron runtime binary missing - running the package's own installer (node_modules\electron\install.js) ..."
  call "%NODE_EXE%" node_modules\electron\install.js
  if errorlevel 1 (
    set "F_CODE=21"
    set "F_WHY=electron runtime install failed - see output above"
    goto :finale
  )
)
if not exist "node_modules\electron\dist\electron.exe" (
  set "F_CODE=22"
  set "F_WHY=node_modules\electron\dist\electron.exe is still missing after install"
  goto :finale
)
call :pc DarkGreen "  electron runtime binary present - ok"

rem =====================================================================
rem  Step 2 - EULA RTF (installer license page, same as CI)
rem =====================================================================
call :pc Cyan " STEP 2/5 - EULA RTF"
call "%NODE_EXE%" scripts\make-license-rtf.cjs
if errorlevel 1 (
  set "F_CODE=30"
  set "F_WHY=scripts\make-license-rtf.cjs failed - see output above"
  goto :finale
)
if not exist "build\license.rtf" (
  set "F_CODE=31"
  set "F_WHY=build\license.rtf was not generated"
  goto :finale
)
call :pc DarkGreen "  build\license.rtf ready - ok"

rem =====================================================================
rem  Step 3 - electron-builder packaging (never publishes from the repo)
rem =====================================================================
call :pc Cyan " STEP 3/5 - Packaging %TARGET% via electron-builder"
set "CSC_IDENTITY_AUTO_DISCOVERY=FALSE"
rem  The npm script carries the Windows target config from package.json;
rem  the extra --publish never makes a local build upload absolutely nothing.
call "%NPM_CMD%" run %DIST_SCRIPT% -- --publish never
if errorlevel 1 (
  set "F_CODE=40"
  set "F_WHY=electron-builder failed with exit %ERRORLEVEL% - see the builder output above"
  goto :finale
)

rem =====================================================================
rem  Step 4 - verify artifacts + SHA-256 checksums
rem =====================================================================
call :pc Cyan " STEP 4/5 - Verify artifacts + SHA-256 checksums"
set "MIN_EXES=1"
if /i "%TARGET%"=="all" set "MIN_EXES=2"
if not exist "dist\" (
  set "F_CODE=50"
  set "F_WHY=the dist\ directory does not exist - the build produced nothing"
  goto :finale
)
call "%NODE_EXE%" scripts\make-checksums.cjs %MIN_EXES%
if errorlevel 1 (
  set "F_CODE=51"
  set "F_WHY=checksum step failed - artifacts missing or unreadable - see output above"
  goto :finale
)

rem =====================================================================
rem  Step 5 - artifact report
rem =====================================================================
call :pc Cyan " STEP 5/5 - Artifacts"
powershell -NoProfile -Command "Get-ChildItem dist -Filter *.exe | ForEach-Object { '  {0,7:N1} MB  {1}' -f ($_.Length / 1MB), $_.Name }"
echo.
goto :finale

rem ===================== subroutines ==================================

:pc
rem  :pc colorname "text" - one colored line. PowerShell colors work in
rem  every Windows console host, no ANSI-escape dependency.
powershell -NoProfile -Command "Write-Host '%~2' -ForegroundColor %1"
goto :eof

:banner
call :pc Cyan   "  ██████╗ ███████╗██╗  ██╗███████╗ ██████╗ ██████╗  █████╗ "
call :pc Cyan   "  ██╔══██╗██╔════╝██║ ██╔╝██╔════╝██╔═══██╗██╔══██╗██╔══██╗"
call :pc Cyan   "  ██████╔╝█████╗  █████╔╝   ███╔╝ ██║   ██║██████╔╝███████║"
call :pc Cyan   "  ██╔══██╗██╔══╝  ██╔═██╗  ███╔╝ ██║   ██║██╔══██╗██╔══██║"
call :pc Cyan   "  ██║  ██║███████╗██║  ██╗███████╗╚██████╔╝██║  ██║██║  ██║"
call :pc Cyan   "  ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚══════╝ ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝"
call :pc White  "   Screen Recorder for Windows"
call :pc Yellow "   NEURON TS LABS  |  Mohd Tahir Shaikh"
call :pc DarkCyan "  open source  -  offline first  -  MIT"
call :pc DarkGray "  usage: build.cmd [all / installer / portable]"
echo.
echo.
goto :eof

:finale
echo.
echo.
if "%F_CODE%"=="0" (
  call :pc Green  "  ██████╗  BUILD COMPLETE  ██████╗"
  call :pc White  "  Rekzora %VERSION%  -  Windows x64 artifacts ready in dist\"
  call :pc Yellow "  NEURON TS LABS  |  Author: Mohd Tahir Shaikh  |  MIT"
  if exist "dist\SHA256SUMS.txt" (
    call :pc DarkGray "  SHA-256 checksums written to dist\SHA256SUMS.txt:"
    type "dist\SHA256SUMS.txt"
  )
) else (
  call :pc Red "  ██████╗  BUILD FAILED - exit code %F_CODE%  ██████╗"
  if not "%F_WHY%"=="" call :pc DarkYellow "  Reason: %F_WHY%"
)
echo.
endlocal & exit /b %F_CODE%

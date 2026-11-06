@echo off
rem ============================================================
rem  Rekzora - local release build script
rem  Brand: NEURON TS LABS   |   Author: Mohd Tahir Shaikh
rem  Usage: build.cmd [all / installer / portable]     (default: all)
rem
rem  Honest by design: every step's exit code is captured and
rem  returned by this script. A completion banner is printed only
rem  when the artifacts were actually produced and verified.
rem  The window stays open on double-click so failures are readable,
rem  and the whole styling is batch-native: zero PowerShell at startup
rem  (the first version spawned PowerShell per line and felt frozen).
rem ============================================================
setlocal EnableExtensions
chcp 65001 >nul
title Rekzora build - NEURON TS LABS / Mohd Tahir Shaikh
cd /d "%~dp0"

set "F_CODE=0"
set "F_WHY="

rem ---------- branded header: pure batch, instant, no processes ----------
color 0B
echo.
echo   ██████╗ ███████╗██╗  ██╗███████╗ ██████╗ ██████╗  █████╗
echo   ██╔══██╗██╔════╝██║ ██╔╝██╔════╝██╔═══██╗██╔══██╗██╔══██╗
echo   ██████╔╝█████╗  ██████╔╝   ███╔╝ ██║   ██║██████╔╝███████║
echo   ██╔══██╗██╔══╝  ██╔═██╗  ███╔╝ ██║   ██║██╔══██╗██╔══██║
echo   ██║  ██║███████╗██║  ██╗███████╗╚██████╔╝██║  ██║██║  ██║
echo   ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚══════╝ ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝
color 0E
echo    Screen Recorder for Windows
echo    NEURON TS LABS  -  Author: Mohd Tahir Shaikh
color 09
echo    open source  -  offline first  -  MIT
color 0F
echo.

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

rem -------- make sure the bundled node dir is on PATH --------
rem  npm run's .bin shims (electron-builder.cmd) call `node` by name from
rem  PATH; npm.cmd prepends its own dir but the .bin shims do not - without
rem  this, a double-click run fails with: 'node' is not recognized.
if exist "%~dp0tools\node" set "PATH=%~dp0tools\node;%PATH%"

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

rem -------- version from package.json (Node, not PowerShell: instant) --------
rem  Written to a temp file then read with set /p: the direct `for /f` form
rem  re-runs the command through a child cmd /c, which strips the quotes
rem  from the space-containing tools\node path.
set "VERSION="
"%NODE_EXE%" -p "require('./package.json').version" > "%TEMP%\rekzora-version.tmp" 2>nul
set /p VERSION=<"%TEMP%\rekzora-version.tmp" 2>nul
del "%TEMP%\rekzora-version.tmp" >nul 2>&1
if "%VERSION%"=="" (
  set "F_CODE=12"
  set "F_WHY=could not read the version from package.json"
  goto :finale
)
echo   ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
echo    Rekzora %VERSION%  -  local build  -  target: %TARGET%
echo   ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
echo.

rem =====================================================================
rem  Step 1 - dependencies: npm ci only when node_modules is incomplete
rem  (since electron 45, the npm package ships no postinstall hook - the
rem  runtime binary is fetched explicitly, never by npm ci itself)
rem =====================================================================
echo   STEP 1/5 - Dependencies
set "NEED_CI=0"
if not exist "node_modules\" set "NEED_CI=1"
if not exist "node_modules\electron\package.json" set "NEED_CI=1"
if not exist "node_modules\electron-builder\package.json" set "NEED_CI=1"
if "%NEED_CI%"=="1" (
  echo     installing dependencies with npm ci - reproducible from package-lock.json - the first run takes a few minutes...
  call "%NPM_CMD%" ci --no-audit --no-fund
  if errorlevel 1 (
    set "F_CODE=20"
    set "F_WHY=npm ci failed - see the npm output above"
    goto :finale
  )
) else (
  echo     node_modules already complete - skipping npm ci
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo     electron runtime binary missing - running the package's own installer - downloads the binary once...
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
echo     electron runtime binary present - ok
echo.

rem =====================================================================
rem  Step 2 - EULA RTF (installer license page, same as CI)
rem =====================================================================
echo   STEP 2/5 - EULA RTF
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
echo     build\license.rtf ready - ok
echo.

rem =====================================================================
rem  Step 3 - electron-builder packaging (never publishes from the repo)
rem =====================================================================
echo   STEP 3/5 - Packaging %TARGET% via electron-builder - this window is quiet for a bit while the builder works...
set "CSC_IDENTITY_AUTO_DISCOVERY=FALSE"
rem  The npm script carries the Windows target config from package.json;
rem  the extra --publish never makes a local build upload absolutely nothing.
call "%NPM_CMD%" run %DIST_SCRIPT% -- --publish never
if errorlevel 1 (
  set "F_CODE=40"
  set "F_WHY=electron-builder failed with exit %ERRORLEVEL% - see the builder output above"
  goto :finale
)
echo.

rem =====================================================================
rem  Step 4 - verify artifacts + SHA-256 checksums
rem =====================================================================
echo   STEP 4/5 - Verify artifacts + SHA-256 checksums
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
echo.

rem =====================================================================
rem  Step 5 - artifact report
rem =====================================================================
echo   STEP 5/5 - Artifacts
for %%A in (dist\*.exe) do if /i "%%~xA"==".exe" echo     %%~zA bytes  -  %%~nxA
echo.
goto :finale

rem =====================================================================
rem  Status + honest exit. Colored the deterministic bat way (color):
rem  and when the script was double-clicked, the window stays open until
rem  a key is pressed so the outcome (reason included) is readable.
rem =====================================================================
:finale
echo.
echo.
if "%F_CODE%"=="0" (
  color 0A
  echo   ██████╗  BUILD COMPLETE  ██████╗
  echo   Rekzora %VERSION%  -  Windows x64 artifacts ready in dist\
  color 0E
  echo   NEURON TS LABS  -  Author: Mohd Tahir Shaikh  -  MIT
  color 0F
  if exist "dist\SHA256SUMS.txt" (
    echo.
    echo   SHA-256 checksums are in dist\SHA256SUMS.txt:
    type "dist\SHA256SUMS.txt"
  )
) else (
  color 0C
  echo   ██████╗  BUILD FAILED - exit code %F_CODE%  ██████╗
  color 0E
  echo   Reason: %F_WHY%
  echo   Scroll up to the failing step to see the detailed output.
  color 0F
)
echo.
rem  Explorer double-click invokes cmd with /c and this script on the line;
rem  an already-open terminal does not, so it gets no pause there.
echo %cmdcmdline% | find /i "%~f0" >nul
if not errorlevel 1 (
  echo   Press any key to close this window...
  pause >nul
)
endlocal & exit /b %F_CODE%

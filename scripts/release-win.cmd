@echo off
REM scripts/release-win.cmd
REM
REM One-shot Windows release flow. Mirrors scripts/release-win.ps1
REM but runs in plain cmd.exe (no PowerShell dependency). Run from
REM the repo root on a Windows machine with all build toolchains
REM present (Node 20+, pnpm 11+, MSVC build tools for better-sqlite3
REM native rebuild).
REM
REM What it does, in order:
REM   1. pnpm install (re-syncs node_modules against package.json
REM      and pnpm-lock.yaml; required if either changed)
REM   2. removes out/, dist/, node_modules/.cache/, .electron-vite/
REM   3. pnpm rebuild - re-compiles better-sqlite3 against the
REM      exact Electron version we ship
REM   4. pnpm build - electron-vite build, writes out/
REM   5. pnpm dist:win - electron-builder for Windows (NSIS x64);
REM      default --publish never, so it does NOT attempt to PUT
REM   6. runs scripts/generate-latest-yml.mjs against the produced
REM      installer to emit latest.yml next to it
REM
REM Usage:
REM   scripts\release-win.cmd
REM
REM With an explicit version override (defaults to package.json):
REM   scripts\release-win.cmd 1.0.0-rc4

setlocal EnableExtensions

cd /d "%~dp0\.."

set "VERSION=%~1"

if "%VERSION%"=="" goto :version_ok
echo Using version override: %VERSION%
goto :version_check_done
:version_ok
echo Using version from package.json
:version_check_done

call :step "pnpm install" pnpm install || goto :fail
call :step "clean out/, dist/, caches" cmd /c "if exist out rmdir /s /q out & if exist dist rmdir /s /q dist & if exist node_modules\.cache rmdir /s /q node_modules\.cache & if exist .electron-vite rmdir /s /q .electron-vite" || goto :fail
call :step "pnpm rebuild (better-sqlite3 native)" pnpm rebuild || goto :fail
call :step "pnpm build (electron-vite)" pnpm build || goto :fail
call :step "pnpm dist:win (electron-builder)" pnpm dist:win || goto :fail

call :find_installer
if "%INSTALLER%"=="" goto :no_installer

call :step "generate-latest-yml.mjs" node scripts\generate-latest-yml.mjs "%INSTALLER%" %VERSION% || goto :fail

echo.
echo release artifacts ready under dist\
echo next: upload dist\ai-todo-list-Setup-*.exe and dist\latest.yml to the GitCode release
exit /b 0

:fail
echo.
echo ERROR: release flow failed at the previous step
exit /b 1

:no_installer
echo.
echo ERROR: could not find ai-todo-list-Setup-*.exe under dist\
echo Did pnpm dist:win actually produce an installer?
exit /b 1

REM ------------------------------------------------------------
REM step(name, command...) - run a labelled step, abort on error
REM ------------------------------------------------------------
:step
set "STEP_NAME=%~1"
shift
echo.
echo ==^> %STEP_NAME%
%*
set "EC=%ERRORLEVEL%"
if not "%EC%"=="0" (
    echo step "%STEP_NAME%" failed with exit code %EC%
    exit /b %EC%
)
exit /b 0

REM ------------------------------------------------------------
REM find_installer - locate the freshly produced .exe and stash
REM the absolute path in %INSTALLER%
REM ------------------------------------------------------------
:find_installer
set "INSTALLER="
for /f "delims=" %%I in ('dir /b /a-d "dist\ai-todo-list-Setup-*.exe" 2^>nul') do (
    if not "%%I"=="" set "INSTALLER=%CD%\dist\%%I"
)
exit /b 0
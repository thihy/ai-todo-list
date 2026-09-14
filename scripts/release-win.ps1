# scripts/release-win.ps1
#
# One-shot Windows release flow. Run from the repo root on a
# Windows machine with all build toolchains present (Node 20+,
# pnpm 11+, MSVC build tools for better-sqlite3 native rebuild).
#
# What it does, in order:
#   1. pnpm install (re-syncs node_modules against package.json
#      and pnpm-lock.yaml — required if either changed since
#      the last install; will be a no-op if not)
#   2. removes out/, dist/, node_modules/.cache/, .electron-vite/
#      so electron-builder and electron-vite don't reuse stale
#      chunks or half-downloaded binaries
#   3. pnpm rebuild — re-compiles better-sqlite3 against the
#      exact Electron version we ship. Without this the native
#      module ABI mismatches the bundled Electron and the app
#      crashes on launch with "The module ... was compiled
#      against a different Node.js version"
#   4. pnpm build — runs electron-vite build, writes out/
#   5. pnpm dist:win — runs electron-builder for Windows (NSIS
#      x64 installer); default --publish never, so it does NOT
#      attempt to PUT to GitCode
#   6. runs scripts/generate-latest-yml.mjs against the
#      produced installer to emit latest.yml next to it
#
# After this script finishes, the release engineer uploads
# two files by hand to the GitCode release page:
#   - dist/ai-todo-list-Setup-${version}.exe
#   - dist/latest.yml
#
# Run with PowerShell 5+ (built into Windows) or PowerShell 7+:
#   powershell -ExecutionPolicy Bypass -File scripts\release-win.ps1
#
# Or if you have PowerShell 7 installed:
#   pwsh -File scripts/release-win.ps1
#
# Or with an explicit version override (defaults to
# package.json):
#   pwsh -File scripts/release-win.ps1 -Version 1.0.0-rc4

param(
  [string]$Version = ''
)

$ErrorActionPreference = 'Stop'
$repoRoot = Resolve-Path (Join-Path -Path $PSScriptRoot -ChildPath '..')
Set-Location $repoRoot

function Step($name, [scriptblock]$block) {
  Write-Host ""
  Write-Host "==> $name" -ForegroundColor Cyan
  & $block
  if ($LASTEXITCODE -ne 0) {
    throw "step '$name' failed with exit code $LASTEXITCODE"
  }
}

Step 'pnpm install' {
  pnpm install
}

Step 'clean out/, dist/, caches' {
  foreach ($dir in @('out', 'dist', 'node_modules/.cache', '.electron-vite')) {
    if (Test-Path $dir) {
      Write-Host "  removing $dir"
      Remove-Item -Recurse -Force $dir
    }
  }
}

Step 'pnpm rebuild (better-sqlite3 native)' {
  pnpm rebuild
}

Step 'pnpm build (electron-vite)' {
  pnpm build
}

Step 'pnpm dist:win (electron-builder)' {
  pnpm dist:win
}

$versionArg = @()
if ($Version -ne '') {
  $versionArg = @($Version)
}

Step 'generate-latest-yml.mjs' {
  # Find the installer that pnpm dist:win just produced.
  $installer = Get-ChildItem -Path dist -Filter 'ai-todo-list-Setup-*.exe' -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $installer) {
    throw "could not find ai-todo-list-Setup-*.exe under dist/ — did dist:win succeed?"
  }
  node scripts/generate-latest-yml.mjs $installer.FullName @versionArg
}

Write-Host ""
Write-Host "release artifacts ready under dist/" -ForegroundColor Green
Write-Host "next: upload dist/ai-todo-list-Setup-*.exe and dist/latest.yml to the GitCode release"
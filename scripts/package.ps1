<#
Builds dist/modpack-studio-<Version>.zip:
  versions/<Version>/  built app (server sources, dist/web, node_modules without dev deps, drizzle migrations, run.cmd)
  current              pointer file holding the active version (switched at install time, kept across updates)
The data directory is never part of the zip: it lives next to versions/ and survives updates.
Usage: pwsh scripts/package.ps1 -Version 0.1.0 [-NodeExe <path to a portable node.exe>]
#>
param(
    [Parameter(Mandatory = $true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version,
    [string]$NodeExe = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$stage = Join-Path $root "dist\stage-$Version"
$app = Join-Path $stage "versions\$Version"
$zip = Join-Path $root "dist\modpack-studio-$Version.zip"

Remove-Item -Recurse -Force $stage, $zip, "$zip.sha256" -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $app | Out-Null

Push-Location $root
try {
    npm run build:web | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'web build failed' }

    Copy-Item -Recurse src (Join-Path $app 'src')
    Copy-Item -Recurse drizzle (Join-Path $app 'drizzle')
    New-Item -ItemType Directory (Join-Path $app 'dist') | Out-Null
    Copy-Item -Recurse dist\web (Join-Path $app 'dist\web')
    Copy-Item package.json, package-lock.json, tsconfig.json (Join-Path $app '.')

    Push-Location $app
    npm ci --omit=dev --ignore-scripts=false | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
    npm install --no-save tsx | Out-Host   # tsx runs the TypeScript server sources
    Pop-Location

    if ($NodeExe) {
        New-Item -ItemType Directory -Force (Join-Path $app 'runtime') | Out-Null
        Copy-Item $NodeExe (Join-Path $app 'runtime\node.exe')
    }

    # run.cmd: uses the bundled node.exe when present, else the node on PATH (must be Node 24 LTS)
    @'
@echo off
setlocal
cd /d "%~dp0"
set "STUDIO_DATA=%~dp0..\..\data"
if not defined UV_THREADPOOL_SIZE set "UV_THREADPOOL_SIZE=32"
if exist "runtime\node.exe" (set "NODE=runtime\node.exe") else (set "NODE=node")
"%NODE%" --import tsx src\server\main.ts
'@ | Set-Content -Encoding Ascii (Join-Path $app 'run.cmd')

    Set-Content -NoNewline -Encoding Ascii -Path (Join-Path $stage 'current') -Value $Version
    Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip
    $hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
    Set-Content -Encoding Ascii -Path "$zip.sha256" -Value "$hash  $(Split-Path -Leaf $zip)"
    Remove-Item -Recurse -Force $stage
    Write-Host "Built $zip ($hash)"
}
finally {
    Pop-Location
}

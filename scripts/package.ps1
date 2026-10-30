<#
Builds dist/modpack-studio-<Version>.zip:
  versions/<Version>/  built app (server sources, dist/web, production node_modules only, drizzle migrations, run.cmd, BUILD)
  current              pointer file holding the active version (switched at install time, kept across updates)
  start.cmd            stable entry point: reads `current` at run time, then runs versions/<current>/run.cmd
  install-task.ps1     registers start.cmd as the start-at-logon task
The data directory is never part of the zip: it lives next to versions/ and survives updates.
Usage: pwsh scripts/package.ps1 [-Version <must equal package.json's version>] [-NodeExe <path to a portable node.exe>] [-MaxLogMB 5]
#>
param(
    [ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version = '',
    [string]$NodeExe = '',
    # run.cmd rotates studio.log to studio.log.old above this size
    [int]$MaxLogMB = 5
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$pkg = Get-Content -Raw (Join-Path $root 'package.json') | ConvertFrom-Json
if (-not $Version) { $Version = $pkg.version }
if ($Version -ne $pkg.version) { throw "-Version $Version does not match package.json ($($pkg.version)): bump package.json first" }
$minNode = [int][regex]::Match([string]$pkg.engines.node, '\d+').Value
$stage = Join-Path $root "dist\stage-$Version"
$app = Join-Path $stage "versions\$Version"
$zip = Join-Path $root "dist\modpack-studio-$Version.zip"

Remove-Item -Recurse -Force $stage, $zip, "$zip.sha256" -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $app | Out-Null

$crlf = { param([string]$t) ($t -replace "`r?`n", "`r`n") }
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
    try {
        npm ci --omit=dev --ignore-scripts=false | Out-Host   # tsx (runs the TypeScript sources) is a regular dependency
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
    }
    finally { Pop-Location }
    if (-not (Test-Path (Join-Path $app 'node_modules\tsx'))) { throw 'tsx is missing from the packaged node_modules' }
    if (Test-Path (Join-Path $app 'node_modules\typescript')) { throw 'dev dependencies leaked into the package (typescript found)' }

    if ($NodeExe) {
        New-Item -ItemType Directory -Force (Join-Path $app 'runtime') | Out-Null
        Copy-Item $NodeExe (Join-Path $app 'runtime\node.exe')
    }

    # run.cmd: uses the bundled node.exe when present, else the node on PATH (must be Node __MIN__ or newer).
    # Everything it prints goes to data\studio.log (the data folder survives updates), so a failed start at logon leaves a trace.
    $runCmd = @'
@echo off
setlocal
cd /d "%~dp0"
set "STUDIO_DATA=%~dp0..\..\data"
if not exist "%STUDIO_DATA%" mkdir "%STUDIO_DATA%"
set "LOG=%STUDIO_DATA%\studio.log"
if exist "%LOG%" for %%F in ("%LOG%") do if %%~zF GTR __MAXLOG__ move /y "%LOG%" "%LOG%.old" >nul
if not defined UV_THREADPOOL_SIZE set "UV_THREADPOOL_SIZE=32"
if exist "runtime\node.exe" (set "NODE=runtime\node.exe") else (set "NODE=node")
"%NODE%" -e "process.exit(Number(process.versions.node.split('.')[0]) >= __MIN__ ? 0 : 1)" >nul 2>nul
if errorlevel 1 (
  echo %date% %time% Node.js __MIN__ or newer is required, check "node -v". >> "%LOG%"
  echo Node.js __MIN__ or newer is required. See %LOG%
  if "%~1"=="" pause
  exit /b 1
)
echo %date% %time% starting >> "%LOG%"
"%NODE%" --import tsx src\server\main.ts >> "%LOG%" 2>&1
set "CODE=%errorlevel%"
echo %date% %time% stopped, exit code %CODE% >> "%LOG%"
exit /b %CODE%
'@
    $runCmd = (& $crlf $runCmd).Replace('__MIN__', [string]$minNode).Replace('__MAXLOG__', [string]($MaxLogMB * 1MB))
    Set-Content -Encoding Ascii -NoNewline (Join-Path $app 'run.cmd') -Value $runCmd

    # Stable entry point for the logon task: follows `current`, so an update never needs the task to be registered again.
    $startCmd = @'
@echo off
setlocal
if not exist "%~dp0current" (echo Missing "%~dp0current" & exit /b 1)
set /p VER=<"%~dp0current"
if not exist "%~dp0versions\%VER%\run.cmd" (echo Missing versions\%VER%\run.cmd & exit /b 1)
call "%~dp0versions\%VER%\run.cmd" %*
exit /b %errorlevel%
'@
    Set-Content -Encoding Ascii -NoNewline (Join-Path $stage 'start.cmd') -Value (& $crlf $startCmd)
    Copy-Item (Join-Path $root 'scripts\install-task.ps1') (Join-Path $stage 'install-task.ps1')

    # Provenance: which sources this package was built from.
    $commit = 'unknown'; $dirty = 'unknown'
    if (Get-Command git -ErrorAction SilentlyContinue) {
        $c = (& git rev-parse --short HEAD 2>$null)
        if ($LASTEXITCODE -eq 0 -and $c) { $commit = $c; $dirty = if ((& git status --porcelain 2>$null)) { 'dirty' } else { 'clean' } }
    }
    $nodeV = if (Get-Command node -ErrorAction SilentlyContinue) { (& node -v) } else { 'unknown' }
    Set-Content -Encoding Ascii (Join-Path $app 'BUILD') -Value @("version=$Version", "commit=$commit ($dirty)", "built-with-node=$nodeV", "date=$((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))")

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

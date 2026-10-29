<#
Modpack Studio launcher: one menu for install, run, demo, tests and packaging.
Interactive:      Start.cmd   (or: pwsh -File studio.ps1)
Non-interactive:  pwsh -File studio.ps1 -Action setup|start|demo|password|build|test|package|task
Works in Windows PowerShell 5.1 and PowerShell 7.
#>
param(
    [ValidateSet('', 'setup', 'start', 'demo', 'password', 'build', 'test', 'package', 'task')]
    [string]$Action = ''
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$dataDir = if ($env:STUDIO_DATA) { $env:STUDIO_DATA } else { Join-Path $root 'data' }
$demoDir = Join-Path $env:TEMP 'studio-demo'
$minNode = 24
Set-Location $root

# cmd.exe breaks on an orphan quote in PATH, which also breaks npm.
$env:Path = $env:Path -replace '"', ''

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }

function Confirm($question) { return (Read-Host "$question (o/N)") -match '^(o|y)' }

function Get-NodeMajor {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $cmd) { return 0 }
    $v = (& node -v) -replace '^v', ''
    return [int]($v.Split('.')[0])
}

function Update-PathFromRegistry {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = (($machine + ';' + $user) -replace '"', '')
}

function Ensure-Node {
    if ((Get-NodeMajor) -ge $minNode) { return $true }
    Say "Node.js $minNode or newer is required (found: $(if (Get-Command node -ErrorAction SilentlyContinue) { & node -v } else { 'none' }))." Yellow
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Say 'winget is not available. Install Node.js LTS from https://nodejs.org and run this again.' Red
        return $false
    }
    if (-not (Confirm 'Install Node.js LTS with winget now?')) { return $false }
    winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
    Update-PathFromRegistry
    if ((Get-NodeMajor) -ge $minNode) { return $true }
    Say 'Node.js was installed but is not visible yet. Close this window and open it again.' Yellow
    return $false
}

function Run-Npm {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$NpmArgs)
    & npm @NpmArgs
    if ($LASTEXITCODE -ne 0) { throw "npm $($NpmArgs -join ' ') failed (exit $LASTEXITCODE)" }
}

function Has-Password {
    $file = Join-Path $dataDir 'settings.json'
    if (-not (Test-Path $file)) { return $false }
    try { return [bool]((Get-Content -Raw $file | ConvertFrom-Json).passwordHash) } catch { return $false }
}

function Do-Install {
    if (-not (Ensure-Node)) { return }
    Say 'Installing dependencies (npm ci)...' Cyan
    if (Test-Path (Join-Path $root 'package-lock.json')) { Run-Npm ci } else { Run-Npm install }
}

function Do-Password {
    if (-not (Test-Path (Join-Path $root 'node_modules'))) { Do-Install }
    $env:STUDIO_DATA = $dataDir
    Run-Npm run set-password
}

function Do-Build {
    if (-not (Test-Path (Join-Path $root 'node_modules'))) { Do-Install }
    Say 'Building the web interface...' Cyan
    Run-Npm run build:web
}

function Do-Setup {
    Do-Install
    if ((Get-NodeMajor) -lt $minNode) { return }
    Do-Build
    if (-not (Has-Password)) { Say 'No password yet, choose one for the web interface.' Cyan; Do-Password }
    Say 'Setup done. Use "Start" to run it.' Green
}

function Start-Server([string]$data) {
    if (-not (Ensure-Node)) { return }
    if (-not (Test-Path (Join-Path $root 'node_modules')) -or -not (Test-Path (Join-Path $root 'dist\web'))) { Do-Setup }
    $env:STUDIO_DATA = $data
    $port = 8480
    $file = Join-Path $data 'settings.json'
    if (Test-Path $file) {
        try { $p = (Get-Content -Raw $file | ConvertFrom-Json).port; if ($p) { $port = $p } } catch { }
    }
    Say "Starting on http://127.0.0.1:$port (Ctrl+C to stop). Data: $data" Green
    Start-Job -ScriptBlock { param($u) Start-Sleep 4; Start-Process $u } -ArgumentList "http://127.0.0.1:$port" | Out-Null
    Run-Npm start
}

function Do-Start {
    if (-not (Has-Password)) { Say 'No password yet, choose one for the web interface.' Cyan; Do-Password }
    Start-Server $dataDir
}

function Do-Demo {
    if (-not (Ensure-Node)) { return }
    if (-not (Test-Path (Join-Path $root 'node_modules'))) { Do-Install }
    if (-not (Test-Path (Join-Path $root 'dist\web'))) { Do-Build }
    Say "Building synthetic demo data in $demoDir (password: demo)..." Cyan
    & npx tsx scripts/seed-demo.ts $demoDir
    if ($LASTEXITCODE -ne 0) { throw 'seed-demo failed' }
    Start-Server $demoDir
}

function Do-Test {
    if (-not (Test-Path (Join-Path $root 'node_modules'))) { Do-Install }
    Run-Npm run typecheck
    Run-Npm test
}

function Do-Package {
    if (-not (Test-Path (Join-Path $root 'node_modules'))) { Do-Install }
    $version = (Get-Content -Raw (Join-Path $root 'package.json') | ConvertFrom-Json).version
    Say "Packaging version $version..." Cyan
    & (Join-Path $root 'scripts\package.ps1') -Version $version
}

function Do-Task {
    $dir = Read-Host 'Install directory of the packaged app (e.g. D:\ModpackStudio)'
    if (-not $dir) { return }
    $script = Join-Path $root 'scripts\install-task.ps1'
    & $script -InstallDir $dir
    if (Confirm 'Register the logon task for real?') { & $script -InstallDir $dir -Apply }
}

function Show-Status {
    $nodeText = if (Get-Command node -ErrorAction SilentlyContinue) { & node -v } else { 'missing' }
    $nodeOk = (Get-NodeMajor) -ge $minNode
    Say "  Node.js      : $nodeText $(if ($nodeOk) { '(ok)' } else { "(need >= $minNode)" })" $(if ($nodeOk) { 'Green' } else { 'Yellow' })
    Say "  Dependencies : $(if (Test-Path (Join-Path $root 'node_modules')) { 'installed' } else { 'not installed' })"
    Say "  Web build    : $(if (Test-Path (Join-Path $root 'dist\web')) { 'built' } else { 'not built' })"
    Say "  Password     : $(if (Has-Password) { 'set' } else { 'not set' })"
    Say "  Data folder  : $dataDir"
}

function Invoke-Action([string]$name) {
    switch ($name) {
        'setup'    { Do-Setup }
        'start'    { Do-Start }
        'demo'     { Do-Demo }
        'password' { Do-Password }
        'build'    { Do-Build }
        'test'     { Do-Test }
        'package'  { Do-Package }
        'task'     { Do-Task }
    }
}

if ($Action) { Invoke-Action $Action; return }

while ($true) {
    try { Clear-Host } catch { }   # fails when the console is redirected
    Say '=== Modpack Studio ===' Cyan
    Show-Status
    Write-Host ''
    Write-Host '  1  First setup (Node check, dependencies, web build, password)'
    Write-Host '  2  Start Modpack Studio'
    Write-Host '  3  Demo mode (synthetic data, password: demo)'
    Write-Host '  4  Change the password'
    Write-Host '  5  Rebuild the web interface'
    Write-Host '  6  Run tests and type check'
    Write-Host '  7  Package a zip for the Studio PC'
    Write-Host '  8  Register the start-at-logon task (Studio PC)'
    Write-Host '  0  Quit'
    Write-Host ''
    $choice = Read-Host 'Choice'
    $map = @{ '1' = 'setup'; '2' = 'start'; '3' = 'demo'; '4' = 'password'; '5' = 'build'; '6' = 'test'; '7' = 'package'; '8' = 'task' }
    if ($choice -eq '0') { break }
    if (-not $map.ContainsKey($choice)) { continue }
    try { Invoke-Action $map[$choice] } catch { Say "Error: $($_.Exception.Message)" Red }
    Write-Host ''
    Read-Host 'Press Enter to return to the menu' | Out-Null
}

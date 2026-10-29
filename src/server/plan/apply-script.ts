/**
 * apply.ps1 shipped in every update pack. Windows PowerShell 5.1 and PowerShell 7 compatible, ASCII only
 * (5.1 reads a BOM-less script as ANSI), no backtick so it can live in a raw template literal.
 * Safety model: dry run by default, sha256 of every pack file checked before anything moves, replaced or removed
 * files are MOVED into a backup folder inside the instance (never deleted), refuses while the game runs.
 */
const SCRIPT = String.raw`<#
.SYNOPSIS
  Applies a Modpack Studio update pack to one Minecraft instance folder.

.DESCRIPTION
  Without -Apply this is a dry run: everything is checked and printed, nothing is changed.
  With -Apply the script first verifies the sha256 of every file of the pack against changes.json, then MOVES
  (never deletes) the jars listed in remove.txt and every file it would overwrite into
  <InstanceDir>\_studio-backup-<timestamp>\ (same relative paths), then copies mods-add\* into <InstanceDir>\mods\
  and files-add\* into <InstanceDir>\.
  To undo, move the files of the backup folder back to their place.

.EXAMPLE
  .\apply.ps1 -InstanceDir "D:\Instances\LMP"            # dry run, changes nothing
  .\apply.ps1 -InstanceDir "D:\Instances\LMP" -Apply     # does it
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$InstanceDir,
  [switch]$Apply,
  [switch]$Force
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

function Fail([string]$Message) {
  Write-Host "ERROR: $Message" -ForegroundColor Red
  exit 1
}

# A relative path with forward slashes only, no drive, no colon, no backslash, no empty, '.' or '..' segment.
function Test-SafeRelative([string]$Rel) {
  if ([string]::IsNullOrWhiteSpace($Rel)) { return $false }
  if ($Rel.Contains('\') -or $Rel.Contains(':') -or $Rel.StartsWith('/')) { return $false }
  foreach ($seg in $Rel.Split('/')) {
    if ($seg -eq '' -or $seg -eq '.' -or $seg -eq '..') { return $false }
  }
  return $true
}

function Join-Rel([string]$Root, [string]$Rel) {
  $p = $Root
  foreach ($seg in $Rel.Split('/')) { $p = [System.IO.Path]::Combine($p, $seg) }
  return $p
}

# Plain .NET rather than Get-FileHash: that one lives in a module that is not always loadable (mixed 5.1/7 module paths).
function Get-Sha256([string]$Path) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead($Path)
  try { $bytes = $sha.ComputeHash($stream) } finally { $stream.Dispose(); $sha.Dispose() }
  return ([System.BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
}

function Get-JavaProcesses {
  $filter = "Name = 'java.exe' OR Name = 'javaw.exe'"
  try { return @(Get-CimInstance -ClassName Win32_Process -Filter $filter -ErrorAction Stop) } catch { }
  return @(Get-WmiObject -Class Win32_Process -Filter $filter -ErrorAction Stop)
}

function New-Parent([string]$Path) {
  $parent = [System.IO.Path]::GetDirectoryName($Path)
  if (-not [System.IO.Directory]::Exists($parent)) { [void][System.IO.Directory]::CreateDirectory($parent) }
}

$pack = $PSScriptRoot
$changesPath = Join-Path $pack 'changes.json'
if (-not (Test-Path -LiteralPath $changesPath -PathType Leaf)) { Fail "changes.json not found next to this script ($pack)" }
$changes = Get-Content -LiteralPath $changesPath -Raw -Encoding UTF8 | ConvertFrom-Json

if (-not (Test-Path -LiteralPath $InstanceDir -PathType Container)) { Fail "instance folder not found: $InstanceDir" }
$inst = (Resolve-Path -LiteralPath $InstanceDir).ProviderPath.TrimEnd('\', '/')
$modsDir = Join-Path $inst 'mods'
if (-not (Test-Path -LiteralPath $modsDir -PathType Container)) { Fail "no mods folder in $inst : this does not look like a Minecraft instance, nothing was changed" }

Write-Host "Modpack Studio update pack $($changes.name)"
Write-Host "  reference: $($changes.base.label)"
Write-Host "  for:       $($changes.other.label)"
Write-Host "Instance: $inst"

# 1. Every file of the pack must match changes.json before anything is touched.
$jars = @($changes.jars | Where-Object { $null -ne $_ })
$files = @($changes.files | Where-Object { $null -ne $_ })
$problems = New-Object System.Collections.ArrayList
$listed = @{}
foreach ($j in $jars) {
  $name = [string]$j.file
  if (-not (Test-SafeRelative $name) -or $name.Contains('/')) { [void]$problems.Add("unsafe jar name in changes.json: $name"); continue }
  $listed['mods-add/' + $name] = $true
  $src = Join-Rel (Join-Path $pack 'mods-add') $name
  if (-not (Test-Path -LiteralPath $src -PathType Leaf)) { [void]$problems.Add("missing from the pack: mods-add/$name"); continue }
  if ((Get-Sha256 $src) -ne ([string]$j.sha256).ToLowerInvariant()) { [void]$problems.Add("sha256 mismatch: mods-add/$name") }
}
foreach ($f in $files) {
  $rel = [string]$f.path
  if (-not (Test-SafeRelative $rel)) { [void]$problems.Add("unsafe path in changes.json: $rel"); continue }
  $listed['files-add/' + $rel] = $true
  $src = Join-Rel (Join-Path $pack 'files-add') $rel
  if (-not (Test-Path -LiteralPath $src -PathType Leaf)) { [void]$problems.Add("missing from the pack: files-add/$rel"); continue }
  if ((Get-Sha256 $src) -ne ([string]$f.sha256).ToLowerInvariant()) { [void]$problems.Add("sha256 mismatch: files-add/$rel") }
}
foreach ($dir in @('mods-add', 'files-add')) {
  $root = Join-Path $pack $dir
  if (-not (Test-Path -LiteralPath $root -PathType Container)) { continue }
  foreach ($item in @(Get-ChildItem -LiteralPath $root -Recurse -File)) {
    $rel = $dir + '/' + $item.FullName.Substring($root.Length + 1).Replace('\', '/')
    if (-not $listed.ContainsKey($rel)) { [void]$problems.Add("file not listed in changes.json: $rel") }
  }
}
$removeNames = New-Object System.Collections.ArrayList
$removePath = Join-Path $pack 'remove.txt'
if (Test-Path -LiteralPath $removePath -PathType Leaf) {
  foreach ($line in @(Get-Content -LiteralPath $removePath -Encoding UTF8)) {
    $n = ([string]$line).Trim()
    if ($n -eq '') { continue }
    if (-not (Test-SafeRelative $n) -or $n.Contains('/')) { [void]$problems.Add("unsafe name in remove.txt: $n"); continue }
    [void]$removeNames.Add($n)
  }
}
if ($problems.Count -gt 0) {
  foreach ($p in $problems) { Write-Host "  $p" -ForegroundColor Red }
  Fail "the pack does not match changes.json (sha256 check or missing files): nothing was changed"
}
Write-Host "sha256 check: $($jars.Count) jar(s) and $($files.Count) file(s) match changes.json" -ForegroundColor Green

# 2. Best effort: refuse while Minecraft runs from this instance.
$running = New-Object System.Collections.ArrayList
try {
  foreach ($proc in (Get-JavaProcesses)) {
    $cmd = [string]$proc.CommandLine
    if ($cmd -and $cmd.ToLowerInvariant().Contains($inst.ToLowerInvariant())) { [void]$running.Add($proc.ProcessId) }
  }
} catch {
  Write-Host "Note: could not list Java processes, make sure the game is closed." -ForegroundColor Yellow
}
if ($running.Count -gt 0) {
  $msg = "Minecraft (java process $($running -join ', ')) is running from $inst"
  if ($Apply -and -not $Force) { Fail "$msg. Close the game first, or pass -Force. Nothing was changed." }
  Write-Host "WARNING: $msg" -ForegroundColor Yellow
}

# 3. What will move and what will be copied.
$moves = New-Object System.Collections.ArrayList
$seen = @{}
$absent = New-Object System.Collections.ArrayList
foreach ($n in $removeNames) {
  $rel = 'mods/' + $n
  if (Test-Path -LiteralPath (Join-Rel $inst $rel) -PathType Leaf) {
    if (-not $seen.ContainsKey($rel)) { $seen[$rel] = $true; [void]$moves.Add($rel) }
  } else { [void]$absent.Add($rel) }
}
$copies = New-Object System.Collections.ArrayList
$targets = @()
foreach ($j in $jars) { $targets += ,@((Join-Rel (Join-Path $pack 'mods-add') ([string]$j.file)), ('mods/' + [string]$j.file)) }
foreach ($f in $files) { $targets += ,@((Join-Rel (Join-Path $pack 'files-add') ([string]$f.path)), [string]$f.path) }
foreach ($t in $targets) {
  $rel = $t[1]
  $dest = Join-Rel $inst $rel
  if (Test-Path -LiteralPath $dest -PathType Container) { Fail "a folder is in the way of $rel, nothing was changed" }
  if ((Test-Path -LiteralPath $dest -PathType Leaf) -and -not $seen.ContainsKey($rel)) { $seen[$rel] = $true; [void]$moves.Add($rel) }
  [void]$copies.Add($t)
}

$backupName = '_studio-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
$backup = Join-Path $inst $backupName
if (-not $Apply) { Write-Host 'DRY RUN: nothing will be changed. Run again with -Apply to do it.' -ForegroundColor Yellow }
foreach ($m in $moves) { Write-Host "  move to backup  $m" }
foreach ($a in $absent) { Write-Host "  already absent  $a (nothing to move)" }
foreach ($c in $copies) { Write-Host "  copy            $($c[1])" }
if (-not $Apply) {
  Write-Host "Dry run done: $($moves.Count) file(s) would move to $backupName, $($copies.Count) file(s) would be copied."
  exit 0
}

# 4. Apply: move first (backup), then copy. Nothing is ever deleted.
if (Test-Path -LiteralPath $backup) { Fail "backup folder already exists: $backup, wait one second and run again" }
[void][System.IO.Directory]::CreateDirectory($backup)
$moved = 0
$copied = 0
try {
  foreach ($m in $moves) {
    $dst = Join-Rel $backup $m
    New-Parent $dst
    [System.IO.File]::Move((Join-Rel $inst $m), $dst)
    $moved++
  }
  foreach ($c in $copies) {
    $dst = Join-Rel $inst $c[1]
    New-Parent $dst
    [System.IO.File]::Copy($c[0], $dst, $false)
    $copied++
  }
} catch {
  Write-Host "ERROR: stopped after $moved move(s) and $copied copy(ies): $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "The files already moved are in $backup."
  exit 1
}
Write-Host "Done: $moved file(s) moved to $backup, $copied file(s) copied. Nothing was deleted." -ForegroundColor Green
Write-Host "To undo: move the files of $backupName back to their place."
exit 0
`;

/** The script with Windows line endings. */
export const APPLY_PS1 = SCRIPT.replace(/\r?\n/g, '\r\n');

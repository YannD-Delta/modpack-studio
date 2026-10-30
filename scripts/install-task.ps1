<#
Registers a Task Scheduler task that starts Modpack Studio at logon, under the CURRENT USER account
(not LocalSystem: reading the gaming PC over SMB needs the user's credentials).
The task runs <InstallDir>\start.cmd, which follows the 'current' pointer at run time: updating the app never
needs the task to be registered again. start.cmd and this script ship at the root of the package zip.
Dry-run by default: prints what it would register. Add -Apply to register it for real.
Usage: pwsh scripts/install-task.ps1 -InstallDir D:\ModpackStudio [-Apply]
#>
param(
    [Parameter(Mandatory = $true)][string]$InstallDir,
    [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$taskName = 'ModpackStudio'
$user = "$env:USERDOMAIN\$env:USERNAME"
$currentFile = Join-Path $InstallDir 'current'
$current = if (Test-Path $currentFile) { (Get-Content -Raw $currentFile).Trim() } else { '(missing)' }
$command = Join-Path $InstallDir 'start.cmd'

Write-Host "Task name : $taskName"
Write-Host "Trigger   : at logon of $user"
Write-Host "User      : $user (interactive, limited)"
Write-Host "Command   : $command (currently runs version $current)"
Write-Host "Data dir  : $(Join-Path $InstallDir 'data') (kept across updates)"

if (-not (Test-Path $command)) { throw "start.cmd not found: $command (it ships at the root of the package zip)" }

if (-not $Apply) {
    Write-Host 'Dry run: nothing registered. Re-run with -Apply to register the task.'
    return
}

$action = New-ScheduledTaskAction -Execute $command
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Write-Host "Registered $taskName."

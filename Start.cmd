@echo off
rem Double-click launcher: opens the Modpack Studio menu (pwsh if present, else Windows PowerShell).
where pwsh >nul 2>nul
if %errorlevel%==0 (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0studio.ps1" %*
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0studio.ps1" %*
)

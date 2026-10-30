import { execFileSync } from 'node:child_process';

/** The script is static: the location reaches PowerShell as data through this environment variable, never as source text. */
const SCRIPT =
  `$n = $env:STUDIO_NEEDLE; ` +
  `@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.ProcessId -ne ${process.pid} -and $_.ProcessId -ne $PID -and $_.CommandLine.IndexOf($n, [StringComparison]::OrdinalIgnoreCase) -ge 0 }).Count`;

/**
 * True when some other process was started from a path containing `dir` (case-insensitive),
 * for example java.exe launched from a server folder.
 * Throws if the process list cannot be read: the caller must not assume "not running".
 */
export function isProcessRunningFrom(dir: string): boolean {
  if (!dir.trim()) return false;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], {
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true,
    env: { ...process.env, STUDIO_NEEDLE: dir },
  });
  return Number.parseInt(out.trim(), 10) > 0;
}

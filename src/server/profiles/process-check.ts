import { execFileSync } from 'node:child_process';

/**
 * True when some other process was started from a path containing `dir` (case-insensitive),
 * for example java.exe launched from a server folder. Used to refuse capturing a `run` profile while it runs.
 * Throws if the process list cannot be read: the caller must not assume "not running".
 */
export function isProcessRunningFrom(dir: string): boolean {
  if (!dir.trim()) return false;
  const needle = dir.replace(/'/g, "''");
  const script =
    `$n = '${needle}'; ` +
    `@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.ProcessId -ne ${process.pid} -and $_.ProcessId -ne $PID -and $_.CommandLine.IndexOf($n, [StringComparison]::OrdinalIgnoreCase) -ge 0 }).Count`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  return Number.parseInt(out.trim(), 10) > 0;
}

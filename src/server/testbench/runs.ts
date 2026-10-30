import fs from 'node:fs';
import path from 'node:path';
import type { RunStatus, ServerTestResult } from './server-test.js';

export type RunMeta = { id: string; profileId: number; label: string; memoryMb: number; port: number; createdAt: string; jobId: string | null };
export type RunState = RunStatus | 'queued';
export type RunSummary = RunMeta & { status: RunState; message: string | null; bootSeconds: number | null; errorLines: number | null; warnLines: number | null; crashReports: number };
export type RunDetail = { meta: RunMeta; status: RunState; message: string | null; result: ServerTestResult | null };

const ID = /^[A-Za-z0-9._-]{1,120}$/;
export const validRunId = (id: string): boolean => ID.test(id) && id !== '.' && id !== '..';

export const testsDir = (dataDir: string) => path.join(dataDir, 'tests');
export const runDir = (dataDir: string, id: string) => path.join(testsDir(dataDir), id);

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function writeMeta(dataDir: string, meta: RunMeta): void {
  const dir = runDir(dataDir, meta.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
}

/** One run: its metadata, the live status written by the job, and the final result once finished. */
export function readRun(dataDir: string, id: string): RunDetail | null {
  if (!validRunId(id)) return null;
  const dir = runDir(dataDir, id);
  const meta = readJson<RunMeta>(path.join(dir, 'meta.json'));
  if (!meta) return null;
  const result = readJson<ServerTestResult>(path.join(dir, 'result.json'));
  const live = readJson<{ status: RunStatus; message: string | null }>(path.join(dir, 'status.json'));
  return { meta, status: result?.status ?? live?.status ?? 'queued', message: result?.message ?? live?.message ?? null, result };
}

const EMPTY_SUMMARY = { bootSeconds: null, errorLines: 0, warnLines: 0, firstErrors: [] };

/**
 * Gives a run whose job ended without a result a terminal `interrupted` result (cancelled while queued, Studio restarted, job crashed).
 * Returns false when the run already has a result or is unknown: a finished run is never rewritten.
 */
export function markRunInterrupted(dataDir: string, id: string, message: string): boolean {
  if (!validRunId(id)) return false;
  const dir = runDir(dataDir, id);
  const meta = readJson<RunMeta>(path.join(dir, 'meta.json'));
  if (!meta || fs.existsSync(path.join(dir, 'result.json'))) return false;
  const at = new Date().toISOString();
  const result: ServerTestResult = { status: 'interrupted', bootSeconds: null, exitCode: null, startedAt: meta.createdAt, endedAt: at, summary: EMPTY_SUMMARY, crashReports: [], modJars: 0, disabledMods: [], message };
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ status: 'interrupted', message, at }));
  return true;
}

/** At startup, once the previous process's jobs are marked interrupted: every run without a result is over. Returns how many were closed. */
export function markOrphanRuns(dataDir: string, message = 'Studio was restarted before this test finished'): number {
  const root = testsDir(dataDir);
  if (!fs.existsSync(root)) return 0;
  let n = 0;
  for (const name of fs.readdirSync(root)) {
    try {
      if (markRunInterrupted(dataDir, name, message)) n++;
    } catch {
      // a run folder that cannot be written (read-only, racing) is left as it is
    }
  }
  return n;
}

/** Newest first. */
export function listRuns(dataDir: string, limit = 50): RunSummary[] {
  const root = testsDir(dataDir);
  if (!fs.existsSync(root)) return [];
  const out: RunSummary[] = [];
  for (const name of fs.readdirSync(root)) {
    const d = readRun(dataDir, name);
    if (!d) continue;
    out.push({
      ...d.meta,
      status: d.status,
      message: d.message,
      bootSeconds: d.result?.bootSeconds ?? null,
      errorLines: d.result?.summary.errorLines ?? null,
      warnLines: d.result?.summary.warnLines ?? null,
      crashReports: d.result?.crashReports.length ?? 0,
    });
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, limit);
}

/** The last `tail` lines of the console log (bounded: the whole file may be large). */
export function readLogTail(dataDir: string, id: string, tail: number): { lines: string[]; total: number } | null {
  if (!validRunId(id)) return null;
  const file = path.join(runDir(dataDir, id), 'console.log');
  if (!fs.existsSync(file)) return { lines: [], total: 0 };
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  try {
    const want = Math.min(size, 2 * 1024 * 1024);
    const buf = Buffer.alloc(want);
    fs.readSync(fd, buf, 0, want, size - want);
    const all = buf.toString('utf8').split(/\r?\n/);
    if (size > want) all.shift(); // the first line is cut
    const lines = all.filter((l, i) => l !== '' || i < all.length - 1);
    return { lines: lines.slice(-tail), total: lines.length };
  } finally {
    fs.closeSync(fd);
  }
}

/** First lines of the newest crash report of a run, or null. */
export function readCrashHead(dataDir: string, id: string, maxLines = 120): string | null {
  if (!validRunId(id)) return null;
  // Reports are kept in the run folder; runs from before that (or with keepCopy) still have them in the server copy.
  const dir = [path.join(runDir(dataDir, id), 'crash-reports'), path.join(runDir(dataDir, id), 'server', 'crash-reports')].find((d) => fs.existsSync(d));
  if (!dir) return null;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.txt')).sort();
  const last = files.at(-1);
  if (!last) return null;
  return fs.readFileSync(path.join(dir, last), 'utf8').split(/\r?\n/).slice(0, maxLines).join('\n');
}

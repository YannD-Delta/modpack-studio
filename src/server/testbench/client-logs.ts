import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/open.js';
import type { Profile } from '../profiles/profile-service.js';
import { defineLimit, getListLimit, getNumberLimit } from '../settings/limits.js';
import { LogSummarizer } from './server-test.js';

defineLimit({ key: 'testbench.clientLogTailKb', kind: 'number', default: 2048, min: 16, max: 65536, unit: 'kilobytes', group: 'testbench', label: 'Client log: size read from the end of latest.log' });
defineLimit({ key: 'testbench.clientLogMaxCrashReports', kind: 'number', default: 3, min: 0, max: 20, unit: 'count', group: 'testbench', label: 'Client log: newest crash reports read' });
defineLimit({ key: 'testbench.clientLogMaxErrors', kind: 'number', default: 15, min: 1, max: 20, unit: 'count', group: 'testbench', label: 'Client log: distinct first errors listed' });
defineLimit({ key: 'testbench.clientLogCrashHeadLines', kind: 'number', default: 40, min: 0, max: 400, unit: 'lines', group: 'testbench', label: 'Client log: crash report lines kept for the assistant' });
/**
 * A client log has no server "Done (x s)!" line. These lines (regular expressions) are looked for instead, in loading order:
 * the user is set, the render backend starts, the resource managers reload, the block atlas is stitched. Which of them the
 * running client really prints depends on the Minecraft and loader versions: adjust the list in Settings.
 */
export const DEFAULT_CLIENT_MARKERS = ['Setting user:', 'Backend library:', 'Reloading ResourceManager:', 'Created: \\d+x\\d+x\\d+ minecraft:textures/atlas/blocks\\.png-atlas'];
defineLimit({ key: 'testbench.clientStartMarkers', kind: 'list', default: DEFAULT_CLIENT_MARKERS, maxItems: 20, group: 'testbench', label: 'Client log: lines showing the game finished loading (patterns)' });

export type ClientLogsErrorCode = 'not_a_client' | 'wrong_state' | 'not_a_folder' | 'folder_missing';
export class ClientLogsError extends Error {
  constructor(
    readonly code: ClientLogsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ClientLogsError';
  }
}

export type MarkerHit = { pattern: string; /** 1-based line number in the part of the log that was read, null when not found. */ line: number | null };
export type ClientLogSummary = { errorLines: number; warnLines: number; firstErrors: string[]; markers: MarkerHit[]; reachedAllMarkers: boolean };

/** Counts ERROR/FATAL and WARN lines, lists the first distinct errors and looks for the loading markers. Pure. */
export function summarizeClientLog(text: string, opts: { maxErrors?: number; markers?: readonly string[] } = {}): ClientLogSummary {
  const s = new LogSummarizer();
  s.push(text);
  const base = s.end();
  const regexes: { pattern: string; re: RegExp }[] = [];
  for (const pattern of opts.markers ?? DEFAULT_CLIENT_MARKERS) {
    try {
      regexes.push({ pattern, re: new RegExp(pattern) });
    } catch {
      // a damaged pattern is skipped
    }
  }
  const hits = new Map<string, number>();
  if (regexes.length) {
    text.split(/\r?\n/).forEach((line, i) => {
      for (const { pattern, re } of regexes) if (!hits.has(pattern) && re.test(line)) hits.set(pattern, i + 1);
    });
  }
  // The hit holds only the line number: the line itself can name the player.
  const markers = regexes.map(({ pattern }) => ({ pattern, line: hits.get(pattern) ?? null }));
  return {
    errorLines: base.errorLines,
    warnLines: base.warnLines,
    firstErrors: base.firstErrors.slice(0, opts.maxErrors ?? base.firstErrors.length),
    markers,
    reachedAllMarkers: markers.length > 0 && markers.every((m) => m.line !== null),
  };
}

/** "Description: exception line" of a crash report; null when the report has no Description line. */
export function crashHeadline(text: string): string | null {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => l.startsWith('Description:'));
  if (at < 0) return null;
  const description = lines[at]!.slice('Description:'.length).trim();
  const exception = lines.slice(at + 1).find((l) => l.trim() !== '' && !/^\s+at\s/.test(l) && !l.startsWith('\t'));
  return exception ? `${description}: ${exception.trim()}` : description;
}

/** Jar names on disk against jar names of the import, case-insensitive; both lists keep their own spelling. */
export function compareModFiles(onDisk: readonly string[], imported: readonly string[]): { onlyInInstance: string[]; onlyInImport: string[] } {
  const disk = new Set(onDisk.map((n) => n.toLowerCase()));
  const imp = new Set(imported.map((n) => n.toLowerCase()));
  return {
    onlyInInstance: onDisk.filter((n) => !imp.has(n.toLowerCase())).sort(),
    onlyInImport: imported.filter((n) => !disk.has(n.toLowerCase())).sort(),
  };
}

export type CrashReportInfo = { name: string; modified: string; headline: string | null; head: string };
export type ClientLogsResult = {
  profile: { id: number; label: string };
  log: { present: boolean; truncated: boolean; bytesRead: number; lines: number } & ClientLogSummary;
  crashReports: CrashReportInfo[];
  mods: { count: number; onlyInInstance: string[]; onlyInImport: string[]; imported: boolean };
  /** The loading markers that were looked for, so the report can say plainly what it relied on. */
  markersUsed: string[];
};

function readTail(file: string, maxBytes: number): { text: string; truncated: boolean } {
  const size = fs.statSync(file).size;
  const want = Math.min(size, maxBytes);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(want);
    fs.readSync(fd, buf, 0, want, size - want);
    let text = buf.toString('utf8');
    const truncated = size > want;
    if (truncated) text = text.slice(text.search(/\n/) + 1); // the first line is cut
    return { text, truncated };
  } finally {
    fs.closeSync(fd);
  }
}

function readHead(file: string, maxBytes: number): string {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    return buf.toString('utf8', 0, n);
  } finally {
    fs.closeSync(fd);
  }
}

export type ReadClientLogsOptions = { tailBytes?: number; maxCrashReports?: number; maxErrors?: number; crashHeadLines?: number; markers?: readonly string[] };

/** Reads (never writes) the logs and the mods folder of a client instance that was run by hand. */
export function readClientLogs(db: Db, profile: Profile, opts: ReadClientLogsOptions = {}): ClientLogsResult {
  if (profile.side !== 'client') throw new ClientLogsError('not_a_client', 'client logs are read from a client profile');
  if (profile.state !== 'candidate' && profile.state !== 'run') throw new ClientLogsError('wrong_state', 'pick a candidate or run profile: the logs of a clean or launched copy are not a test result');
  if (profile.locationKind !== 'folder' && profile.locationKind !== 'smb') throw new ClientLogsError('not_a_folder', 'the profile must point at an instance folder');
  const root = path.resolve(profile.location);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new ClientLogsError('folder_missing', 'the instance folder is not reachable');

  const tailBytes = opts.tailBytes ?? getNumberLimit('testbench.clientLogTailKb') * 1024;
  const markers = opts.markers ?? getListLimit('testbench.clientStartMarkers');
  const logFile = path.join(root, 'logs', 'latest.log');
  let log: ClientLogsResult['log'];
  if (fs.existsSync(logFile) && fs.statSync(logFile).isFile()) {
    const { text, truncated } = readTail(logFile, tailBytes);
    log = { present: true, truncated, bytesRead: Buffer.byteLength(text), lines: text === '' ? 0 : text.split(/\r?\n/).length, ...summarizeClientLog(text, { maxErrors: opts.maxErrors ?? getNumberLimit('testbench.clientLogMaxErrors'), markers }) };
  } else {
    log = { present: false, truncated: false, bytesRead: 0, lines: 0, ...summarizeClientLog('', { markers }) };
  }

  const crashDir = path.join(root, 'crash-reports');
  const crashReports: CrashReportInfo[] = [];
  const maxReports = opts.maxCrashReports ?? getNumberLimit('testbench.clientLogMaxCrashReports');
  const headLines = opts.crashHeadLines ?? getNumberLimit('testbench.clientLogCrashHeadLines');
  if (maxReports > 0 && fs.existsSync(crashDir)) {
    const files = fs
      .readdirSync(crashDir, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.txt$/i.test(e.name))
      .map((e) => ({ name: e.name, mtime: fs.statSync(path.join(crashDir, e.name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name))
      .slice(0, maxReports);
    for (const f of files) {
      const text = readHead(path.join(crashDir, f.name), 64 * 1024);
      crashReports.push({ name: f.name, modified: new Date(f.mtime).toISOString(), headline: crashHeadline(text), head: text.split(/\r?\n/).slice(0, headLines).join('\n') });
    }
  }

  const modsDir = path.join(root, 'mods');
  const onDisk = fs.existsSync(modsDir) ? fs.readdirSync(modsDir, { withFileTypes: true }).filter((e) => e.isFile() && /\.jar$/i.test(e.name)).map((e) => e.name) : [];
  const imported = (
    db.sqlite
      .prepare(
        `SELECT DISTINCT COALESCE(m.file_name, j.filename) AS filename
         FROM jar_mod m JOIN jar j ON j.sha256 = m.jar_sha256
         WHERE m.profile_id = ? AND m.is_jij = 0 AND m.library_key IS NULL`,
      )
      .all(profile.id) as { filename: string }[]
  ).map((r) => r.filename);
  const cmp = imported.length ? compareModFiles(onDisk, imported) : { onlyInInstance: [], onlyInImport: [] };

  return {
    profile: { id: profile.id, label: `${profile.pack} ${profile.version} (${profile.side}, ${profile.state})` },
    log,
    crashReports,
    mods: { count: onDisk.length, ...cmp, imported: imported.length > 0 },
    markersUsed: [...markers],
  };
}

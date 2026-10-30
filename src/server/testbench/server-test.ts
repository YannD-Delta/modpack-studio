import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { defineLimit, getLimit, getNumberLimit } from '../settings/limits.js';

export type StartCommand = { command: string; args: string[] };
/** `interrupted`: the run's job ended without writing a result (cancelled while queued, Studio restarted, unexpected crash of the job). */
export type RunStatus = 'copying' | 'starting' | 'ready' | 'stopping' | 'done' | 'failed' | 'timeout' | 'crashed' | 'interrupted';
/** How the server process ended: stopped by itself after `stop`, killed after the grace period, or gone before `stop` was sent. */
export type StopOutcome = 'clean' | 'forced' | 'exited-early';
export type LogSummary = { bootSeconds: number | null; errorLines: number; warnLines: number; firstErrors: string[] };
export type ServerTestResult = {
  status: RunStatus;
  bootSeconds: number | null;
  exitCode: number | null;
  startedAt: string;
  endedAt: string;
  summary: LogSummary;
  crashReports: string[];
  modJars: number;
  /** Mods switched off in the copy because they talk to the outside world or fight the real server for a port. */
  disabledMods: string[];
  /** Present when a server process was started. The UI warns on `forced` and `exited-early`, the status stays `done` for a normal Done. */
  stopOutcome?: StopOutcome;
  /** Links (symlinks, junctions) of the source folder that were not recreated in the copy, relative paths. */
  skippedLinks?: string[];
  /** Machine-readable reason of a failure, for example `not-enough-space`. */
  code?: string;
  message?: string;
};

export class EulaNotAcceptedError extends Error {
  constructor() {
    super('the Minecraft EULA is not accepted in the server folder: accept it for this test or accept it on the server first');
    this.name = 'EulaNotAcceptedError';
  }
}
export class NoStartScriptError extends Error {
  constructor() {
    super('no start script (run.bat, startserver.bat or start.bat) in the server folder');
    this.name = 'NoStartScriptError';
  }
}
export class NotEnoughSpaceError extends Error {
  readonly code = 'not-enough-space';
  constructor(neededBytes: number, freeBytes: number) {
    super(`not enough free disk space for the test copy: about ${Math.ceil(neededBytes / 1048576)} MB needed, ${Math.floor(freeBytes / 1048576)} MB free`);
    this.name = 'NotEnoughSpaceError';
  }
}
export class RunCancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'RunCancelledError';
  }
}

const START_SCRIPTS = ['run.bat', 'startserver.bat', 'start.bat'];
/** Never copied: they are the previous runs' output, not the server's content. */
const SKIP_TOP_LEVEL = new Set(['logs', 'crash-reports', 'backups', 'cache', '.git', 'dynmap', 'sdlinkstorage']);
/**
 * Jars renamed to `.jar.disabled` in the copy only. A test server must not post to the real Discord channel with the real bot,
 * and the map mods open a web port the real server already uses.
 */
defineLimit({ key: 'testbench.disabledJarPattern', kind: 'pattern', default: 'discord|dcintegration|dynmap|bluemap', group: 'testbench', label: 'Jars switched off in the test copy (pattern)' });
const disabledJarRe = (): RegExp => new RegExp(getLimit('testbench.disabledJarPattern') as string, 'i');
const MAX_FIRST_ERRORS = 20;
const DONE = /Done \((\d+(?:[.,]\d+)?)s\)!/;

/** Largest console.log kept per run (head of the output, then a truncation marker). The summary still counts every line. */
export const MAX_CONSOLE_LOG_BYTES = 64 * 1024 * 1024;
defineLimit({ key: 'testbench.maxConsoleLogMb', kind: 'number', default: MAX_CONSOLE_LOG_BYTES / (1024 * 1024), min: 1, max: 1024, unit: 'megabytes', group: 'testbench', label: 'Largest console log kept per test' });
/** Free space that must remain on the data disk after the copy, for the world the test server generates and its logs. */
export const FREE_SPACE_MARGIN_BYTES = 512 * 1024 * 1024;
/** Crash reports kept per run in `<run>/crash-reports` (the newest ones) and the size kept of each one. */
export const MAX_KEPT_CRASH_REPORTS = 20;
defineLimit({ key: 'testbench.maxKeptCrashReports', kind: 'number', default: MAX_KEPT_CRASH_REPORTS, min: 0, max: 200, unit: 'count', group: 'testbench', label: 'Crash reports kept per test' });
defineLimit({ key: 'testbench.freeSpaceMarginMb', kind: 'number', default: FREE_SPACE_MARGIN_BYTES / (1024 * 1024), min: 0, max: 102400, unit: 'megabytes', group: 'testbench', label: 'Free space to keep after the copy' });
const freeSpaceMargin = (): number => getNumberLimit('testbench.freeSpaceMarginMb') * 1024 * 1024;
export const MAX_KEPT_CRASH_REPORT_BYTES = 512 * 1024;
/** How long to wait for the process to be gone after the tree kill, before giving up on it. */
const KILL_WAIT_MS = 10_000;

export function detectStartScript(dir: string): string | null {
  return START_SCRIPTS.find((s) => fs.existsSync(path.join(dir, s))) ?? null;
}

/**
 * Blanks the standalone `pause` lines of a batch file (in the copy). A wrapper script ending in `pause` keeps cmd.exe alive after
 * Java is gone, which would make a clean stop wait for the whole grace period and a crash look like a timeout.
 * The line is blanked rather than turned into `rem`: `rem` resets ERRORLEVEL, so a crash would report exit code 0.
 */
export function blankPauseLines(file: string): void {
  fs.writeFileSync(file, fs.readFileSync(file, 'latin1').replace(/^[ \t]*@?pause\b[^\r\n]*/gim, ''), 'latin1');
}

/** Sets `key=value` in a properties text, replacing an existing line or appending one. */
function setProperty(text: string, key: string, value: string): string {
  const re = new RegExp(`^${key.replace(/\./g, '\\.')}=.*$`, 'm');
  return re.test(text) ? text.replace(re, `${key}=${value}`) : `${text}${text && !text.endsWith('\n') ? '\n' : ''}${key}=${value}\n`;
}

function readLevelName(sourceDir: string): string {
  try {
    return /^level-name=(.+)$/m.exec(fs.readFileSync(path.join(sourceDir, 'server.properties'), 'utf8'))?.[1]?.trim() || 'world';
  } catch {
    return 'world';
  }
}

/** The level-name as a lowercase relative posix path inside the server folder, or null when it points outside (absolute, drive letter, `..`). */
function levelPathInside(level: string): string | null {
  const p = level.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!p || p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) return null;
  return p.toLowerCase();
}

const eulaAccepted = (dir: string) => {
  try {
    return /^\s*eula\s*=\s*true\s*$/im.test(fs.readFileSync(path.join(dir, 'eula.txt'), 'utf8'));
  } catch {
    return false;
  }
};

/** What the copy leaves behind: previous output, the worlds (by prefix, so `worlds/survival` leaves only that world) and the session lock. */
function makeCopyRule(level: string): (relPosix: string) => boolean {
  const inside = levelPathInside(level);
  const worldPaths = new Set<string>();
  for (const base of ['world', ...(inside ? [inside] : [])]) for (const w of [base, `${base}_nether`, `${base}_the_end`]) worldPaths.add(w);
  return (relPosix) => {
    const top = relPosix.split('/')[0]!;
    if (SKIP_TOP_LEVEL.has(top) || top === 'session.lock' || (relPosix === top && top.endsWith('.log'))) return false;
    const low = relPosix.toLowerCase();
    for (const w of worldPaths) if (low === w || low.startsWith(`${w}/`)) return false;
    return true;
  };
}

/** Total size of what the copy will write (links are not followed). */
async function measureCopy(root: string, include: (relPosix: string) => boolean, signal?: AbortSignal): Promise<number> {
  let total = 0;
  const walk = async (dir: string, relPrefix: string): Promise<void> => {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      if (signal?.aborted) throw new RunCancelledError();
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (!include(rel) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
      else if (entry.isFile()) total += (await fsp.lstat(path.join(dir, entry.name))).size;
    }
  };
  await walk(root, '');
  return total;
}

async function freeBytesOf(dir: string): Promise<number> {
  const s = await fsp.statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
}

export type PrepareOptions = {
  sourceDir: string;
  destDir: string;
  port: number;
  memoryMb: number;
  acceptEula: boolean;
  signal?: AbortSignal;
  /** Test seam: free bytes on the disk that receives the copy. */
  getFreeBytes?: (dir: string) => Promise<number>;
};

/**
 * Copies a server folder into a throwaway one and makes it safe to start next to the real server:
 * another port, offline mode, no RCON, bounded memory, no world, no old logs. The source is only read:
 * links (symlinks, junctions) are never recreated in the copy, and `level-name` is forced to a world inside the copy.
 */
export async function prepareServerDir(opts: PrepareOptions): Promise<{ disabledMods: string[]; skippedLinks: string[] }> {
  const { destDir } = opts;
  if (!eulaAccepted(opts.sourceDir) && !opts.acceptEula) throw new EulaNotAcceptedError();
  // A source folder that is itself a link: copy what it points to, into a real folder (cp would recreate the link).
  const sourceDir = fs.realpathSync(opts.sourceDir);

  const include = makeCopyRule(readLevelName(sourceDir));
  const needed = await measureCopy(sourceDir, include, opts.signal);
  fs.mkdirSync(path.dirname(destDir), { recursive: true });
  const free = await (opts.getFreeBytes ?? freeBytesOf)(path.dirname(destDir));
  if (free < needed + freeSpaceMargin()) throw new NotEnoughSpaceError(needed + freeSpaceMargin(), free);

  const skippedLinks: string[] = [];
  await fsp.cp(sourceDir, destDir, {
    recursive: true,
    filter: async (src) => {
      if (opts.signal?.aborted) throw new RunCancelledError();
      const rel = path.relative(sourceDir, src).split(path.sep).join('/');
      if (!rel) return true;
      if (!include(rel)) return false;
      if ((await fsp.lstat(src)).isSymbolicLink()) {
        skippedLinks.push(rel); // junctions report true on Windows
        return false;
      }
      return true;
    },
  });
  if (opts.signal?.aborted) throw new RunCancelledError();

  const propsFile = path.join(destDir, 'server.properties');
  let props = fs.existsSync(propsFile) ? fs.readFileSync(propsFile, 'utf8') : '';
  props = setProperty(props, 'server-port', String(opts.port));
  if (/^query\.port=/m.test(props)) props = setProperty(props, 'query.port', String(opts.port));
  props = setProperty(props, 'online-mode', 'false');
  props = setProperty(props, 'enable-rcon', 'false');
  props = setProperty(props, 'level-name', 'world'); // never a path that leaves the copy: the throwaway server must not open the real world
  fs.writeFileSync(propsFile, props);

  const jvmFile = path.join(destDir, 'user_jvm_args.txt');
  const kept = (fs.existsSync(jvmFile) ? fs.readFileSync(jvmFile, 'utf8').split(/\r?\n/) : []).filter((l) => l.trim() && !/^-Xm[sx]/.test(l) && !l.includes('AlwaysPreTouch'));
  fs.writeFileSync(jvmFile, [`-Xms${opts.memoryMb}M`, `-Xmx${opts.memoryMb}M`, ...kept].join('\n') + '\n');

  if (!eulaAccepted(destDir)) fs.writeFileSync(path.join(destDir, 'eula.txt'), 'eula=true\n');

  const disabledMods: string[] = [];
  const modsDir = path.join(destDir, 'mods');
  if (fs.existsSync(modsDir)) {
    for (const f of fs.readdirSync(modsDir)) {
      if (f.toLowerCase().endsWith('.jar') && disabledJarRe().test(f)) {
        fs.renameSync(path.join(modsDir, f), path.join(modsDir, `${f}.disabled`));
        disabledMods.push(f);
      }
    }
  }
  return { disabledMods, skippedLinks };
}

/** Incremental version of {@link summarizeLog}: feed it chunks as they arrive, no need to keep the whole log in memory. */
export class LogSummarizer {
  private carry = '';
  private readonly errors: string[] = [];
  private errorLines = 0;
  private warnLines = 0;
  private bootSeconds: number | null = null;
  private readonly decoder = new StringDecoder('utf8');

  push(chunk: string | Buffer): void {
    const parts = (this.carry + (typeof chunk === 'string' ? chunk : this.decoder.write(chunk))).split(/\r?\n/);
    this.carry = parts.pop() ?? '';
    for (const line of parts) this.line(line);
  }

  end(): LogSummary {
    this.push(this.decoder.end());
    if (this.carry) this.line(this.carry);
    this.carry = '';
    return { bootSeconds: this.bootSeconds, errorLines: this.errorLines, warnLines: this.warnLines, firstErrors: [...this.errors] };
  }

  private line(line: string): void {
    if (/\/WARN\]/.test(line)) this.warnLines++;
    else if (/\/(ERROR|FATAL)\]/.test(line)) {
      this.errorLines++;
      const clean = line.replace(/^\[\d{1,2}:\d{2}:\d{2}\]\s*/, '').trim();
      if (this.errors.length < MAX_FIRST_ERRORS && !this.errors.includes(clean)) this.errors.push(clean);
    }
    const m = DONE.exec(line);
    if (m && this.bootSeconds === null) this.bootSeconds = Number.parseFloat(m[1]!.replace(',', '.'));
  }
}

/** Counts, boot time and the first distinct errors of a server console log. */
export function summarizeLog(text: string): LogSummary {
  const s = new LogSummarizer();
  s.push(text);
  return s.end();
}

export type ServerTestOptions = {
  sourceDir: string;
  runDir: string;
  port: number;
  memoryMb: number;
  acceptEula: boolean;
  /** How long to wait for "Done" before giving up. */
  readyTimeoutMs: number;
  /** Pause between "Done" and the stop command, so late startup errors are logged. */
  settleMs?: number;
  /** How long a stop command may take before the process tree is killed. */
  stopGraceMs?: number;
  /** Keep the full server copy after the run (default false: only the result, the console log, the status and the crash reports stay). */
  keepCopy?: boolean;
  /** Console log size cap in bytes; defaults to {@link MAX_CONSOLE_LOG_BYTES}. */
  maxLogBytes?: number;
  /** Test seam: replaces the start script. */
  startCommand?: StartCommand;
  /** Test seam: free bytes on the disk that receives the copy. */
  getFreeBytes?: (dir: string) => Promise<number>;
  onStatus?: (status: RunStatus, message?: string) => void;
  signal?: AbortSignal;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function killTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).on('close', () => resolve()).on('error', () => resolve()));
  } else {
    child.kill('SIGKILL');
  }
}

/** Keeps the newest crash reports of the copy (size-capped) in the run folder, so the copy itself can be removed. */
function keepCrashReports(serverDir: string, runDir: string): string[] {
  const src = path.join(serverDir, 'crash-reports');
  if (!fs.existsSync(src)) return [];
  const names = fs.readdirSync(src).filter((f) => f.endsWith('.txt')).sort();
  const dest = path.join(runDir, 'crash-reports');
  for (const name of names.slice(-getNumberLimit('testbench.maxKeptCrashReports'))) {
    try {
      fs.mkdirSync(dest, { recursive: true });
      const fd = fs.openSync(path.join(src, name), 'r');
      try {
        const buf = Buffer.alloc(MAX_KEPT_CRASH_REPORT_BYTES);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        fs.writeFileSync(path.join(dest, name), buf.subarray(0, n));
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // a report that cannot be copied is not worth failing the run
    }
  }
  return names;
}

/**
 * Starts a throwaway copy of a server, waits for "Done", stops it cleanly and keeps the console log and a result.
 * Never throws for a server problem: the outcome is the `status` (done, crashed, timeout, failed).
 * The copy is removed at the end (also when the run fails) unless `keepCopy` is set.
 */
export async function runServerTest(opts: ServerTestOptions): Promise<ServerTestResult> {
  const startedAt = new Date();
  const serverDir = path.join(opts.runDir, 'server');
  const consoleFile = path.join(opts.runDir, 'console.log');
  fs.mkdirSync(opts.runDir, { recursive: true });

  const summarizer = new LogSummarizer();
  let disabledMods: string[] = [];
  let skippedLinks: string[] = [];

  const emit = (status: RunStatus, message?: string) => {
    opts.onStatus?.(status, message);
    fs.writeFileSync(path.join(opts.runDir, 'status.json'), JSON.stringify({ status, message: message ?? null, at: new Date().toISOString() }));
  };
  const finish = async (status: RunStatus, exitCode: number | null, extra: { message?: string; code?: string; stopOutcome?: StopOutcome } = {}): Promise<ServerTestResult> => {
    const modsDir = path.join(serverDir, 'mods');
    const summary = summarizer.end();
    const result: ServerTestResult = {
      status,
      bootSeconds: summary.bootSeconds,
      exitCode,
      startedAt: startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      summary,
      crashReports: keepCrashReports(serverDir, opts.runDir),
      modJars: fs.existsSync(modsDir) ? fs.readdirSync(modsDir).filter((f) => f.toLowerCase().endsWith('.jar')).length : 0,
      disabledMods,
      ...(extra.stopOutcome ? { stopOutcome: extra.stopOutcome } : {}),
      ...(skippedLinks.length ? { skippedLinks } : {}),
      ...(extra.code ? { code: extra.code } : {}),
      ...(extra.message ? { message: extra.message } : {}),
    };
    if (!opts.keepCopy) {
      try {
        await fsp.rm(serverDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
      } catch (err) {
        console.error(`test copy not removed: ${err instanceof Error ? err.message : String(err)}`); // Windows may hold a jar for a moment; never changes the run status
      }
    }
    fs.writeFileSync(path.join(opts.runDir, 'result.json'), JSON.stringify(result, null, 2));
    emit(status, extra.message);
    return result;
  };

  emit('copying');
  let command: StartCommand;
  try {
    if (opts.signal?.aborted) throw new RunCancelledError();
    let script: string | null = null;
    if (!opts.startCommand) {
      script = detectStartScript(opts.sourceDir);
      if (!script) throw new NoStartScriptError();
      // `.\` because cmd.exe does not look in the current folder when NoDefaultCurrentDirectoryInExePath is set
      command = { command: process.env.ComSpec ?? 'cmd.exe', args: ['/c', `.\\${script}`] };
    } else {
      command = opts.startCommand;
    }
    ({ disabledMods, skippedLinks } = await prepareServerDir({ sourceDir: opts.sourceDir, destDir: serverDir, port: opts.port, memoryMb: opts.memoryMb, acceptEula: opts.acceptEula, signal: opts.signal, getFreeBytes: opts.getFreeBytes }));
    if (script) blankPauseLines(path.join(serverDir, script));
    if (opts.signal?.aborted) throw new RunCancelledError();
  } catch (err) {
    return finish('failed', null, { message: err instanceof Error ? err.message : String(err), ...(err instanceof NotEnoughSpaceError ? { code: err.code } : {}) });
  }

  let child: ChildProcess | undefined;
  let logStream: fs.WriteStream | undefined;
  try {
    emit('starting');
    const maxLogBytes = opts.maxLogBytes ?? getNumberLimit('testbench.maxConsoleLogMb') * 1024 * 1024;
    const log = fs.createWriteStream(consoleFile);
    logStream = log;
    let logOk = true;
    let logBytes = 0;
    log.on('error', (err) => {
      logOk = false; // keep draining the server output: the summary does not depend on the file
      console.error(`console log not written: ${err.message}`);
    });
    const writeLog = (data: Buffer | string) => {
      if (!logOk) return;
      const buf = typeof data === 'string' ? Buffer.from(data) : data;
      if (logBytes + buf.length <= maxLogBytes) {
        logBytes += buf.length;
        log.write(buf);
        return;
      }
      logOk = false;
      log.write(Buffer.concat([buf.subarray(0, Math.max(0, maxLogBytes - logBytes)), Buffer.from(`\n[studio] console log truncated after ${maxLogBytes} bytes\n`)]));
    };
    for (const rel of skippedLinks) writeLog(`[studio] link not copied: ${rel}\n`);

    const proc = spawn(command.command, command.args, { cwd: serverDir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child = proc;
    const state = { exited: false, code: null as number | null };
    const exited = new Promise<void>((resolve) => {
      proc.on('exit', (code) => {
        state.exited = true;
        state.code = code;
        resolve();
      });
      proc.on('error', () => {
        state.exited = true;
        resolve();
      });
    });
    let seen = '';
    const decoder = new StringDecoder('utf8');
    const ready = new Promise<void>((resolve) => {
      const onData = (chunk: Buffer) => {
        writeLog(chunk);
        summarizer.push(chunk);
        seen = (seen + decoder.write(chunk)).slice(-4096);
        if (DONE.test(seen)) resolve();
      };
      proc.stdout!.on('data', onData);
      proc.stderr!.on('data', onData);
    });
    proc.stdin!.on('error', () => undefined); // the server may already be gone when "stop" is written

    const aborted = new Promise<'abort'>((resolve) => {
      if (opts.signal?.aborted) resolve('abort');
      opts.signal?.addEventListener('abort', () => resolve('abort'), { once: true });
    });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), opts.readyTimeoutMs);
    });

    /** Sends `stop`, closes stdin (so a `pause` left in a wrapper cannot wait for a key) and kills the whole tree after the grace period. */
    const stop = async (): Promise<StopOutcome> => {
      if (state.exited) return 'exited-early';
      emit('stopping');
      proc.stdin!.end('stop\n');
      let graceTimer: NodeJS.Timeout | undefined;
      const late = new Promise<'late'>((resolve) => {
        graceTimer = setTimeout(() => resolve('late'), opts.stopGraceMs ?? 60_000);
      });
      const which = await Promise.race([exited.then(() => 'exited' as const), late]);
      clearTimeout(graceTimer);
      if (which === 'exited') return 'clean';
      await killTree(proc);
      if (!state.exited) proc.kill('SIGKILL');
      await Promise.race([exited, sleep(KILL_WAIT_MS)]);
      return 'forced';
    };

    const first = await Promise.race([ready.then(() => 'ready' as const), exited.then(() => 'exit' as const), timeout, aborted]);
    clearTimeout(timer);

    let status: RunStatus;
    let message: string | undefined;
    let stopOutcome: StopOutcome;
    if (first === 'ready') {
      emit('ready');
      let settleTimer: NodeJS.Timeout | undefined;
      const settled = new Promise<'settled'>((resolve) => {
        settleTimer = setTimeout(() => resolve('settled'), opts.settleMs ?? 5000);
      });
      const during = await Promise.race([settled, exited.then(() => 'exit' as const), aborted]);
      clearTimeout(settleTimer);
      if (during === 'abort') {
        stopOutcome = await stop();
        status = 'failed';
        message = 'cancelled';
      } else if (during === 'exit') {
        stopOutcome = 'exited-early';
        status = 'done';
        message = `the server exited by itself after "Done" (exit code ${state.code ?? 'none'})`;
      } else {
        stopOutcome = await stop();
        status = 'done';
      }
    } else if (first === 'exit') {
      status = 'crashed';
      stopOutcome = 'exited-early';
    } else {
      stopOutcome = await stop();
      status = first === 'timeout' ? 'timeout' : 'failed';
      message = first === 'timeout' ? `no "Done" after ${Math.round(opts.readyTimeoutMs / 1000)} s` : 'cancelled';
    }
    await new Promise<void>((resolve) => {
      if (log.destroyed) resolve();
      else {
        log.once('close', () => resolve());
        log.end();
      }
    });
    return await finish(status, state.code, { message, stopOutcome });
  } catch (err) {
    return finish('failed', null, { message: err instanceof Error ? err.message : String(err) });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) await killTree(child);
    logStream?.destroy();
  }
}

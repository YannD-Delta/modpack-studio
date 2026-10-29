import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export type StartCommand = { command: string; args: string[] };
export type RunStatus = 'copying' | 'starting' | 'ready' | 'stopping' | 'done' | 'failed' | 'timeout' | 'crashed';
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

const START_SCRIPTS = ['run.bat', 'startserver.bat', 'start.bat'];
/** Never copied: they are the previous runs' output, not the server's content. */
const SKIP_TOP_LEVEL = new Set(['logs', 'crash-reports', 'backups', 'cache', '.git', 'dynmap', 'sdlinkstorage']);
/**
 * Jars renamed to `.jar.disabled` in the copy only. A test server must not post to the real Discord channel with the real bot,
 * and the map mods open a web port the real server already uses.
 */
const DISABLE_IN_TEST = /discord|dcintegration|dynmap|bluemap/i;
const MAX_FIRST_ERRORS = 20;
const DONE = /Done \((\d+(?:[.,]\d+)?)s\)!/;

export function detectStartScript(dir: string): string | null {
  return START_SCRIPTS.find((s) => fs.existsSync(path.join(dir, s))) ?? null;
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

const eulaAccepted = (dir: string) => {
  try {
    return /^\s*eula\s*=\s*true\s*$/im.test(fs.readFileSync(path.join(dir, 'eula.txt'), 'utf8'));
  } catch {
    return false;
  }
};

/**
 * Copies a server folder into a throwaway one and makes it safe to start next to the real server:
 * another port, offline mode, no RCON, bounded memory, no world, no old logs. The source is only read.
 */
export async function prepareServerDir(opts: { sourceDir: string; destDir: string; port: number; memoryMb: number; acceptEula: boolean }): Promise<{ disabledMods: string[] }> {
  const { sourceDir, destDir } = opts;
  if (!eulaAccepted(sourceDir) && !opts.acceptEula) throw new EulaNotAcceptedError();

  const level = readLevelName(sourceDir);
  const worlds = new Set([level, `${level}_nether`, `${level}_the_end`, 'world', 'world_nether', 'world_the_end']);
  await fsp.cp(sourceDir, destDir, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(sourceDir, src);
      if (!rel) return true;
      const top = rel.split(path.sep)[0]!;
      return !SKIP_TOP_LEVEL.has(top) && !worlds.has(top) && top !== 'session.lock' && !(rel === top && top.endsWith('.log'));
    },
  });

  const propsFile = path.join(destDir, 'server.properties');
  let props = fs.existsSync(propsFile) ? fs.readFileSync(propsFile, 'utf8') : '';
  props = setProperty(props, 'server-port', String(opts.port));
  if (/^query\.port=/m.test(props)) props = setProperty(props, 'query.port', String(opts.port));
  props = setProperty(props, 'online-mode', 'false');
  props = setProperty(props, 'enable-rcon', 'false');
  fs.writeFileSync(propsFile, props);

  const jvmFile = path.join(destDir, 'user_jvm_args.txt');
  const kept = (fs.existsSync(jvmFile) ? fs.readFileSync(jvmFile, 'utf8').split(/\r?\n/) : []).filter((l) => l.trim() && !/^-Xm[sx]/.test(l) && !l.includes('AlwaysPreTouch'));
  fs.writeFileSync(jvmFile, [`-Xms${opts.memoryMb}M`, `-Xmx${opts.memoryMb}M`, ...kept].join('\n') + '\n');

  if (!eulaAccepted(destDir)) fs.writeFileSync(path.join(destDir, 'eula.txt'), 'eula=true\n');

  const disabledMods: string[] = [];
  const modsDir = path.join(destDir, 'mods');
  if (fs.existsSync(modsDir)) {
    for (const f of fs.readdirSync(modsDir)) {
      if (f.toLowerCase().endsWith('.jar') && DISABLE_IN_TEST.test(f)) {
        fs.renameSync(path.join(modsDir, f), path.join(modsDir, `${f}.disabled`));
        disabledMods.push(f);
      }
    }
  }
  return { disabledMods };
}

/** Counts, boot time and the first distinct errors of a server console log. */
export function summarizeLog(text: string): LogSummary {
  const errors: string[] = [];
  let errorLines = 0;
  let warnLines = 0;
  let bootSeconds: number | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (/\/WARN\]/.test(line)) warnLines++;
    else if (/\/(ERROR|FATAL)\]/.test(line)) {
      errorLines++;
      const clean = line.replace(/^\[\d{1,2}:\d{2}:\d{2}\]\s*/, '').trim();
      if (errors.length < MAX_FIRST_ERRORS && !errors.includes(clean)) errors.push(clean);
    }
    const m = DONE.exec(line);
    if (m && bootSeconds === null) bootSeconds = Number.parseFloat(m[1]!.replace(',', '.'));
  }
  return { bootSeconds, errorLines, warnLines, firstErrors: errors };
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
  /** Test seam: replaces the start script. */
  startCommand?: StartCommand;
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

/**
 * Starts a throwaway copy of a server, waits for "Done", stops it cleanly and keeps the console log and a result.
 * Never throws for a server problem: the outcome is the `status` (done, crashed, timeout, failed).
 */
export async function runServerTest(opts: ServerTestOptions): Promise<ServerTestResult> {
  const startedAt = new Date();
  const serverDir = path.join(opts.runDir, 'server');
  const consoleFile = path.join(opts.runDir, 'console.log');
  fs.mkdirSync(opts.runDir, { recursive: true });

  const emit = (status: RunStatus, message?: string) => {
    opts.onStatus?.(status, message);
    fs.writeFileSync(path.join(opts.runDir, 'status.json'), JSON.stringify({ status, message: message ?? null, at: new Date().toISOString() }));
  };
  const finish = (status: RunStatus, exitCode: number | null, message?: string): ServerTestResult => {
    const text = fs.existsSync(consoleFile) ? fs.readFileSync(consoleFile, 'utf8') : '';
    const crashDir = path.join(serverDir, 'crash-reports');
    const modsDir = path.join(serverDir, 'mods');
    const result: ServerTestResult = {
      status,
      bootSeconds: summarizeLog(text).bootSeconds,
      exitCode,
      startedAt: startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      summary: summarizeLog(text),
      crashReports: fs.existsSync(crashDir) ? fs.readdirSync(crashDir).filter((f) => f.endsWith('.txt')).sort() : [],
      modJars: fs.existsSync(modsDir) ? fs.readdirSync(modsDir).filter((f) => f.toLowerCase().endsWith('.jar')).length : 0,
      disabledMods,
      ...(message ? { message } : {}),
    };
    fs.writeFileSync(path.join(opts.runDir, 'result.json'), JSON.stringify(result, null, 2));
    emit(status, message);
    return result;
  };

  emit('copying');
  let command: StartCommand;
  let disabledMods: string[] = [];
  try {
    if (!opts.startCommand) {
      const script = detectStartScript(opts.sourceDir);
      if (!script) throw new NoStartScriptError();
      command = { command: process.env.ComSpec ?? 'cmd.exe', args: ['/c', script] };
    } else {
      command = opts.startCommand;
    }
    ({ disabledMods } = await prepareServerDir({ sourceDir: opts.sourceDir, destDir: serverDir, port: opts.port, memoryMb: opts.memoryMb, acceptEula: opts.acceptEula }));
  } catch (err) {
    return finish('failed', null, err instanceof Error ? err.message : String(err));
  }

  emit('starting');
  const log = fs.createWriteStream(consoleFile);
  const child = spawn(command.command, command.args, { cwd: serverDir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const exited = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => resolve(code));
    child.on('error', () => resolve(null));
  });
  let seen = '';
  const ready = new Promise<void>((resolve) => {
    const onData = (chunk: Buffer) => {
      log.write(chunk);
      seen = (seen + chunk.toString('utf8')).slice(-4096);
      if (DONE.test(seen)) resolve();
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
  });
  child.stdin!.on('error', () => undefined); // the server may already be gone when "stop" is written

  const aborted = new Promise<'abort'>((resolve) => {
    if (opts.signal?.aborted) resolve('abort');
    opts.signal?.addEventListener('abort', () => resolve('abort'), { once: true });
  });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), opts.readyTimeoutMs);
  });

  const stop = async (): Promise<number | null> => {
    emit('stopping');
    child.stdin!.write('stop\n');
    const code = await Promise.race([exited, sleep(opts.stopGraceMs ?? 60_000).then(() => 'late' as const)]);
    if (code === 'late') {
      await killTree(child);
      return exited;
    }
    return code;
  };

  const first = await Promise.race([ready.then(() => 'ready' as const), exited.then(() => 'exit' as const), timeout, aborted]);
  clearTimeout(timer);

  let result: ServerTestResult;
  if (first === 'ready') {
    emit('ready');
    await sleep(opts.settleMs ?? 5000);
    const code = await stop();
    result = { status: 'done', exitCode: code } as ServerTestResult;
  } else if (first === 'exit') {
    result = { status: 'crashed', exitCode: await exited } as ServerTestResult;
  } else {
    const code = await stop();
    result = { status: first === 'timeout' ? 'timeout' : 'failed', exitCode: code, message: first === 'timeout' ? `no "Done" after ${Math.round(opts.readyTimeoutMs / 1000)} s` : 'cancelled' } as ServerTestResult;
  }
  await new Promise<void>((resolve) => log.end(resolve));
  return finish(result.status, result.exitCode, result.message);
}

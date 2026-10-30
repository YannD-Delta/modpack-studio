import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { blankPauseLines, detectStartScript, EulaNotAcceptedError, LogSummarizer, NotEnoughSpaceError, prepareServerDir, runServerTest, summarizeLog } from '../../src/server/testbench/server-test.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function put(root: string, rel: string, content: string) {
  const full = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function makeSource(): string {
  const src = path.join(tmp, 'source');
  put(src, 'mods/a.jar', 'jar');
  put(src, 'config/a.toml', 'x = 1\n');
  put(src, 'libraries/lib.jar', 'lib');
  put(src, 'world/level.dat', 'WORLD');
  put(src, 'logs/latest.log', 'old log');
  put(src, 'crash-reports/crash-old.txt', 'old crash');
  put(src, 'server.properties', 'level-name=world\nserver-port=25565\nonline-mode=true\nmotd=Own\n');
  put(src, 'user_jvm_args.txt', '-Xms24G\n-Xmx48G\n-XX:+UseG1GC\n-XX:+AlwaysPreTouch\n');
  put(src, 'eula.txt', 'eula=true\n');
  put(src, 'run.bat', '@echo off\r\n');
  return src;
}

describe('prepareServerDir', () => {
  it('copies the server without its world, logs and crash reports, and rewrites port, online mode and memory', async () => {
    const dest = path.join(tmp, 'run', 'server');
    await prepareServerDir({ sourceDir: makeSource(), destDir: dest, port: 25570, memoryMb: 8192, acceptEula: false });
    expect(fs.existsSync(path.join(dest, 'mods', 'a.jar'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'libraries', 'lib.jar'))).toBe(true);
    for (const gone of ['world', 'logs', 'crash-reports']) expect(fs.existsSync(path.join(dest, gone)), gone).toBe(false);
    const props = fs.readFileSync(path.join(dest, 'server.properties'), 'utf8');
    expect(props).toMatch(/^server-port=25570$/m);
    expect(props).toMatch(/^online-mode=false$/m);
    expect(props).toMatch(/^motd=Own$/m);
    const jvm = fs.readFileSync(path.join(dest, 'user_jvm_args.txt'), 'utf8');
    expect(jvm).toMatch(/^-Xms8192M$/m);
    expect(jvm).toMatch(/^-Xmx8192M$/m);
    expect(jvm).toContain('-XX:+UseG1GC');
    expect(jvm).not.toContain('AlwaysPreTouch');
    expect(fs.readFileSync(path.join(tmp, 'source', 'world', 'level.dat'), 'utf8')).toBe('WORLD'); // the source is never touched
  });

  it('follows the level-name of server.properties to leave the right world behind', async () => {
    const src = makeSource();
    put(src, 'server.properties', 'level-name=monde\n');
    put(src, 'monde/level.dat', 'W2');
    await prepareServerDir({ sourceDir: src, destDir: path.join(tmp, 'd'), port: 25570, memoryMb: 4096, acceptEula: false });
    expect(fs.existsSync(path.join(tmp, 'd', 'monde'))).toBe(false);
  });

  it('keeps an EULA already accepted, refuses to run without one, and writes it only when told to', async () => {
    const src = makeSource();
    fs.rmSync(path.join(src, 'eula.txt'));
    await expect(prepareServerDir({ sourceDir: src, destDir: path.join(tmp, 'a'), port: 25570, memoryMb: 4096, acceptEula: false })).rejects.toThrow(EulaNotAcceptedError);
    await prepareServerDir({ sourceDir: src, destDir: path.join(tmp, 'b'), port: 25570, memoryMb: 4096, acceptEula: true });
    expect(fs.readFileSync(path.join(tmp, 'b', 'eula.txt'), 'utf8')).toMatch(/^eula=true$/m);
  });

  it('switches off, in the copy only, the mods that would talk to the real Discord or fight for the map port', async () => {
    const src = makeSource();
    put(src, 'mods/SimpleDiscordLink-Universal-3.2.2.jar', 'jar');
    put(src, 'mods/Dynmap-3.7.jar', 'jar');
    put(src, 'sdlinkstorage/state.json', '{}');
    const out = await prepareServerDir({ sourceDir: src, destDir: path.join(tmp, 'd'), port: 25570, memoryMb: 4096, acceptEula: false });
    expect(out.disabledMods.sort()).toEqual(['Dynmap-3.7.jar', 'SimpleDiscordLink-Universal-3.2.2.jar']);
    expect(fs.existsSync(path.join(tmp, 'd', 'mods', 'SimpleDiscordLink-Universal-3.2.2.jar.disabled'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'd', 'mods', 'SimpleDiscordLink-Universal-3.2.2.jar'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'd', 'mods', 'a.jar'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'd', 'sdlinkstorage'))).toBe(false);
    expect(fs.existsSync(path.join(src, 'mods', 'SimpleDiscordLink-Universal-3.2.2.jar'))).toBe(true); // the source is untouched
  });

  it('creates the memory file and the properties when the source has none', async () => {
    const src = path.join(tmp, 'bare');
    put(src, 'mods/a.jar', 'jar');
    put(src, 'eula.txt', 'eula=true\n');
    await prepareServerDir({ sourceDir: src, destDir: path.join(tmp, 'd'), port: 25571, memoryMb: 2048, acceptEula: false });
    expect(fs.readFileSync(path.join(tmp, 'd', 'user_jvm_args.txt'), 'utf8')).toContain('-Xmx2048M');
    expect(fs.readFileSync(path.join(tmp, 'd', 'server.properties'), 'utf8')).toContain('server-port=25571');
  });
});

describe('prepareServerDir safety', () => {
  const run = (src: string, name = 'd', extra: Record<string, unknown> = {}) => prepareServerDir({ sourceDir: src, destDir: path.join(tmp, name), port: 25570, memoryMb: 4096, acceptEula: false, ...extra });
  const levelOf = (name = 'd') => /^level-name=(.*)$/m.exec(fs.readFileSync(path.join(tmp, name, 'server.properties'), 'utf8'))?.[1];

  it.each(['../shared-world', 'D:/fast-disk/world', '/abs/world', 'worlds/../../x'])('forces level-name=world in the copy when the source says %s', async (level) => {
    const src = makeSource();
    put(src, 'server.properties', `level-name=${level}\nmotd=Own\n`);
    await run(src);
    expect(levelOf()).toBe('world');
    expect(fs.readFileSync(path.join(tmp, 'd', 'server.properties'), 'utf8')).toMatch(/^motd=Own$/m);
  });

  it('leaves a world kept in a sub folder behind, with its dimensions, but copies its siblings', async () => {
    const src = makeSource();
    put(src, 'server.properties', 'level-name=worlds/survival\n');
    put(src, 'worlds/survival/level.dat', 'W');
    put(src, 'worlds/survival_nether/level.dat', 'N');
    put(src, 'worlds/readme.txt', 'keep');
    await run(src);
    expect(fs.existsSync(path.join(tmp, 'd', 'worlds', 'survival'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'd', 'worlds', 'survival_nether'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'd', 'worlds', 'readme.txt'))).toBe(true);
    expect(levelOf()).toBe('world');
  });

  it('never recreates a link of the source in the copy and reports it, whatever it points to', async () => {
    const src = makeSource();
    const shared = path.join(tmp, 'shared-mods');
    put(shared, 'x.jar', 'jar');
    put(shared, 'SimpleDiscordLink-1.jar', 'jar');
    fs.rmSync(path.join(src, 'mods'), { recursive: true });
    fs.symlinkSync(shared, path.join(src, 'mods'), 'junction');
    const out = await run(src);
    expect(out.skippedLinks).toEqual(['mods']);
    expect(fs.existsSync(path.join(tmp, 'd', 'mods'))).toBe(false);
    expect(fs.existsSync(path.join(shared, 'SimpleDiscordLink-1.jar'))).toBe(true); // nothing was renamed through a link
    expect(fs.readFileSync(path.join(src, 'server.properties'), 'utf8')).toContain('online-mode=true');
  });

  it('copies the content of a source folder that is itself a link into a real folder', async () => {
    const real = makeSource();
    const link = path.join(tmp, 'link-to-server');
    fs.symlinkSync(real, link, 'junction');
    await run(link);
    expect(fs.lstatSync(path.join(tmp, 'd')).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'd', 'mods', 'a.jar'))).toBe(true);
    expect(fs.readFileSync(path.join(real, 'server.properties'), 'utf8')).toContain('online-mode=true');
  });

  it('ignores a link inside a folder that is not copied anyway', async () => {
    const src = makeSource();
    fs.mkdirSync(path.join(tmp, 'elsewhere'));
    fs.symlinkSync(path.join(tmp, 'elsewhere'), path.join(src, 'logs', 'old'), 'junction');
    const out = await run(src);
    expect(out.skippedLinks).toEqual([]);
  });

  it('fails early with code not-enough-space, before copying anything', async () => {
    const src = makeSource();
    const err = await run(src, 'd', { getFreeBytes: async () => 10 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotEnoughSpaceError);
    expect((err as NotEnoughSpaceError).code).toBe('not-enough-space');
    expect(fs.existsSync(path.join(tmp, 'd', 'mods'))).toBe(false);
  });

  it('stops copying when cancelled', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(run(makeSource(), 'd', { signal: ctrl.signal })).rejects.toThrow(/cancel/i);
    expect(fs.existsSync(path.join(tmp, 'd', 'mods', 'a.jar'))).toBe(false);
  });
});

describe('blankPauseLines', () => {
  it('blanks standalone pause lines, keeps the other bytes and the CRLF', () => {
    const f = path.join(tmp, 'x.bat');
    fs.writeFileSync(f, '@echo off\r\njava -jar s.jar\r\n@PAUSE >nul\r\n  pause\r\necho pausefoo\r\nrem pause\r\n', 'latin1');
    blankPauseLines(f);
    expect(fs.readFileSync(f, 'latin1')).toBe('@echo off\r\njava -jar s.jar\r\n\r\n\r\necho pausefoo\r\nrem pause\r\n');
  });
});

describe('LogSummarizer', () => {
  it('gives the same summary as summarizeLog whatever the chunk boundaries', () => {
    const text = '[1:00:00] [a/ERROR] [m]: x\r\n[1:00:01] [a/WARN] [m]: y\n[1:00:02] [a/INFO] [m]: Done (3,5s)! For help\n[1:00:03] [a/ERROR] [m]: tail without newline';
    const s = new LogSummarizer();
    for (let i = 0; i < text.length; i += 7) s.push(text.slice(i, i + 7));
    expect(s.end()).toEqual(summarizeLog(text));
    expect(summarizeLog(text)).toMatchObject({ errorLines: 2, warnLines: 1, bootSeconds: 3.5 });
  });
});

describe('detectStartScript', () => {
  it('prefers run.bat, then startserver.bat, then start.bat, and returns null without any', () => {
    const d = path.join(tmp, 's');
    fs.mkdirSync(d);
    expect(detectStartScript(d)).toBeNull();
    fs.writeFileSync(path.join(d, 'start.bat'), '');
    expect(detectStartScript(d)).toBe('start.bat');
    fs.writeFileSync(path.join(d, 'run.bat'), '');
    expect(detectStartScript(d)).toBe('run.bat');
  });
});

describe('summarizeLog', () => {
  const log = [
    '[12:00:01] [main/INFO] [FML]: Loading',
    '[12:00:02] [main/WARN] [mixin]: something odd',
    '[12:00:03] [Worker/ERROR] [mod_a]: could not load thing',
    '[12:00:03] [Worker/ERROR] [mod_a]: could not load thing',
    '[12:00:04] [Server thread/FATAL] [mc]: bad',
    '[12:00:09] [Server thread/INFO] [minecraft/DedicatedServer]: Done (12,345s)! For help, type "help"',
  ].join('\n');

  it('counts warnings and errors, keeps the distinct first errors and reads the boot time (dot or comma)', () => {
    const s = summarizeLog(log);
    expect(s.warnLines).toBe(1);
    expect(s.errorLines).toBe(3);
    expect(s.firstErrors).toEqual(['[Worker/ERROR] [mod_a]: could not load thing', '[Server thread/FATAL] [mc]: bad']);
    expect(s.bootSeconds).toBeCloseTo(12.345, 3);
    expect(summarizeLog('Done (3.5s)!').bootSeconds).toBe(3.5);
    expect(summarizeLog('nothing here').bootSeconds).toBeNull();
  });
});

/** A stand-in for the game server: a tiny Node script that behaves like one of three servers. */
function fakeServer(mode: 'ok' | 'crash' | 'hang' | 'stubborn' | 'dies'): { command: string; args: string[] } {
  const script = path.join(tmp, `fake-${mode}.cjs`);
  fs.writeFileSync(
    script,
    [
      "const fs = require('fs');",
      `const mode = ${JSON.stringify(mode)};`,
      "console.log('[10:00:00] [main/INFO] [FML]: starting');",
      "if (mode === 'crash') {",
      "  console.error('[10:00:01] [main/ERROR] [mod_x]: Failed to load mod_x');",
      "  fs.mkdirSync('crash-reports', { recursive: true });",
      "  fs.writeFileSync('crash-reports/crash-test.txt', 'Description: exception in loading');",
      '  process.exit(1);',
      '}',
      "if (mode === 'ok' || mode === 'stubborn' || mode === 'dies') setTimeout(() => console.log('[10:00:02] [Server thread/INFO] [DedicatedServer]: Done (1.234s)! For help, type \"help\"'), 150);",
      "if (mode === 'dies') setTimeout(() => process.exit(3), 400);",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (d) => { if (mode === 'ok' && d.includes('stop')) { console.log('[10:00:03] [Server thread/INFO]: Stopping server'); process.exit(0); } });",
      'setInterval(() => {}, 1000);',
    ].join('\n'),
  );
  return { command: process.execPath, args: [script] };
}

describe('runServerTest', () => {
  const base = (name: string) => {
    const src = makeSource();
    return { sourceDir: src, runDir: path.join(tmp, name), port: 25570, memoryMb: 1024, acceptEula: false, readyTimeoutMs: 5000, settleMs: 50, stopGraceMs: 3000 };
  };

  it('starts, waits for "Done", stops cleanly and keeps the console log and a result', async () => {
    const seen: string[] = [];
    const r = await runServerTest({ ...base('ok'), startCommand: fakeServer('ok'), onStatus: (s) => seen.push(s) });
    expect(r.status).toBe('done');
    expect(r.bootSeconds).toBeCloseTo(1.234, 3);
    expect(r.exitCode).toBe(0);
    expect(seen).toEqual(['copying', 'starting', 'ready', 'stopping', 'done']);
    const log = fs.readFileSync(path.join(tmp, 'ok', 'console.log'), 'utf8');
    expect(log).toContain('Done (1.234s)!');
    expect(log).toContain('Stopping server');
    expect(JSON.parse(fs.readFileSync(path.join(tmp, 'ok', 'result.json'), 'utf8')).status).toBe('done');
  });

  it('reports a crash before "Done" with its crash reports and first errors', async () => {
    const r = await runServerTest({ ...base('crash'), startCommand: fakeServer('crash') });
    expect(r.status).toBe('crashed');
    expect(r.exitCode).toBe(1);
    expect(r.crashReports).toEqual(['crash-test.txt']);
    expect(r.summary.firstErrors.join(' ')).toContain('Failed to load mod_x');
  });

  it('gives up after the ready timeout and kills a server that ignores "stop"', async () => {
    const t0 = Date.now();
    const r = await runServerTest({ ...base('hang'), readyTimeoutMs: 400, stopGraceMs: 300, startCommand: fakeServer('hang') });
    expect(r.status).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('stops when asked to cancel', async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 300);
    const r = await runServerTest({ ...base('abort'), readyTimeoutMs: 8000, stopGraceMs: 300, startCommand: fakeServer('hang'), signal: ctrl.signal });
    expect(r.status).toBe('failed');
    expect(r.message).toMatch(/cancel/i);
  });

  it('fails clearly when there is no start script and no command is given', async () => {
    const opts = base('noscript');
    fs.rmSync(path.join(opts.sourceDir, 'run.bat'));
    const r = await runServerTest(opts);
    expect(r.status).toBe('failed');
    expect(r.message).toMatch(/start script/i);
  });

  it('fails clearly when the EULA is missing and not accepted', async () => {
    const opts = base('noeula');
    fs.rmSync(path.join(opts.sourceDir, 'eula.txt'));
    const r = await runServerTest({ ...opts, startCommand: fakeServer('ok') });
    expect(r.status).toBe('failed');
    expect(r.message).toMatch(/eula/i);
  });
});

describe('runServerTest outcome and housekeeping', () => {
  const base = (name: string) => ({ sourceDir: makeSource(), runDir: path.join(tmp, name), port: 25570, memoryMb: 1024, acceptEula: false, readyTimeoutMs: 5000, settleMs: 50, stopGraceMs: 3000 });

  it('removes the server copy at the end but keeps the result, the log and the crash reports', async () => {
    const r = await runServerTest({ ...base('crash2'), startCommand: fakeServer('crash') });
    const dir = path.join(tmp, 'crash2');
    expect(fs.existsSync(path.join(dir, 'server'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'result.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'console.log'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'crash-reports', 'crash-test.txt'), 'utf8')).toContain('exception in loading');
    expect(r.crashReports).toEqual(['crash-test.txt']);
  });

  it('keeps the copy only when asked to', async () => {
    await runServerTest({ ...base('keep'), startCommand: fakeServer('ok'), keepCopy: true });
    expect(fs.existsSync(path.join(tmp, 'keep', 'server', 'mods', 'a.jar'))).toBe(true);
  });

  it('removes the partial copy of a failed run (not enough space) and reports the code', async () => {
    const r = await runServerTest({ ...base('space'), startCommand: fakeServer('ok'), getFreeBytes: async () => 5 });
    expect(r.status).toBe('failed');
    expect(r.code).toBe('not-enough-space');
    expect(fs.existsSync(path.join(tmp, 'space', 'server'))).toBe(false);
  });

  it('reports stopOutcome clean after a normal stop and exited-early after a crash', async () => {
    expect((await runServerTest({ ...base('o1'), startCommand: fakeServer('ok') })).stopOutcome).toBe('clean');
    expect((await runServerTest({ ...base('o2'), startCommand: fakeServer('crash') })).stopOutcome).toBe('exited-early');
  });

  it('reports forced when the server ignores stop and has to be killed, the status staying done', async () => {
    const r = await runServerTest({ ...base('o3'), stopGraceMs: 300, startCommand: fakeServer('stubborn') });
    expect(r.status).toBe('done');
    expect(r.stopOutcome).toBe('forced');
    expect(JSON.parse(fs.readFileSync(path.join(tmp, 'o3', 'result.json'), 'utf8')).stopOutcome).toBe('forced');
  });

  it('reports exited-early when the server dies by itself right after Done', async () => {
    const r = await runServerTest({ ...base('o4'), settleMs: 3000, startCommand: fakeServer('dies') });
    expect(r.status).toBe('done');
    expect(r.stopOutcome).toBe('exited-early');
    expect(r.exitCode).toBe(3);
  });

  it('a cancel during the settle pause after Done ends the run at once as failed/cancelled', async () => {
    const ctrl = new AbortController();
    const t0 = Date.now();
    const r = await runServerTest({
      ...base('o5'),
      settleMs: 20_000,
      startCommand: fakeServer('ok'),
      signal: ctrl.signal,
      onStatus: (s) => {
        if (s === 'ready') ctrl.abort();
      },
    });
    expect(r.status).toBe('failed');
    expect(r.message).toMatch(/cancel/i);
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it('a cancel during the copy returns before any process is started', async () => {
    const marker = path.join(tmp, 'started.txt');
    const script = path.join(tmp, 'marker.cjs');
    fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); setInterval(() => {}, 1000);`);
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await runServerTest({ ...base('o6'), startCommand: { command: process.execPath, args: [script] }, signal: ctrl.signal });
    expect(r.status).toBe('failed');
    expect(r.message).toMatch(/cancel/i);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('caps the console log (head then a marker) while the summary still counts every line', async () => {
    const script = path.join(tmp, 'noisy.cjs');
    fs.writeFileSync(
      script,
      "for (let i = 0; i < 2000; i++) console.log('[10:00:00] [main/ERROR] [m]: line ' + i + ' ' + 'x'.repeat(100)); console.log('[10:00:02] [Server thread/INFO]: Done (1.0s)! For help'); process.stdin.on('data', () => process.exit(0)); setInterval(() => {}, 1000);",
    );
    const r = await runServerTest({ ...base('o7'), startCommand: { command: process.execPath, args: [script] }, maxLogBytes: 20_000 });
    const size = fs.statSync(path.join(tmp, 'o7', 'console.log')).size;
    expect(size).toBeLessThan(21_000);
    expect(fs.readFileSync(path.join(tmp, 'o7', 'console.log'), 'utf8')).toMatch(/log truncated/);
    expect(r.status).toBe('done');
    expect(r.summary.errorLines).toBe(2000);
    expect(r.bootSeconds).toBe(1);
  });

  it('survives an I/O error on the console log (the run still ends with a result)', async () => {
    const opts = base('o8');
    fs.mkdirSync(path.join(opts.runDir, 'console.log'), { recursive: true }); // opening it for writing fails with EISDIR
    const r = await runServerTest({ ...opts, startCommand: fakeServer('ok') });
    expect(r.status).toBe('done');
    expect(fs.existsSync(path.join(opts.runDir, 'result.json'))).toBe(true);
  });
});

/** Real cmd.exe path: a start script that ends in pause must not hold the run. */
describe.skipIf(process.platform !== 'win32')('runServerTest with a real start script', () => {
  function sourceWithBat(bat: (nodeExe: string, script: string) => string, mode: 'ok' | 'crash') {
    const src = makeSource();
    const fake = fakeServer(mode);
    fs.writeFileSync(path.join(src, 'run.bat'), bat(fake.command, fake.args[0]!).replace(/\n/g, '\r\n'));
    return src;
  }
  const opts = (src: string, name: string) => ({ sourceDir: src, runDir: path.join(tmp, name), port: 25570, memoryMb: 1024, acceptEula: false, readyTimeoutMs: 8000, settleMs: 50, stopGraceMs: 6000 });

  it('a start script ending in pause: a clean stop does not wait for the wrapper', async () => {
    const src = sourceWithBat((node, script) => `@echo off\n"${node}" "${script}"\npause\n`, 'ok');
    const t0 = Date.now();
    const r = await runServerTest(opts(src, 'bat-ok'));
    expect(r.status).toBe('done');
    expect(r.exitCode).toBe(0);
    expect(r.stopOutcome).toBe('clean');
    expect(Date.now() - t0).toBeLessThan(5500);
  });

  it('a start script ending in pause: a crash before Done is a crash, not a timeout', async () => {
    const src = sourceWithBat((node, script) => `@echo off\n"${node}" "${script}"\npause >nul\n`, 'crash');
    const t0 = Date.now();
    const r = await runServerTest(opts(src, 'bat-crash'));
    expect(r.status).toBe('crashed');
    expect(Date.now() - t0).toBeLessThan(7000);
  });

  it('a wrapper that lingers after the server stopped is killed with its whole tree after the grace period', async () => {
    const src = sourceWithBat((node, script) => `@echo off\n"${node}" "${script}"\nping -n 40 127.0.0.1 >nul\n`, 'ok');
    const t0 = Date.now();
    const r = await runServerTest({ ...opts(src, 'bat-linger'), stopGraceMs: 1500 });
    expect(r.status).toBe('done');
    expect(r.stopOutcome).toBe('forced');
    expect(Date.now() - t0).toBeLessThan(9000);
  });
});

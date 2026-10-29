import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectStartScript, EulaNotAcceptedError, prepareServerDir, runServerTest, summarizeLog } from '../../src/server/testbench/server-test.js';

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
function fakeServer(mode: 'ok' | 'crash' | 'hang'): { command: string; args: string[] } {
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
      "if (mode === 'ok') setTimeout(() => console.log('[10:00:02] [Server thread/INFO] [DedicatedServer]: Done (1.234s)! For help, type \"help\"'), 150);",
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

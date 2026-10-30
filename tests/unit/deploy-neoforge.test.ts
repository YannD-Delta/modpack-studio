import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyPack } from '../../src/server/deploy/apply-engine.js';
import { detectInstalledNeoForge, isValidNeoForgeVersion, planNeoForgeCleanup } from '../../src/server/deploy/neoforge-cleanup.js';

let tmp: string;
let server: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-neoforge-'));
  server = path.join(tmp, 'server');
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const write = (rel: string, content = 'x', root = server) => {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
const LIB = 'libraries/net/neoforged/neoforge';
const install = (version: string) => {
  write(`${LIB}/${version}/neoforge-${version}-server.jar`);
  write(`${LIB}/${version}/win_args.txt`, 'args');
  write(`${LIB}/${version}/unix_args.txt`, 'args');
};

describe('planNeoForgeCleanup', () => {
  it('names the old version folder when the version changed and it is installed', () => {
    install('21.1.100');
    install('21.1.172');
    expect(planNeoForgeCleanup(server, '21.1.100', '21.1.172')).toEqual([`${LIB}/21.1.100`]);
  });

  it('returns [] when the versions are equal', () => {
    install('21.1.100');
    expect(planNeoForgeCleanup(server, '21.1.100', '21.1.100')).toEqual([]);
  });

  it('returns [] when the old folder is absent, or the server folder is', () => {
    install('21.1.172');
    expect(planNeoForgeCleanup(server, '21.1.100', '21.1.172')).toEqual([]);
    expect(planNeoForgeCleanup(path.join(tmp, 'nope'), '21.1.100', '21.1.172')).toEqual([]);
  });

  it('refuses versions that could build another path', () => {
    install('21.1.100');
    for (const bad of ['', '..', '.', '../x', 'a/b', 'a\\b', '21.1.100 ', '-x', 'x'.repeat(41), 'a:b', 'ü']) {
      expect(() => planNeoForgeCleanup(server, bad, '21.1.172'), bad).toThrow(/valid NeoForge version/);
      expect(() => planNeoForgeCleanup(server, '21.1.100', bad), bad).toThrow(/valid NeoForge version/);
    }
    expect(isValidNeoForgeVersion('21.1.172')).toBe(true);
    expect(isValidNeoForgeVersion('21.0.0-beta+build_1')).toBe(true);
  });
});

describe('detectInstalledNeoForge', () => {
  it('reads the only version folder', () => {
    install('21.1.100');
    expect(detectInstalledNeoForge(server)).toBe('21.1.100');
  });

  it('returns null for no install, and for several folders with no launch file', () => {
    fs.mkdirSync(server);
    expect(detectInstalledNeoForge(server)).toBeNull();
    install('21.1.100');
    install('21.1.172');
    expect(detectInstalledNeoForge(server)).toBeNull();
  });

  it('prefers the version the launch files point at when several folders exist', () => {
    install('21.1.100');
    install('21.1.172');
    write('run.bat', 'java @user_jvm_args.txt @libraries/net/neoforged/neoforge/21.1.172/win_args.txt %*');
    expect(detectInstalledNeoForge(server)).toBe('21.1.172');
  });

  it('understands run.sh and user_jvm_args.txt, with either slash', () => {
    install('21.1.100');
    install('21.1.172');
    write('run.sh', 'java @libraries/net/neoforged/neoforge/21.1.100/unix_args.txt "$@"');
    expect(detectInstalledNeoForge(server)).toBe('21.1.100');
    fs.rmSync(path.join(server, 'run.sh'));
    write('user_jvm_args.txt', '@libraries\\net\\neoforged\\neoforge\\21.1.172\\win_args.txt');
    expect(detectInstalledNeoForge(server)).toBe('21.1.172');
  });

  it('ignores a launch file that points at a folder which is not there', () => {
    install('21.1.100');
    write('run.bat', '@libraries/net/neoforged/neoforge/99.9.9/win_args.txt');
    expect(detectInstalledNeoForge(server)).toBe('21.1.100');
  });
});

describe('with the apply engine', () => {
  const pack = (packDir: string) => {
    const jar = 'new-mod';
    write(`mods-add/${jar}.jar`, jar, packDir);
    write('remove.txt', '', packDir);
    write('changes.json', JSON.stringify({ name: 'nf', jars: [{ file: `${jar}.jar`, sha256: crypto.createHash('sha256').update(jar).digest('hex') }], files: [] }), packDir);
  };
  const run = (extraRemovals: string[], packDir: string) =>
    applyPack({ packDir, targetDir: server, backupRoot: path.join(tmp, 'backups'), dryRun: false, isRunning: () => false, extraRemovals });

  it('moves only the old version folder to the backup when the version changed', async () => {
    install('21.1.100');
    install('21.1.172');
    write('world/level.dat', 'WORLD');
    write('config/a.toml', 'cfg');
    write('mods/other.jar', 'other');
    pack(path.join(tmp, 'pack'));
    const res = await run(planNeoForgeCleanup(server, '21.1.100', '21.1.172'), path.join(tmp, 'pack'));
    expect(res.status).toBe('applied');
    expect(fs.existsSync(path.join(server, LIB, '21.1.100'))).toBe(false);
    expect(fs.existsSync(path.join(server, LIB, '21.1.172', 'win_args.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(res.backup!.dir, LIB, '21.1.100', 'unix_args.txt'), 'utf8')).toBe('args');
    for (const [rel, c] of [['world/level.dat', 'WORLD'], ['config/a.toml', 'cfg'], ['mods/other.jar', 'other']] as const) {
      expect(fs.readFileSync(path.join(server, rel), 'utf8')).toBe(c);
    }
  });

  it('cleans nothing when the version did not change', async () => {
    install('21.1.172');
    write('mods/other.jar', 'other');
    pack(path.join(tmp, 'pack'));
    const res = await run(planNeoForgeCleanup(server, '21.1.172', '21.1.172'), path.join(tmp, 'pack'));
    expect(res.counts.cleanup).toBe(0);
    expect(fs.existsSync(path.join(server, LIB, '21.1.172', 'win_args.txt'))).toBe(true);
  });
});

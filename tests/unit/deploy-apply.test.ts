import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyPack, ApplyError, type ApplyOptions } from '../../src/server/deploy/apply-engine.js';
import { listBackups, readManifest } from '../../src/server/deploy/backups.js';

let tmp: string;
let server: string;
let packDir: string;
let backups: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-apply-'));
  server = path.join(tmp, 'server');
  packDir = path.join(tmp, 'pack');
  backups = path.join(tmp, 'backups');
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const write = (root: string, rel: string, content: string) => {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

/** A pack folder shaped like the one buildUpdatePack writes. */
function makePack(spec: { jars?: Record<string, string>; files?: Record<string, string>; remove?: string[] }) {
  const jars = Object.entries(spec.jars ?? {});
  const files = Object.entries(spec.files ?? {});
  for (const [f, c] of jars) write(packDir, `mods-add/${f}`, c);
  for (const [p, c] of files) write(packDir, `files-add/${p}`, c);
  write(packDir, 'remove.txt', (spec.remove ?? []).map((n) => `${n}\r\n`).join(''));
  write(
    packDir,
    'changes.json',
    JSON.stringify({
      format: 1,
      name: 'test-pack',
      jars: jars.map(([file, c]) => ({ file, sha256: sha(c), size: c.length, modIds: [] })),
      files: files.map(([p, c]) => ({ path: p, sha256: sha(c), size: c.length })),
      remove: (spec.remove ?? []).map((file) => ({ file, modIds: [] })),
    }),
  );
}

const SERVER_FILES: Record<string, string> = {
  'mods/old-a-1.0.jar': 'old a',
  'mods/keep-b.jar': 'old b',
  'mods/untouched.jar': 'untouched',
  'config/x.toml': 'old x',
  'world/level.dat': 'WORLD DATA',
  'logs/latest.log': 'log',
  'server.properties': 'motd=test',
};
const makeServer = (extra: Record<string, string> = {}) => {
  for (const [rel, c] of Object.entries({ ...SERVER_FILES, ...extra })) write(server, rel, c);
};
const PACK = { jars: { 'new-a-2.0.jar': 'new a', 'keep-b.jar': 'new b' }, files: { 'config/x.toml': 'new x', 'config/added.toml': 'added' }, remove: ['old-a-1.0.jar'] };

function snapshot(dir: string, rel = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      out[`${r}/`] = '<dir>';
      Object.assign(out, snapshot(dir, r));
    } else out[r] = fs.readFileSync(path.join(dir, r), 'utf8');
  }
  return out;
}

const fileSnap = (dir: string) => Object.fromEntries(Object.entries(snapshot(dir)).filter(([k]) => !k.endsWith('/')));

const base = (): ApplyOptions => ({ packDir, targetDir: server, backupRoot: backups, isRunning: () => false });
const apply = (o: Partial<ApplyOptions> = {}) => applyPack({ ...base(), dryRun: false, ...o });
const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ApplyError);
    return (err as ApplyError).code;
  }
  throw new Error('expected a refusal');
};

describe('dry run', () => {
  it('is the default, changes nothing and returns the plan', async () => {
    makeServer();
    makePack(PACK);
    const before = snapshot(server);
    const res = await applyPack(base());
    expect(res.status).toBe('dry_run');
    expect(snapshot(server)).toEqual(before);
    expect(fs.existsSync(backups)).toBe(false);
    expect(res.backup).toBeNull();
    expect(res.counts).toEqual({ add: 2, replace: 2, remove: 1, cleanup: 0, absent: 0 });
    const byPath = new Map(res.plan.map((o) => [o.path, o]));
    expect(byPath.get('mods/new-a-2.0.jar')).toMatchObject({ kind: 'add', source: 'mods-add/new-a-2.0.jar', sha256: sha('new a') });
    expect(byPath.get('mods/keep-b.jar')?.kind).toBe('replace');
    expect(byPath.get('config/x.toml')?.kind).toBe('replace');
    expect(byPath.get('config/added.toml')?.kind).toBe('add');
    expect(byPath.get('mods/old-a-1.0.jar')?.kind).toBe('remove');
  });

  it('reports a jar named in remove.txt that is already gone as absent', async () => {
    makeServer();
    makePack({ remove: ['never-there.jar'] });
    const res = await applyPack(base());
    expect(res.plan).toEqual([{ kind: 'absent', path: 'mods/never-there.jar' }]);
  });

  it('still reports gameRunning, and does not refuse', async () => {
    makeServer();
    makePack(PACK);
    const res = await applyPack({ ...base(), isRunning: () => true });
    expect(res.status).toBe('dry_run');
    expect(res.gameRunning).toBe(true);
  });
});

describe('apply', () => {
  it('replaces, adds and removes, backing up what it replaces and removes and nothing else', async () => {
    makeServer();
    makePack(PACK);
    const res = await apply({ now: new Date('2026-03-04T05:06:07Z') });
    expect(res.status).toBe('applied');
    expect(res.backup?.stamp).toBe('20260304-050607');
    expect(fileSnap(server)).toEqual({
      'mods/new-a-2.0.jar': 'new a',
      'mods/keep-b.jar': 'new b',
      'mods/untouched.jar': 'untouched',
      'config/x.toml': 'new x',
      'config/added.toml': 'added',
      'world/level.dat': 'WORLD DATA',
      'logs/latest.log': 'log',
      'server.properties': 'motd=test',
    });
    const dir = res.backup!.dir;
    expect(snapshot(dir)).toMatchObject({ 'mods/old-a-1.0.jar': 'old a', 'mods/keep-b.jar': 'old b', 'config/x.toml': 'old x' });
    expect(Object.keys(fileSnap(dir)).sort()).toEqual(['config/x.toml', 'manifest.json', 'mods/keep-b.jar', 'mods/old-a-1.0.jar']);
    const m = readManifest(dir)!;
    expect(m).toMatchObject({ status: 'applied', packName: 'test-pack', removed: ['mods/old-a-1.0.jar'] });
    expect([...m.replaced].sort()).toEqual(['config/x.toml', 'mods/keep-b.jar']);
    expect([...m.added].sort()).toEqual(['config/added.toml', 'mods/new-a-2.0.jar']);
    expect(Object.keys(fileSnap(server)).some((k) => k.includes('.studio-tmp'))).toBe(false);
  });

  it('cleans up extraRemovals into the backup (a folder moves whole)', async () => {
    makeServer({ 'libraries/net/neoforged/neoforge/1.0.0/win_args.txt': 'args', 'libraries/net/neoforged/neoforge/1.0.0/sub/x.jar': 'jar' });
    makePack({ jars: { 'new.jar': 'n' } });
    const res = await apply({ extraRemovals: ['libraries/net/neoforged/neoforge/1.0.0', 'libraries/gone/1.0'] });
    expect(res.counts).toMatchObject({ cleanup: 1, absent: 1 });
    expect(fs.existsSync(path.join(server, 'libraries/net/neoforged/neoforge/1.0.0'))).toBe(false);
    expect(snapshot(res.backup!.dir)['libraries/net/neoforged/neoforge/1.0.0/sub/x.jar']).toBe('jar');
    expect(fs.readFileSync(path.join(server, 'world/level.dat'), 'utf8')).toBe('WORLD DATA');
  });

  it('aborts untouched with pack_corrupt when a pack file does not match its sha256', async () => {
    makeServer();
    makePack(PACK);
    fs.writeFileSync(path.join(packDir, 'mods-add', 'new-a-2.0.jar'), 'tampered');
    const before = snapshot(server);
    expect(await codeOf(apply())).toBe('pack_corrupt');
    expect(snapshot(server)).toEqual(before);
    expect(fs.existsSync(backups)).toBe(false);
  });

  it('aborts with pack_corrupt for a file the pack holds but changes.json does not list, or lists but lacks', async () => {
    makeServer();
    makePack(PACK);
    write(packDir, 'files-add/config/sneaky.toml', 'x');
    expect(await codeOf(apply())).toBe('pack_corrupt');
    fs.rmSync(path.join(packDir, 'files-add/config/sneaky.toml'));
    fs.rmSync(path.join(packDir, 'files-add/config/added.toml'));
    expect(await codeOf(apply())).toBe('pack_corrupt');
  });

  it('rolls back and leaves the target byte-identical when the second copy fails', async () => {
    makeServer();
    makePack(PACK);
    const before = snapshot(server);
    let writes = 0;
    const res = await apply({
      fs: {
        copyFile: async (src, dest) => {
          if (dest.endsWith('.studio-tmp') && ++writes === 2) throw new Error('disk full (injected)');
          fs.copyFileSync(src, dest);
        },
      },
    });
    expect(res.status).toBe('rolled_back');
    expect(res.cause).toContain('disk full (injected)');
    expect(snapshot(server)).toEqual(before);
    expect(readManifest(res.backup!.dir)?.status).toBe('rolled_back');
  });

  it('rolls back a failure that happens while backing up, before anything was touched', async () => {
    makeServer();
    makePack(PACK);
    const before = snapshot(server);
    const res = await apply({
      fs: {
        copyFile: async (src, dest) => {
          if (dest.includes('keep-b.jar') && dest.startsWith(backups)) throw new Error('backup disk error (injected)');
          fs.copyFileSync(src, dest);
        },
      },
    });
    expect(res.status).toBe('rolled_back');
    expect(snapshot(server)).toEqual(before);
  });

  it('reports rollback_incomplete, with the paths, when the rollback itself fails', async () => {
    makeServer();
    makePack(PACK);
    let broken = false;
    const res = await apply({
      fs: {
        copyFile: async (src, dest) => {
          if (dest.endsWith('.studio-tmp') && !broken) {
            broken = true;
            throw new Error('first failure (injected)');
          }
          if (broken) throw new Error('still failing (injected)');
          fs.copyFileSync(src, dest);
        },
      },
    });
    expect(res.status).toBe('rollback_incomplete');
    expect(res.rollbackErrors?.some((e) => e.includes('mods/old-a-1.0.jar'))).toBe(true);
    // the originals are still in the backup folder
    expect(fs.readFileSync(path.join(res.backup!.dir, 'mods/old-a-1.0.jar'), 'utf8')).toBe('old a');
  });

  it('keeps only keepBackups backups (default 2, the deploy.keepBackups limit)', async () => {
    makeServer();
    makePack(PACK);
    const stamps: string[] = [];
    for (let i = 0; i < 4; i++) stamps.push((await apply({ now: new Date(Date.UTC(2026, 0, 1, 0, 0, i)) })).backup!.stamp);
    expect(listBackups(backups).map((b) => b.stamp)).toEqual([stamps[3], stamps[2]]);
    const last = await apply({ now: new Date(Date.UTC(2026, 0, 1, 0, 0, 9)), keepBackups: 1 });
    expect(last.prunedBackups.length).toBe(2);
    expect(listBackups(backups).map((b) => b.stamp)).toEqual([last.backup!.stamp]);
  });

  it('gives two applies in the same second their own backup folder', async () => {
    makeServer();
    makePack(PACK);
    const now = new Date('2026-01-01T00:00:00Z');
    const a = await apply({ now });
    const b = await apply({ now });
    expect(b.backup!.stamp).toBe(`${a.backup!.stamp}-2`);
    expect(listBackups(backups).map((x) => x.stamp)).toEqual([`${a.backup!.stamp}-2`, a.backup!.stamp]);
  });

  it('refuses a keepBackups outside 1 to 20', async () => {
    makeServer();
    makePack(PACK);
    await expect(applyPack({ ...base(), keepBackups: 0 })).rejects.toThrow(RangeError);
    await expect(applyPack({ ...base(), keepBackups: 21 })).rejects.toThrow(RangeError);
  });
});

describe('refusals', () => {
  it('refuses path traversal in remove.txt, changes.json and extraRemovals, changing nothing', async () => {
    makeServer();
    const before = snapshot(server);
    for (const bad of ['../outside.jar', 'sub/evil.jar', 'C:evil.jar', '..']) {
      fs.rmSync(packDir, { recursive: true, force: true });
      makePack({ jars: { 'a.jar': 'a' } });
      write(packDir, 'remove.txt', `${bad}\r\n`);
      expect(await codeOf(apply()), bad).toBe('unsafe_path');
    }
    fs.rmSync(packDir, { recursive: true, force: true });
    makePack({ jars: { 'a.jar': 'a' } });
    const changes = JSON.parse(fs.readFileSync(path.join(packDir, 'changes.json'), 'utf8'));
    changes.files = [{ path: '../escape.txt', sha256: sha('x') }];
    fs.writeFileSync(path.join(packDir, 'changes.json'), JSON.stringify(changes));
    expect(await codeOf(apply())).toBe('unsafe_path');

    fs.rmSync(packDir, { recursive: true, force: true });
    makePack({ jars: { 'a.jar': 'a' } });
    for (const bad of ['../outside', 'a/../../b', '/abs/path', 'C:/Windows', '\\\\host\\share\\x', 'libraries\\x\\y', 'world', 'mods/./x', 'manifest.json/x', '']) {
      expect(await codeOf(apply({ extraRemovals: [bad] })), bad).toBe('unsafe_path');
    }
    expect(snapshot(server)).toEqual(before);
    expect(fs.existsSync(backups)).toBe(false);
  });

  it('refuses an extraRemovals path that goes through a junction leaving the target', async () => {
    makeServer();
    const outside = path.join(tmp, 'outside');
    write(outside, 'precious.txt', 'keep me');
    fs.mkdirSync(path.join(server, 'libraries'), { recursive: true });
    fs.symlinkSync(outside, path.join(server, 'libraries', 'link'), 'junction');
    makePack({ jars: { 'a.jar': 'a' } });
    expect(await codeOf(apply({ extraRemovals: ['libraries/link/precious.txt'] }))).toBe('unsafe_path');
    expect(await codeOf(apply({ extraRemovals: ['libraries/link'] }))).toBe('unsafe_path');
    expect(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8')).toBe('keep me');
  });

  it('refuses a folder where a file must be written, and overlapping cleanup', async () => {
    write(server, 'mods/a.jar', 'a');
    write(server, 'config/x.toml/inner.txt', 'folder in the way');
    makePack({ files: { 'config/x.toml': 'new' } });
    expect(await codeOf(apply())).toBe('path_conflict');
    fs.rmSync(path.join(server, 'config/x.toml'), { recursive: true });
    fs.rmSync(packDir, { recursive: true, force: true });
    write(server, 'libraries/dep/1.0/a.jar', 'a');
    makePack({ files: { 'libraries/dep/1.0/a.jar': 'new' } });
    expect(await codeOf(apply({ extraRemovals: ['libraries/dep/1.0'] }))).toBe('path_conflict');
  });

  it('refuses target_not_recognised: no content, drive root, missing, relative, empty', async () => {
    makePack({ jars: { 'a.jar': 'a' } });
    fs.mkdirSync(path.join(tmp, 'empty'));
    for (const dir of [path.join(tmp, 'empty'), path.parse(tmp).root, path.join(tmp, 'nope'), 'relative/dir', '']) {
      expect(await codeOf(apply({ targetDir: dir })), dir).toBe('target_not_recognised');
      expect(await codeOf(applyPack({ ...base(), targetDir: dir })), dir).toBe('target_not_recognised');
    }
    expect(fs.existsSync(backups)).toBe(false);
  });

  it('accepts any one marker', async () => {
    makePack({ files: { 'x.txt': 'x' } });
    for (const marker of ['mods/', 'config/', 'libraries/', 'run.bat', 'run.sh', 'server.properties', 'user_jvm_args.txt']) {
      const dir = path.join(tmp, `t-${marker.replace('/', '')}`);
      if (marker.endsWith('/')) fs.mkdirSync(path.join(dir, marker), { recursive: true });
      else write(dir, marker, '');
      expect((await applyPack({ ...base(), targetDir: dir })).status, marker).toBe('dry_run');
    }
  });

  it('refuses to apply while the game runs, changing nothing', async () => {
    makeServer();
    makePack(PACK);
    const before = snapshot(server);
    expect(await codeOf(apply({ isRunning: async () => true }))).toBe('game_running');
    expect(snapshot(server)).toEqual(before);
    expect(fs.existsSync(backups)).toBe(false);
  });

  it('refuses to apply when it cannot tell whether the game runs', async () => {
    makeServer();
    makePack(PACK);
    expect(
      await codeOf(
        apply({
          isRunning: () => {
            throw new Error('no process list');
          },
        }),
      ),
    ).toBe('process_check_failed');
  });

  it('refuses a backupRoot that contains the target', async () => {
    makeServer();
    makePack(PACK);
    expect(await codeOf(apply({ backupRoot: tmp }))).toBe('backup_invalid');
  });

  it('refuses a pack without changes.json', async () => {
    makeServer();
    fs.mkdirSync(packDir);
    expect(await codeOf(apply())).toBe('pack_invalid');
  });
});

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyPack } from '../../src/server/deploy/apply-engine.js';
import { DeployError, listBackups, pruneBackups, readManifest, restoreBackup, type BackupManifest } from '../../src/server/deploy/backups.js';

let tmp: string;
let server: string;
let packDir: string;
let backups: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-backups-'));
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
function snapshot(dir: string, rel = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) Object.assign(out, snapshot(dir, r));
    else out[r] = fs.readFileSync(path.join(dir, r), 'utf8');
  }
  return out;
}
function makePack(jars: Record<string, string>, files: Record<string, string>, remove: string[]) {
  for (const [f, c] of Object.entries(jars)) write(packDir, `mods-add/${f}`, c);
  for (const [p, c] of Object.entries(files)) write(packDir, `files-add/${p}`, c);
  write(packDir, 'remove.txt', remove.map((n) => `${n}\r\n`).join(''));
  write(
    packDir,
    'changes.json',
    JSON.stringify({
      name: 'p',
      jars: Object.entries(jars).map(([file, c]) => ({ file, sha256: sha(c) })),
      files: Object.entries(files).map(([p, c]) => ({ path: p, sha256: sha(c) })),
    }),
  );
}
const manifest = (stamp: string, status: BackupManifest['status']): BackupManifest => ({ format: 1, stamp, createdAt: '2026-01-01T00:00:00.000Z', packName: null, status, replaced: [], removed: [], added: [] });
const fakeBackup = (stamp: string, status: BackupManifest['status'] | null) => {
  const dir = path.join(backups, stamp);
  fs.mkdirSync(dir, { recursive: true });
  if (status) fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest(stamp, status)));
  return dir;
};

describe('listBackups', () => {
  it('lists stamp-named folders only, newest first, with a same-second suffix after its base', () => {
    for (const s of ['20260101-000001', '20260101-000001-2', '20260102-000000', '20250101-000000']) fakeBackup(s, 'applied');
    fs.mkdirSync(path.join(backups, 'notes'));
    fs.mkdirSync(path.join(backups, '20260101-0000'));
    fs.writeFileSync(path.join(backups, '20260303-000000'), 'a file, not a folder');
    expect(listBackups(backups).map((b) => b.stamp)).toEqual(['20260102-000000', '20260101-000001-2', '20260101-000001', '20250101-000000']);
  });

  it('returns [] for a missing folder, and "unknown" for a folder without a readable manifest', () => {
    expect(listBackups(path.join(tmp, 'nope'))).toEqual([]);
    fakeBackup('20260101-000000', null);
    expect(listBackups(backups)[0]?.status).toBe('unknown');
  });
});

describe('pruneBackups', () => {
  it('keeps the newest N and deletes only stamp-named folders', () => {
    for (const s of ['20260101-000000', '20260102-000000', '20260103-000000', '20260104-000000']) fakeBackup(s, 'applied');
    fs.mkdirSync(path.join(backups, 'my-notes'));
    write(backups, 'my-notes/keep.txt', 'mine');
    write(backups, 'readme.txt', 'mine too');
    expect(pruneBackups(backups, 2)).toEqual(['20260102-000000', '20260101-000000']);
    expect(fs.readdirSync(backups).sort()).toEqual(['20260103-000000', '20260104-000000', 'my-notes', 'readme.txt']);
    expect(fs.readFileSync(path.join(backups, 'my-notes/keep.txt'), 'utf8')).toBe('mine');
  });

  it('drops rolled-back backups first without letting them use a keep slot', () => {
    fakeBackup('20260101-000000', 'applied');
    fakeBackup('20260102-000000', 'applied');
    fakeBackup('20260103-000000', 'rolled_back');
    expect(pruneBackups(backups, 2)).toEqual(['20260103-000000']);
    expect(listBackups(backups).map((b) => b.stamp)).toEqual(['20260102-000000', '20260101-000000']);
  });

  it('never deletes a folder with an unreadable manifest beyond keep ... it counts like any other', () => {
    fakeBackup('20260101-000000', null);
    fakeBackup('20260102-000000', 'applied');
    expect(pruneBackups(backups, 1)).toEqual(['20260101-000000']);
  });

  it('refuses a keep below 1 and a missing root is a no-op', () => {
    fakeBackup('20260101-000000', 'applied');
    expect(() => pruneBackups(backups, 0)).toThrow(RangeError);
    expect(() => pruneBackups(backups, 1.5)).toThrow(RangeError);
    expect(listBackups(backups)).toHaveLength(1);
    expect(pruneBackups(path.join(tmp, 'nope'), 2)).toEqual([]);
  });
});

describe('restoreBackup', () => {
  const setup = async () => {
    for (const [rel, c] of Object.entries({ 'mods/old.jar': 'old', 'mods/keep.jar': 'old keep', 'config/x.toml': 'old x', 'world/level.dat': 'WORLD', 'libraries/net/neoforged/neoforge/1.0/a.jar': 'lib' })) write(server, rel, c);
    makePack({ 'new.jar': 'new', 'keep.jar': 'new keep' }, { 'config/x.toml': 'new x', 'brand-new/added.toml': 'added' }, ['old.jar']);
    const before = snapshot(server);
    const res = await applyPack({ packDir, targetDir: server, backupRoot: backups, dryRun: false, isRunning: () => false, extraRemovals: ['libraries/net/neoforged/neoforge/1.0'] });
    expect(res.status).toBe('applied');
    expect(snapshot(server)).not.toEqual(before);
    return { before, stamp: res.backup!.stamp };
  };

  it('returns the target to its previous state, removing the files the apply added', async () => {
    const { before, stamp } = await setup();
    const r = await restoreBackup(backups, stamp, server, { isRunning: () => false });
    expect(r.complete).toBe(true);
    expect(snapshot(server)).toEqual(before);
    expect(r.setAside).toEqual(expect.arrayContaining(['mods/new.jar', 'brand-new/added.toml', 'config/x.toml', 'mods/keep.jar']));
    // set aside, not deleted, and the backup stays complete
    expect(fs.readFileSync(path.join(backups, stamp, '_set-aside/mods/new.jar'), 'utf8')).toBe('new');
    expect(fs.readFileSync(path.join(backups, stamp, 'mods/old.jar'), 'utf8')).toBe('old');
    expect(readManifest(path.join(backups, stamp))?.status).toBe('restored');
  });

  it('can be run twice', async () => {
    const { before, stamp } = await setup();
    await restoreBackup(backups, stamp, server, { isRunning: () => false });
    const again = await restoreBackup(backups, stamp, server, { isRunning: () => false });
    expect(again.complete).toBe(true);
    expect(snapshot(server)).toEqual(before);
  });

  it('refuses while the game runs, and for an unknown or malformed stamp', async () => {
    const { stamp } = await setup();
    const code = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (err) {
        return (err as DeployError).code;
      }
      return 'no error';
    };
    expect(await code(restoreBackup(backups, stamp, server, { isRunning: () => true }))).toBe('game_running');
    expect(await code(restoreBackup(backups, '20200101-000000', server, { isRunning: () => false }))).toBe('backup_not_found');
    expect(await code(restoreBackup(backups, '../server', server, { isRunning: () => false }))).toBe('backup_not_found');
    expect(await code(restoreBackup(backups, stamp, path.join(tmp, 'pack'), { isRunning: () => false }))).toBe('target_not_recognised');
  });

  it('refuses a backup whose manifest names an unsafe path', async () => {
    const { stamp } = await setup();
    const file = path.join(backups, stamp, 'manifest.json');
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    m.removed = ['../escape.txt'];
    fs.writeFileSync(file, JSON.stringify(m));
    await expect(restoreBackup(backups, stamp, server, { isRunning: () => false })).rejects.toMatchObject({ code: 'backup_invalid' });
  });
});

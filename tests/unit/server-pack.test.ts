import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/server/db/open.js';
import { closePool } from '../../src/server/jobs/pool.js';
import { addToBlacklist, setDecision } from '../../src/server/mods/blacklist-service.js';
import { importModSet } from '../../src/server/mods/import-modset.js';
import { buildServerPack, ServerPackError } from '../../src/server/mods/server-pack.js';
import { createProfile } from '../../src/server/profiles/profile-service.js';
import { configureLimits, setLimits } from '../../src/server/settings/limits.js';
import { openZip } from '../../src/server/zip/zip-reader.js';
import { makeJar } from '../fixtures-gen/jar.js';

let db: Db;
let tmp: string;
beforeEach(() => {
  db = openDb(':memory:');
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'server-pack-'));
});
afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
afterAll(() => closePool());

const ctx = { params: null, signal: new AbortController().signal, progress: () => undefined };
const put = (root: string, rel: string, content: string | Buffer = 'x') => {
  const full = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
};
const listFiles = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(path.relative(dir, full).replace(/\\/g, '/'));
    }
  };
  walk(dir);
  return out.sort();
};

async function serverFolder(): Promise<string> {
  const dir = path.join(tmp, 'server');
  for (const id of ['alpha', 'beta', 'clientonly']) {
    put(path.join(dir, 'mods'), `${id}-1.0.jar`, '');
    fs.writeFileSync(path.join(dir, 'mods', `${id}-1.0.jar`), await makeJar({ fileName: `${id}-1.0.jar`, loader: 'neoforge', mods: [{ modId: id, version: '1.0' }] }));
  }
  put(dir, 'config/a.toml', 'a = 1');
  put(dir, 'config/old.bak', 'bak');
  put(dir, 'config/skipme/x.toml', 'x');
  put(dir, 'kubejs/server_scripts/s.js', 'js');
  put(dir, 'world/level.dat', 'WORLD');
  put(dir, 'logs/latest.log', 'LOG');
  put(dir, 'crash-reports/crash.txt', 'CRASH');
  put(dir, 'backups/b.zip', 'B');
  put(dir, 'eula.txt', 'eula=true');
  put(dir, 'ops.json', '[]');
  put(dir, 'whitelist.json', '[]');
  put(dir, 'banned-players.json', '[]');
  put(dir, 'usercache.json', '[]');
  put(dir, 'run.bat', '@echo off');
  put(dir, 'run.sh', '#!/bin/sh');
  put(dir, 'startserver.bat', '@echo off');
  put(dir, 'user_jvm_args.txt', '-Xmx4G');
  put(dir, 'server.properties', 'motd=hello\nrcon.password=hunter2\nserver-port=25565\n');
  put(dir, 'notes.txt', 'private notes');
  return dir;
}

async function setup() {
  const dir = await serverFolder();
  const profile = createProfile(db, { pack: 'Own', version: 'My pack 2026', side: 'server', state: 'launched', locationKind: 'folder', location: dir });
  await importModSet(db, { kind: 'folder', path: dir }, profile.id, ctx);
  addToBlacklist(db, 'clientonly', 'client side only');
  return { dir, profile, exportsDir: path.join(tmp, 'data', 'exports') };
}
const now = new Date(Date.UTC(2026, 9, 29, 13, 5, 9));

describe('buildServerPack', () => {
  it('copies the allow-list only and leaves out blacklisted mods, with a manifest', async () => {
    const { dir, profile, exportsDir } = await setup();
    const before = listFiles(dir);
    const res = await buildServerPack({ db, profile, exportsDir, now });
    expect(res.name).toMatch(/^server-pack-Own-My_pack_2026-20261029-130509$/);
    expect(listFiles(res.folder)).toEqual(
      [
        'SERVER-PACK.md',
        'config/a.toml',
        'kubejs/server_scripts/s.js',
        'mods/alpha-1.0.jar',
        'mods/beta-1.0.jar',
        'run.bat',
        'run.sh',
        'server.properties',
        'startserver.bat',
        'user_jvm_args.txt',
        'config/skipme/x.toml',
      ].sort(),
    );
    expect(res.mods).toBe(2);
    expect(res.leftOut.some((l) => l.key === 'clientonly' && /blacklist/i.test(l.reason))).toBe(true);
    const md = fs.readFileSync(path.join(res.folder, 'SERVER-PACK.md'), 'utf8');
    expect(md).toContain('clientonly');
    expect(md).toContain('eula.txt');
    expect(listFiles(dir)).toEqual(before); // the source is never written
    const zip = await openZip(res.zipPath);
    const names = zip.entries().map((e) => e.name);
    expect(names).toContain(`${res.name}/mods/alpha-1.0.jar`);
    expect(names.some((n) => n.includes('world') || n.includes('eula'))).toBe(false);
    await zip.close();
  });

  it('blanks the rcon password of server.properties in the copy', async () => {
    const { profile, exportsDir } = await setup();
    const res = await buildServerPack({ db, profile, exportsDir, now });
    const props = fs.readFileSync(path.join(res.folder, 'server.properties'), 'utf8');
    expect(props).not.toContain('hunter2');
    expect(props).toContain('rcon.password=');
    expect(props).toContain('motd=hello');
  });

  it('honours the ignored paths setting', async () => {
    const { profile, exportsDir } = await setup();
    const data = path.join(tmp, 'prefs');
    fs.mkdirSync(data);
    configureLimits(data);
    setLimits(data, { 'configs.ignoredPaths': ['config/skipme'] });
    try {
      const res = await buildServerPack({ db, profile, exportsDir, now });
      expect(fs.existsSync(path.join(res.folder, 'config', 'skipme'))).toBe(false);
      expect(fs.existsSync(path.join(res.folder, 'config', 'a.toml'))).toBe(true);
      expect(res.leftOut.some((l) => /ignored/i.test(l.reason))).toBe(true);
    } finally {
      setLimits(data, { 'configs.ignoredPaths': null });
    }
  });

  it('refuses a profile without imported mods', async () => {
    const dir = await serverFolder();
    const profile = createProfile(db, { pack: 'Own', version: '1', side: 'server', state: 'launched', locationKind: 'folder', location: dir });
    await expect(buildServerPack({ db, profile, exportsDir: path.join(tmp, 'e'), now })).rejects.toMatchObject({ code: 'not_imported' });
    await expect(buildServerPack({ db, profile, exportsDir: path.join(tmp, 'e'), now })).rejects.toBeInstanceOf(ServerPackError);
  });

  it('refuses a client profile and an exports folder inside the source', async () => {
    const { dir, profile } = await setup();
    const client = createProfile(db, { pack: 'Own', version: 'c', side: 'client', state: 'launched', locationKind: 'folder', location: dir });
    await expect(buildServerPack({ db, profile: client, exportsDir: path.join(tmp, 'e'), now })).rejects.toMatchObject({ code: 'not_a_server' });
    await expect(buildServerPack({ db, profile, exportsDir: path.join(dir, 'out'), now })).rejects.toMatchObject({ code: 'inside_source' });
  });

  it('leaves no partial file behind and never reuses a name', async () => {
    const { profile, exportsDir } = await setup();
    const a = await buildServerPack({ db, profile, exportsDir, now });
    const b = await buildServerPack({ db, profile, exportsDir, now });
    expect(b.name).toBe(`${a.name}-2`);
    expect(fs.readdirSync(exportsDir).filter((n) => n.endsWith('.partial'))).toEqual([]);
  });

  describe('sides', () => {
    const sideJar = (dir: string, id: string, dependencySide?: 'CLIENT' | 'SERVER' | 'BOTH') =>
      makeJar({ fileName: `${id}-1.0.jar`, loader: 'neoforge', mods: [{ modId: id, version: '1.0', dependencySide }] }).then((b) => put(path.join(dir, 'mods'), `${id}-1.0.jar`, b));
    async function sidesSetup() {
      const dir = path.join(tmp, 'server');
      await sideJar(dir, 'plain');
      await sideJar(dir, 'declaredclient', 'CLIENT');
      await sideJar(dir, 'declaredserver', 'SERVER');
      await sideJar(dir, 'mystery');
      const profile = createProfile(db, { pack: 'Own', version: 'My pack 2026', side: 'server', state: 'launched', locationKind: 'folder', location: dir });
      await importModSet(db, { kind: 'folder', path: dir }, profile.id, ctx);
      db.sqlite.prepare("UPDATE jar_mod SET declared_side = 'unknown' WHERE mod_id = 'mystery'").run();
      return { profile, exportsDir: path.join(tmp, 'data', 'exports') };
    }
    const inPack = (folder: string) => listFiles(path.join(folder, 'mods'));

    it('leaves a jar declared client out and keeps one declared server or both', async () => {
      const { profile, exportsDir } = await sidesSetup();
      const res = await buildServerPack({ db, profile, exportsDir, now, includeUnknown: false });
      expect(inPack(res.folder)).toEqual(['declaredserver-1.0.jar', 'plain-1.0.jar']);
      expect(res.leftOut).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'mod', key: 'declaredclient', reason: expect.stringMatching(/declared client/) })]));
    });

    it("lets the user's side decision beat the declared side", async () => {
      const { profile, exportsDir } = await sidesSetup();
      setDecision(db, { modId: 'declaredclient', kind: 'side', side: 'both', reason: 'needed on the server' });
      setDecision(db, { modId: 'declaredserver', kind: 'side', side: 'client', reason: 'client only' });
      const res = await buildServerPack({ db, profile, exportsDir, now, includeUnknown: false });
      expect(inPack(res.folder)).toEqual(['declaredclient-1.0.jar', 'plain-1.0.jar']);
    });

    it('refuses to build while a mod has an unknown side, and lists it', async () => {
      const { profile, exportsDir } = await sidesSetup();
      const err = await buildServerPack({ db, profile, exportsDir, now }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ServerPackError);
      expect(err).toMatchObject({ code: 'sides_undecided', undecided: [{ modId: 'mystery', file: 'mystery-1.0.jar' }] });
      expect(fs.existsSync(exportsDir)).toBe(false);
    });

    it('includes the unknown ones on includeUnknown true and leaves them out on false, listing them either way', async () => {
      const { profile, exportsDir } = await sidesSetup();
      const yes = await buildServerPack({ db, profile, exportsDir, now, includeUnknown: true });
      expect(inPack(yes.folder)).toContain('mystery-1.0.jar');
      expect(yes.undecided).toEqual([{ modId: 'mystery', file: 'mystery-1.0.jar' }]);
      expect(fs.readFileSync(path.join(yes.folder, 'SERVER-PACK.md'), 'utf8')).toMatch(/needs? a (side )?decision/i);
      const no = await buildServerPack({ db, profile, exportsDir, now, includeUnknown: false });
      expect(inPack(no.folder)).not.toContain('mystery-1.0.jar');
      expect(no.undecided).toHaveLength(1);
      expect(no.leftOut).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'mystery', reason: expect.stringMatching(/unknown/) })]));
    });

    it('builds without asking once the decision is made', async () => {
      const { profile, exportsDir } = await sidesSetup();
      setDecision(db, { modId: 'mystery', kind: 'side', side: 'server', reason: 'ok' });
      const res = await buildServerPack({ db, profile, exportsDir, now });
      expect(inPack(res.folder)).toContain('mystery-1.0.jar');
      expect(res.undecided).toEqual([]);
    });
  });
});

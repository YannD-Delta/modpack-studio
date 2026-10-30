import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/server/db/open.js';
import {
  DuplicateProfileError,
  ImmutableProfileError,
  LaunchArtifactsError,
  LocationError,
  ProcessRunningError,
  createProfile,
  deleteProfile,
  detectLaunchArtifacts,
  importStatus,
  relocateProfile,
  validateLocation,
  getProfile,
  listMatrix,
  updateProfile,
  type NewProfile,
} from '../../src/server/profiles/profile-service.js';

let db: Db;
let tmp: string;
beforeEach(() => {
  db = openDb(':memory:');
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prof-'));
});
afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const base: NewProfile = { pack: 'Base', version: '8.3', side: 'server', state: 'clean', locationKind: 'folder', location: '' };
const folder = (name: string, files: string[] = [], dirs: string[] = []) => {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const d of dirs) fs.mkdirSync(path.join(dir, d), { recursive: true });
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), 'x');
  }
  return dir;
};

describe('detectLaunchArtifacts', () => {
  it('finds a non-empty logs/ and world/, options.txt and .bak files', () => {
    const dir = folder('dirty', ['options.txt', 'config.toml.bak', 'logs/latest.log', 'world/level.dat']);
    expect(detectLaunchArtifacts(dir).sort()).toEqual(['config.toml.bak', 'logs', 'options.txt', 'world']);
  });
  it('ignores what the CurseForge app itself creates in a never-launched instance', () => {
    const dir = folder('cf-clean', ['logs/instance_audit.txt', 'manifest.json'], ['saves', 'shaderpacks', 'resourcepacks', 'mods', 'config']);
    expect(detectLaunchArtifacts(dir)).toEqual([]);
  });
  it('treats an empty logs/ or saves/ folder as clean', () => {
    expect(detectLaunchArtifacts(folder('empty-dirs', [], ['logs', 'saves', 'crash-reports']))).toEqual([]);
  });
  it('returns nothing for a clean folder', () => {
    expect(detectLaunchArtifacts(folder('clean', ['a.toml'], ['mods', 'config']))).toEqual([]);
  });
});

describe('createProfile', () => {
  it('refuses a clean profile over a folder with launch artifacts and lists them', () => {
    const dir = folder('dirty', ['options.txt', 'logs/latest.log']);
    try {
      createProfile(db, { ...base, location: dir });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(LaunchArtifactsError);
      expect((err as LaunchArtifactsError).artifacts.sort()).toEqual(['logs', 'options.txt']);
    }
  });

  it('creates an immutable clean profile over a clean folder', () => {
    const p = createProfile(db, { ...base, location: folder('clean', [], ['mods']) });
    expect(p.immutable).toBe(true);
    expect(p.id).toBeGreaterThan(0);
  });

  it('refuses to capture a run profile while the process runs', () => {
    const input: NewProfile = { ...base, state: 'run', location: folder('live', [], ['world']) };
    expect(() => createProfile(db, input, { isProcessRunning: () => true })).toThrow(ProcessRunningError);
    expect(createProfile(db, input, { isProcessRunning: () => false }).immutable).toBe(false);
  });

  it('rejects a second profile in the same matrix cell', () => {
    createProfile(db, { ...base, location: folder('a') });
    expect(() => createProfile(db, { ...base, location: folder('b') })).toThrow(DuplicateProfileError);
  });
});

describe('updateProfile', () => {
  it('cannot change an immutable profile but can change a run profile', () => {
    const launched = createProfile(db, { ...base, state: 'launched', location: folder('l', [], ['logs']) });
    expect(() => updateProfile(db, launched.id, { location: 'elsewhere' })).toThrow(ImmutableProfileError);
    const run = createProfile(db, { ...base, state: 'run', location: folder('r') });
    expect(updateProfile(db, run.id, { location: 'new place' }).location).toBe('new place');
  });
});

describe('listMatrix', () => {
  it('shows old versions with only their clean cells filled', () => {
    createProfile(db, { ...base, version: '8.2', side: 'server', state: 'clean', location: folder('o1') });
    createProfile(db, { ...base, version: '8.2', side: 'client', state: 'clean', location: folder('o2') });
    createProfile(db, { ...base, version: '8.3', side: 'server', state: 'clean', location: folder('n1') });
    createProfile(db, { ...base, version: '8.3', side: 'server', state: 'run', location: folder('n2') });
    const matrix = listMatrix(db);
    const old = matrix.find((r) => r.version === '8.2')!;
    expect(old.cells['server-clean']).not.toBeNull();
    expect(old.cells['client-clean']).not.toBeNull();
    expect(old.cells['server-launched']).toBeNull();
    expect(old.cells['server-run']).toBeNull();
    const latest = matrix.find((r) => r.version === '8.3')!;
    expect(latest.cells['server-run']).not.toBeNull();
    expect(latest.cells['client-clean']).toBeNull();
  });
});

describe('validateLocation', () => {
  it('rejects a relative path and a quoted "Copy as path" form with code location_not_absolute', () => {
    for (const bad of ['relative/dir', `"${tmp}"`]) {
      try { validateLocation('folder', bad); expect.unreachable(); } catch (e) {
        expect(e).toBeInstanceOf(LocationError);
        expect((e as LocationError).code).toBe('location_not_absolute');
      }
    }
  });
  it('rejects a missing path and a kind mismatch with a typed error instead of crashing', () => {
    expect(() => validateLocation('folder', path.join(tmp, 'missing'))).toThrow(LocationError);
    const file = path.join(tmp, 'a.zip');
    fs.writeFileSync(file, 'x');
    expect(() => validateLocation('folder', file)).toThrow(/folder/);
    expect(() => validateLocation('zip', folder('d'))).toThrow(/file/);
    expect(() => validateLocation('zip', file)).not.toThrow();
    expect(() => validateLocation('folder', folder('d2'))).not.toThrow();
  });
});

describe('importStatus', () => {
  it('counts mods and issues of a profile', () => {
    const p = createProfile(db, { ...base, location: folder('c') });
    expect(importStatus(db, p.id)).toEqual({ mods: 0, issues: 0, complete: false });
    db.sqlite.prepare("INSERT INTO import_issue (profile_id, file, reason) VALUES (?, 'x.jar', 'bad')").run(p.id);
    expect(importStatus(db, p.id).issues).toBe(1);
  });
});

describe('relocateProfile', () => {
  it('moves an immutable profile to another valid location, keeping its imported data', () => {
    const p = createProfile(db, { ...base, state: 'launched', location: folder('l', [], ['logs']) });
    const to = folder('moved', [], ['mods']);
    expect(relocateProfile(db, p.id, to).location).toBe(to);
  });
  it('validates the new location and re-checks launch artifacts of a clean folder', () => {
    const p = createProfile(db, { ...base, location: folder('c') });
    expect(() => relocateProfile(db, p.id, path.join(tmp, 'nope'))).toThrow(LocationError);
    expect(() => relocateProfile(db, p.id, folder('dirty', ['options.txt']))).toThrow(LaunchArtifactsError);
  });
});

describe('deleteProfile', () => {
  it('removes the profile and only the rows that belong to it, in one transaction', () => {
    const a = createProfile(db, { ...base, location: folder('a') });
    const b = createProfile(db, { ...base, version: '9', location: folder('b') });
    db.sqlite.prepare("INSERT INTO jar (sha256, filename, size) VALUES ('h', 'a.jar', 1)").run();
    for (const id of [a.id, b.id]) {
      db.sqlite.prepare("INSERT INTO jar_mod (jar_sha256, profile_id, mod_id, version) VALUES ('h', ?, 'm', '1')").run(id);
      db.sqlite.prepare("INSERT INTO import_issue (profile_id, file, reason) VALUES (?, 'x.jar', 'bad')").run(id);
    }
    db.sqlite.prepare("INSERT INTO update_plan_item (base_profile_id, other_profile_id, kind, key, action, created_at) VALUES (?, ?, 'mod', 'm', 'take_ref', 'now')").run(a.id, b.id);
    deleteProfile(db, a.id);
    const n = (t: string, id: number, col = 'profile_id') => (db.sqlite.prepare(`SELECT count(*) AS n FROM ${t} WHERE ${col} = ?`).get(id) as { n: number }).n;
    expect(n('jar_mod', a.id)).toBe(0);
    expect(n('import_issue', a.id)).toBe(0);
    expect((db.sqlite.prepare('SELECT count(*) AS n FROM update_plan_item').get() as { n: number }).n).toBe(0);
    expect(n('jar_mod', b.id)).toBe(1);
    expect(n('import_issue', b.id)).toBe(1);
    expect(() => getProfile(db, a.id)).toThrow();
    expect(listMatrix(db).map((r) => r.version)).toEqual(['9']);
  });
});

describe('listMatrix import info', () => {
  it('reports importedAt and importIssueCount per profile', () => {
    const p = createProfile(db, { ...base, location: folder('c') });
    let cell = listMatrix(db)[0]!.cells['server-clean']!;
    expect(cell.importedAt).toBeNull();
    expect(cell.importIssueCount).toBe(0);
    db.sqlite.prepare("INSERT INTO jar (sha256, filename, size) VALUES ('h', 'a.jar', 1)").run();
    db.sqlite.prepare("INSERT INTO jar_mod (jar_sha256, profile_id, mod_id, version) VALUES ('h', ?, 'm', '1')").run(p.id);
    db.sqlite.prepare("INSERT INTO import_issue (profile_id, file, reason) VALUES (?, 'x.jar', 'bad')").run(p.id);
    cell = listMatrix(db)[0]!.cells['server-clean']!;
    expect(typeof cell.importedAt).toBe('string');
    expect(cell.importIssueCount).toBe(1);
  });
});

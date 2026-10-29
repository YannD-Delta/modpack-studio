import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/server/db/open.js';
import { closePool } from '../../src/server/jobs/pool.js';
import { importModSet } from '../../src/server/mods/import-modset.js';
import { createProfile } from '../../src/server/profiles/profile-service.js';
import { makeJar, makeZip, type JarSpec } from '../fixtures-gen/jar.js';
import { writeAtmPack } from '../fixtures-gen/packs.js';

let db: Db;
let tmp: string;
beforeEach(() => {
  db = openDb(':memory:');
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'import-'));
});
afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
afterAll(() => closePool());

const ctx = { params: null, signal: new AbortController().signal, progress: () => undefined };
const spec = (id: string, version = '1.0'): JarSpec => ({ fileName: `${id}-${version}.jar`, loader: 'neoforge', mods: [{ modId: id, version }] });
const five = ['a', 'b', 'c', 'd', 'e'].map((id) => spec(id));
const profile = (state: 'clean' | 'launched' = 'clean') => createProfile(db, { pack: 'Base', version: '8.3', side: 'server', state, locationKind: 'zip', location: 'x' });
const modRows = (profileId: number) => (db.sqlite.prepare('SELECT count(*) AS n FROM jar_mod WHERE profile_id = ?').get(profileId) as { n: number }).n;

describe('importModSet', () => {
  it('imports the mods of a server pack zip', async () => {
    const { serverZip } = await writeAtmPack(tmp, { atm: '8.3', neoforge: '21.1.259', mc: '1.21.1', serverMods: five, clientMods: [] });
    const p = profile();
    const r = await importModSet(db, { kind: 'zip', path: serverZip }, p.id, ctx);
    expect(r.imported).toBe(5);
    expect(modRows(p.id)).toBe(5);
  });

  it('finds mods/ inside a wrapper folder too', async () => {
    const { serverZip } = await writeAtmPack(tmp, { atm: '8.3', neoforge: '21.1.259', mc: '1.21.1', serverMods: five, clientMods: [], wrapperDir: 'Base-Server-8.3' });
    expect((await importModSet(db, { kind: 'zip', path: serverZip }, profile().id, ctx)).imported).toBe(5);
  });

  it('imports a folder whose path has spaces and accents', async () => {
    const dir = path.join(tmp, 'pack é spécial');
    const { clientDir } = await writeAtmPack(dir, { atm: '8.3', neoforge: '21.1.259', mc: '1.21.1', serverMods: [], clientMods: five });
    expect((await importModSet(db, { kind: 'folder', path: clientDir }, profile().id, ctx)).imported).toBe(5);
  });

  it('skips a corrupt jar and imports the rest', async () => {
    const { clientDir } = await writeAtmPack(tmp, { atm: '8.3', neoforge: '21.1.259', mc: '1.21.1', serverMods: [], clientMods: five });
    fs.writeFileSync(path.join(clientDir, 'mods', 'broken.jar'), 'not a zip');
    const r = await importModSet(db, { kind: 'folder', path: clientDir }, profile().id, ctx);
    expect(r.imported).toBe(5);
    expect(r.skipped.map((s) => s.file)).toEqual(['broken.jar']);
  });

  it('reports two jars that declare the same top-level mod id', async () => {
    const { clientDir } = await writeAtmPack(tmp, { atm: '8.3', neoforge: '21.1.259', mc: '1.21.1', serverMods: [], clientMods: [spec('dup', '1.0'), spec('dup', '2.0'), spec('solo')] });
    const r = await importModSet(db, { kind: 'folder', path: clientDir }, profile().id, ctx);
    expect(r.duplicateIds).toEqual([{ modId: 'dup', files: ['dup-1.0.jar', 'dup-2.0.jar'] }]);
  });

  it('does not count jar-in-jar entries as top-level mods or duplicates', async () => {
    const inner = spec('shared');
    const { clientDir } = await writeAtmPack(tmp, {
      atm: '8.3', neoforge: '21.1.259', mc: '1.21.1', serverMods: [],
      clientMods: [{ ...spec('outer1'), nested: [inner] }, { ...spec('outer2'), nested: [inner] }],
    });
    const p = profile();
    const r = await importModSet(db, { kind: 'folder', path: clientDir }, p.id, ctx);
    expect(r.duplicateIds).toEqual([]);
    const jij = (db.sqlite.prepare('SELECT count(*) AS n FROM jar_mod WHERE profile_id = ? AND is_jij = 1').get(p.id) as { n: number }).n;
    expect(jij).toBe(2);
  });

  it('writes no duplicate rows when the same set is imported again', async () => {
    const { clientDir } = await writeAtmPack(tmp, { atm: '8.3', neoforge: '21.1.259', mc: '1.21.1', serverMods: [], clientMods: five });
    const p = profile();
    await importModSet(db, { kind: 'folder', path: clientDir }, p.id, ctx);
    await importModSet(db, { kind: 'folder', path: clientDir }, p.id, ctx);
    expect(modRows(p.id)).toBe(5);
  });

  it('reports an empty or missing mods folder without throwing', async () => {
    const empty = path.join(tmp, 'empty');
    fs.mkdirSync(empty);
    const r1 = await importModSet(db, { kind: 'folder', path: empty }, profile('clean').id, ctx);
    expect(r1.imported).toBe(0);
    expect(r1.skipped.length).toBeGreaterThan(0);
    const r2 = await importModSet(db, { kind: 'folder', path: path.join(tmp, 'missing') }, profile('launched').id, ctx);
    expect(r2.imported).toBe(0);
  });

  it('imports a jar whose entries differ only by case (obfuscated class files)', async () => {
    const { clientDir } = await writeAtmPack(tmp, { atm: '8.3', neoforge: '21.1.259', mc: '1.21.1', serverMods: [], clientMods: [] });
    const toml = '[[mods]]\nmodId = "obf"\nversion = "1.0"\n';
    fs.writeFileSync(path.join(clientDir, 'mods', 'obf-1.0.jar'), await makeZip({ 'META-INF/neoforge.mods.toml': toml, 'a.class': 'x', 'A.class': 'y' }));
    const r = await importModSet(db, { kind: 'folder', path: clientDir }, profile().id, ctx);
    expect(r.imported).toBe(1);
    expect(r.skipped).toEqual([]);
  });

  it('keeps the previous import when the folder turns out to be missing or empty (nothing scanned, nothing deleted)', async () => {
    const { clientDir } = await writeAtmPack(tmp, { atm: '8.3', neoforge: '21.1.259', mc: '1.21.1', serverMods: [], clientMods: five });
    const p = profile();
    await importModSet(db, { kind: 'folder', path: clientDir }, p.id, ctx);
    await importModSet(db, { kind: 'folder', path: path.join(tmp, 'does-not-exist') }, p.id, ctx);
    expect(modRows(p.id)).toBe(5);
  });

  it('records skipped jars in import_issue so they can block a build', async () => {
    const { clientDir } = await writeAtmPack(tmp, { atm: '8.3', neoforge: '21.1.259', mc: '1.21.1', serverMods: [], clientMods: five });
    fs.writeFileSync(path.join(clientDir, 'mods', 'broken.jar'), 'not a zip');
    const p = profile();
    await importModSet(db, { kind: 'folder', path: clientDir }, p.id, ctx);
    const rows = db.sqlite.prepare('SELECT file FROM import_issue WHERE profile_id = ?').all(p.id) as { file: string }[];
    expect(rows.map((r) => r.file)).toEqual(['broken.jar']);
  });

  it('records the library jar without a mod id as a library row', async () => {
    const { clientDir } = await writeAtmPack(tmp, { atm: '8.3', neoforge: '21.1.259', mc: '1.21.1', serverMods: [], clientMods: [] });
    fs.writeFileSync(path.join(clientDir, 'mods', 'guava-33.jar'), await makeJar({ fileName: 'guava-33.jar', loader: 'neoforge', mods: [], library: true }));
    const p = profile();
    await importModSet(db, { kind: 'folder', path: clientDir }, p.id, ctx);
    const row = db.sqlite.prepare('SELECT library_key FROM jar_mod WHERE profile_id = ?').get(p.id) as { library_key: string };
    expect(row.library_key).toMatch(/^guava:/);
  });
});

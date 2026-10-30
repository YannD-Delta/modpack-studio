import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/server/db/open.js';
import { closePool } from '../../src/server/jobs/pool.js';
import { buildUpdatePack, exportSafeName, removeStaleExportLeftovers, type ChangesJson } from '../../src/server/mods/update-pack.js';
import { importModSet } from '../../src/server/mods/import-modset.js';
import { isSafePlanFileKey } from '../../src/server/plan/plan-keys.js';
import { setPlanItems } from '../../src/server/plan/plan-store.js';
import { openZip } from '../../src/server/zip/zip-reader.js';
import { createProfile, type Profile } from '../../src/server/profiles/profile-service.js';
import { makeJar, type JarSpec } from '../fixtures-gen/jar.js';
import { writeAtmPack } from '../fixtures-gen/packs.js';

let db: Db;
let tmp: string;
beforeEach(() => {
  db = openDb(':memory:');
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'update-pack-'));
});
afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
afterAll(() => closePool());

const ctx = { params: null, signal: new AbortController().signal, progress: () => undefined };
const jar = (id: string, version = '1.0', extra: Partial<JarSpec> = {}): JarSpec => ({ fileName: `${id}-${version}.jar`, loader: 'neoforge', mods: [{ modId: id, version }], ...extra });
const sha = (p: string) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function listFiles(dir: string): string[] {
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
}

/** Base client (reference) against an Own client: a older, b missing, c different, d rebuilt, mine added. */
async function scenario() {
  const atm = await writeAtmPack(path.join(tmp, 'atm'), {
    atm: '8.3', neoforge: '21.1.259', mc: '1.21.1', serverMods: [jar('a', '1.1'), jar('b')],
    clientMods: [jar('a', '1.1'), jar('b'), jar('c', '1.0-foo'), jar('d')],
    wrapperDir: 'Base-Server-8.3',
  });
  fs.mkdirSync(path.join(atm.clientDir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(atm.clientDir, 'config', 'x.toml'), 'ref = true\n');
  const lmp = await writeAtmPack(path.join(tmp, 'lmp'), {
    atm: '1.0', neoforge: '21.1.259', mc: '1.21.1', serverMods: [],
    clientMods: [jar('a', '1.0'), jar('c', '1.0-bar'), jar('d', '1.0', { manifestVersion: 'rebuilt' }), jar('mine')],
  });
  const base = createProfile(db, { pack: 'Base', version: '8.3', side: 'client', state: 'clean', locationKind: 'folder', location: atm.clientDir });
  const other = createProfile(db, { pack: 'Own', version: '1.0', side: 'client', state: 'clean', locationKind: 'folder', location: lmp.clientDir });
  await importModSet(db, { kind: 'folder', path: atm.clientDir }, base.id, ctx);
  await importModSet(db, { kind: 'folder', path: lmp.clientDir }, other.id, ctx);
  return { atm, lmp, base, other, exportsDir: path.join(tmp, 'data', 'exports') };
}

const build = (base: Profile, other: Profile, exportsDir: string) => buildUpdatePack({ db, base, other, exportsDir, now: new Date(Date.UTC(2026, 9, 29, 13, 5, 9)) });

describe('isSafePlanFileKey', () => {
  it.each(['config/x.toml', 'kubejs/server_scripts/a.js', 'defaultconfigs/mod-common.toml', 'options.txt'])('accepts %s', (k) => {
    expect(isSafePlanFileKey(k)).toBe(true);
  });
  it.each(['', '../x', 'config/../../x', '/etc/passwd', 'C:/x', 'c:x', 'config\\x.toml', 'config/./x', 'config//x', 'x/', 'con', 'config/aux.txt', 'config/x.', 'config/x ', 'a:b', 'x\0y', 'a'.repeat(600)])('rejects %j', (k) => {
    expect(isSafePlanFileKey(k)).toBe(false);
  });
});

describe('exportSafeName', () => {
  it('builds a sortable, sanitised folder name', () => {
    const name = exportSafeName({ pack: 'Own', version: '1.0 beta/2' }, { pack: 'Base', version: '8.3' }, new Date(Date.UTC(2026, 9, 29, 13, 5, 9)));
    expect(name).toBe('update-Own-1.0_beta_2-from-Base-8.3-20261029-130509');
    expect(name).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});

describe('buildUpdatePack', () => {
  it('copies the reference jars, lists the old jars to move out, and zips next to the folder', async () => {
    const { base, other, exportsDir, atm } = await scenario();
    setPlanItems(db, base.id, other.id, 'mod', ['a', 'b', 'c', 'd'], true);
    setPlanItems(db, base.id, other.id, 'file', ['config/x.toml'], true);

    const r = await build(base, other, exportsDir);
    expect(r.name).toBe('update-Own-1.0-from-Base-8.3-20261029-130509');
    expect(r.folder).toBe(path.join(exportsDir, r.name));
    expect(r.failures).toEqual([]);
    expect(r.counts).toMatchObject({ modsUpdated: 3, modsRestored: 1, jarsToRemove: 3, files: 1, failures: 0 });

    expect(listFiles(r.folder)).toEqual([
      'CHANGES.md', 'apply.ps1', 'changes.json', 'files-add/config/x.toml',
      'mods-add/a-1.1.jar', 'mods-add/b-1.0.jar', 'mods-add/c-1.0-foo.jar', 'mods-add/d-1.0.jar',
      'remove.txt', 'result.json',
    ]);
    expect(sha(path.join(r.folder, 'mods-add', 'a-1.1.jar'))).toBe(sha(path.join(atm.clientDir, 'mods', 'a-1.1.jar')));
    expect(fs.readFileSync(path.join(r.folder, 'remove.txt'), 'utf8').trim().split(/\r?\n/)).toEqual(['a-1.0.jar', 'c-1.0-bar.jar', 'd-1.0.jar']);

    const changes = JSON.parse(fs.readFileSync(path.join(r.folder, 'changes.json'), 'utf8')) as ChangesJson;
    expect(changes.jars.map((j) => j.file)).toEqual(['a-1.1.jar', 'b-1.0.jar', 'c-1.0-foo.jar', 'd-1.0.jar']);
    expect(changes.files).toEqual([{ path: 'config/x.toml', sha256: sha(path.join(atm.clientDir, 'config', 'x.toml')), size: 11 }]);
    expect(changes.mods.find((m) => m.modId === 'a')).toMatchObject({ action: 'update', file: 'a-1.1.jar', toVersion: '1.1', fromVersion: '1.0', replaces: 'a-1.0.jar' });
    expect(changes.mods.find((m) => m.modId === 'b')).toMatchObject({ action: 'restore', replaces: null });
    expect(changes.base.label).toMatch(/Base 8\.3/);
    expect(fs.readFileSync(path.join(r.folder, 'CHANGES.md'), 'utf8')).toMatch(/\| a \| 1\.0 \| 1\.1 \|/);
    expect(fs.readFileSync(path.join(r.folder, 'CHANGES.md'), 'utf8')).toContain('without a trailing backslash (`...\\MyInstance`, not `...\\MyInstance\\`)');

    // the zip lives next to the folder, never inside it, and holds every file under the export name
    expect(r.zipPath).toBe(path.join(exportsDir, `${r.name}.zip`));
    expect(fs.existsSync(r.zipPath)).toBe(true);
    expect(path.relative(r.folder, r.zipPath).startsWith('..')).toBe(true);
    const zip = await openZip(r.zipPath);
    const names = zip.entries().map((e) => e.name).sort();
    await zip.close();
    expect(names).toContain(`${r.name}/mods-add/a-1.1.jar`);
    expect(names).toContain(`${r.name}/apply.ps1`);
    expect(r.zipBytes).toBe(fs.statSync(r.zipPath).size);

    const result = JSON.parse(fs.readFileSync(path.join(r.folder, 'result.json'), 'utf8'));
    expect(result).toMatchObject({ name: r.name, counts: r.counts, zipBytes: r.zipBytes });
    // the reference instance itself is never written to
    expect(listFiles(atm.clientDir).filter((f) => !f.startsWith('mods/') && f !== 'minecraftinstance.json')).toEqual(['config/x.toml']);
  });

  it('records a sha256 mismatch or a missing jar as a failure and keeps going', async () => {
    const { base, other, exportsDir, atm } = await scenario();
    fs.writeFileSync(path.join(atm.clientDir, 'mods', 'a-1.1.jar'), await makeJar(jar('a', '1.1', { manifestVersion: 'tampered' })));
    fs.rmSync(path.join(atm.clientDir, 'mods', 'b-1.0.jar'));
    setPlanItems(db, base.id, other.id, 'mod', ['a', 'b', 'c'], true);

    const r = await build(base, other, exportsDir);
    expect(r.failures.map((f) => f.key)).toEqual(['a', 'b']);
    expect(r.failures[0]!.reason).toMatch(/sha256/);
    expect(r.failures[1]!.reason).toMatch(/not found/);
    expect(fs.existsSync(path.join(r.folder, 'mods-add', 'a-1.1.jar'))).toBe(false);
    expect(fs.existsSync(path.join(r.folder, 'mods-add', 'c-1.0-foo.jar'))).toBe(true);
    // a failed update must not move the old jar out either
    expect(fs.readFileSync(path.join(r.folder, 'remove.txt'), 'utf8').trim()).toBe('c-1.0-bar.jar');
    expect(r.counts).toMatchObject({ modsUpdated: 1, modsRestored: 0, failures: 2 });
  });

  it('refuses unsafe or missing file keys without ever leaving the output folder', async () => {
    const { base, other, exportsDir } = await scenario();
    fs.writeFileSync(path.join(tmp, 'secret.txt'), 'outside');
    setPlanItems(db, base.id, other.id, 'file', ['config/x.toml', '../secret.txt', '../../secret.txt', 'C:/Windows/win.ini', 'config\\..\\..\\secret.txt', 'config/missing.toml'], true);

    const r = await build(base, other, exportsDir);
    expect(r.counts.files).toBe(1);
    expect(r.failures.map((f) => f.key).sort()).toEqual(['../../secret.txt', '../secret.txt', 'C:/Windows/win.ini', 'config/missing.toml', 'config\\..\\..\\secret.txt'].sort());
    expect(r.failures.find((f) => f.key === 'config/missing.toml')!.reason).toMatch(/not found/);
    expect(listFiles(r.folder).filter((f) => f.startsWith('files-add/'))).toEqual(['files-add/config/x.toml']);
    expect(listFiles(path.join(tmp, 'data'))).not.toContain('secret.txt');
  });

  it('reads jars and files from a server-pack zip with a wrapper folder', async () => {
    const { atm, other, exportsDir } = await scenario();
    const server = createProfile(db, { pack: 'Base', version: '8.3', side: 'server', state: 'clean', locationKind: 'zip', location: atm.serverZip });
    await importModSet(db, { kind: 'zip', path: atm.serverZip }, server.id, ctx);
    setPlanItems(db, server.id, other.id, 'mod', ['a', 'b'], true);
    setPlanItems(db, server.id, other.id, 'file', ['config/atm.toml'], true);

    const r = await build(server, other, exportsDir);
    expect(r.failures).toEqual([]);
    expect(listFiles(r.folder)).toEqual(expect.arrayContaining(['mods-add/a-1.1.jar', 'mods-add/b-1.0.jar', 'files-add/config/atm.toml']));
    expect(fs.readFileSync(path.join(r.folder, 'files-add', 'config', 'atm.toml'), 'utf8')).toBe('welcome = true\n');
  });

  it('skips a planned mod that is no longer actionable', async () => {
    const { base, other, exportsDir } = await scenario();
    setPlanItems(db, base.id, other.id, 'mod', ['a', 'mine'], true);
    const r = await build(base, other, exportsDir);
    expect(r.failures).toEqual([{ kind: 'mod', key: 'mine', reason: expect.stringMatching(/not an update/) }]);
  });

  it('fails when nothing could be exported and leaves no half-written export behind', async () => {
    const { base, other, exportsDir, atm } = await scenario();
    fs.rmSync(path.join(atm.clientDir, 'mods', 'b-1.0.jar'));
    setPlanItems(db, base.id, other.id, 'mod', ['b'], true);
    await expect(build(base, other, exportsDir)).rejects.toThrow(/nothing could be exported/);
    expect(fs.existsSync(exportsDir) ? fs.readdirSync(exportsDir) : []).toEqual([]);
  });

  it('refuses to write the export inside a profile folder', async () => {
    const { base, other } = await scenario();
    setPlanItems(db, base.id, other.id, 'mod', ['a'], true);
    await expect(build(base, other, path.join(other.location, 'exports'))).rejects.toThrow(/inside/);
  });
});

describe('buildUpdatePack: real file names, duplicates, leftovers', () => {
  const removeTxt = (folder: string) => fs.readFileSync(path.join(folder, 'remove.txt'), 'utf8').trim().split(/\r?\n/);

  it('names the file the target really has when identical bytes sit under another name', async () => {
    const { base, other, exportsDir, lmp } = await scenario();
    fs.renameSync(path.join(lmp.clientDir, 'mods', 'a-1.0.jar'), path.join(lmp.clientDir, 'mods', 'a-1.0 (1).jar'));
    setPlanItems(db, base.id, other.id, 'mod', ['a'], true);
    const r = await build(base, other, exportsDir);
    expect(removeTxt(r.folder)).toEqual(['a-1.0 (1).jar']);
    expect(r.warnings.join('\n')).toMatch(/named a-1\.0 \(1\)\.jar in the target/);
  });

  it('warns when the target does not have the jar at all', async () => {
    const { base, other, exportsDir, lmp } = await scenario();
    fs.rmSync(path.join(lmp.clientDir, 'mods', 'a-1.0.jar'));
    setPlanItems(db, base.id, other.id, 'mod', ['a'], true);
    const r = await build(base, other, exportsDir);
    expect(r.warnings.join('\n')).toMatch(/a-1\.0\.jar was not found in the target/);
  });

  it('lists both jars when the target has two for one mod id, and warns', async () => {
    const atm = await writeAtmPack(path.join(tmp, 'atm'), { atm: '8.3', neoforge: '21.1.259', mc: '1.21.1', serverMods: [], clientMods: [jar('a', '2.0')] });
    const own = await writeAtmPack(path.join(tmp, 'own'), { atm: '1.0', neoforge: '21.1.259', mc: '1.21.1', serverMods: [], clientMods: [jar('a', '1.0'), jar('a', '0.9')] });
    const base = createProfile(db, { pack: 'Base', version: '8.3', side: 'client', state: 'clean', locationKind: 'folder', location: atm.clientDir });
    const other = createProfile(db, { pack: 'Own', version: '1.0', side: 'client', state: 'clean', locationKind: 'folder', location: own.clientDir });
    await importModSet(db, { kind: 'folder', path: atm.clientDir }, base.id, ctx);
    await importModSet(db, { kind: 'folder', path: own.clientDir }, other.id, ctx);
    setPlanItems(db, base.id, other.id, 'mod', ['a'], true);
    const r = await build(base, other, path.join(tmp, 'data', 'exports'));
    expect(removeTxt(r.folder).sort()).toEqual(['a-0.9.jar', 'a-1.0.jar']);
    expect(r.warnings.join('\n')).toMatch(/a has several jars in the target/);
    expect(fs.readFileSync(path.join(r.folder, 'CHANGES.md'), 'utf8')).toMatch(/several jars/);
  });

  it('removeStaleExportLeftovers deletes only .partial leftovers', () => {
    const dir = path.join(tmp, 'exports');
    fs.mkdirSync(path.join(dir, 'update-x-1.partial'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'update-x-1.partial', 'big.jar'), 'x');
    fs.writeFileSync(path.join(dir, 'update-x-1.zip.partial'), 'x');
    fs.mkdirSync(path.join(dir, 'update-x-2'));
    fs.writeFileSync(path.join(dir, 'update-x-2.zip'), 'x');
    expect(removeStaleExportLeftovers(dir).sort()).toEqual(['update-x-1.partial', 'update-x-1.zip.partial']);
    expect(fs.readdirSync(dir).sort()).toEqual(['update-x-2', 'update-x-2.zip']);
    expect(removeStaleExportLeftovers(path.join(tmp, 'nope'))).toEqual([]);
  });
});

// ---------- apply.ps1 (only when PowerShell is installed) ----------

function findShell(name: string): string | null {
  const r = spawnSync(name, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8', timeout: 60000 });
  return r.status === 0 ? name : null;
}
const pwsh = findShell('pwsh');
const winps = process.platform === 'win32' ? findShell('powershell') : null;

function runApply(shell: string, script: string, args: string[]) {
  return spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], { encoding: 'utf8', timeout: 120000 });
}

describe.skipIf(!pwsh)('apply.ps1', () => {
  it.each([pwsh, winps].filter((s): s is string => !!s))('parses under %s', async (shell) => {
    const { base, other, exportsDir } = await scenario();
    setPlanItems(db, base.id, other.id, 'mod', ['a'], true);
    const r = await build(base, other, exportsDir);
    const script = path.join(r.folder, 'apply.ps1');
    expect(fs.readFileSync(script).every((b) => b < 0x80)).toBe(true); // ASCII only: Windows PowerShell 5.1 reads BOM-less scripts as ANSI
    execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', `[scriptblock]::Create((Get-Content -Raw -LiteralPath '${script.replace(/'/g, "''")}')) | Out-Null`], { timeout: 60000 });
  });

  it.each([pwsh, winps].filter((s): s is string => !!s))('under %s, dry-runs without touching anything, then applies with a backup and deletes nothing', async (shell) => {
    const { base, other, exportsDir, lmp } = await scenario();
    setPlanItems(db, base.id, other.id, 'mod', ['a', 'b', 'd'], true);
    setPlanItems(db, base.id, other.id, 'file', ['config/x.toml'], true);
    const r = await build(base, other, exportsDir);

    // a disposable copy of the Own instance, with a config file that will be overwritten
    const inst = path.join(tmp, 'instance');
    fs.cpSync(lmp.clientDir, inst, { recursive: true });
    fs.mkdirSync(path.join(inst, 'config'));
    fs.writeFileSync(path.join(inst, 'config', 'x.toml'), 'mine = true\n');
    const before = listFiles(inst);
    const oldA = sha(path.join(inst, 'mods', 'a-1.0.jar'));
    const oldD = sha(path.join(inst, 'mods', 'd-1.0.jar'));

    const dry = runApply(shell, path.join(r.folder, 'apply.ps1'), ['-InstanceDir', inst]);
    expect(dry.status, dry.stderr + dry.stdout).toBe(0);
    expect(dry.stdout).toMatch(/dry run/i);
    expect(listFiles(inst)).toEqual(before);

    const run = runApply(shell, path.join(r.folder, 'apply.ps1'), ['-InstanceDir', inst, '-Apply']);
    expect(run.status, run.stderr + run.stdout).toBe(0);
    const after = listFiles(inst);
    const backup = after.find((f) => f.startsWith('_studio-backup-'))!.split('/')[0]!;
    expect(backup).toMatch(/^_studio-backup-\d{8}-\d{6}$/);
    expect(after.filter((f) => f.startsWith(backup)).sort()).toEqual([`${backup}/config/x.toml`, `${backup}/mods/a-1.0.jar`, `${backup}/mods/d-1.0.jar`]);
    expect(sha(path.join(inst, backup, 'mods', 'a-1.0.jar'))).toBe(oldA);
    expect(sha(path.join(inst, backup, 'mods', 'd-1.0.jar'))).toBe(oldD);
    expect(fs.readFileSync(path.join(inst, backup, 'config', 'x.toml'), 'utf8')).toBe('mine = true\n');
    expect(fs.readFileSync(path.join(inst, 'config', 'x.toml'), 'utf8')).toBe('ref = true\n');
    expect(after).toEqual(expect.arrayContaining(['mods/a-1.1.jar', 'mods/b-1.0.jar', 'mods/d-1.0.jar', 'mods/c-1.0-bar.jar', 'mods/mine-1.0.jar']));
    expect(after).not.toContain('mods/a-1.0.jar');
    expect(sha(path.join(inst, 'mods', 'd-1.0.jar'))).toBe(sha(path.join(r.folder, 'mods-add', 'd-1.0.jar')));
    // nothing was deleted: every file present before is still somewhere in the instance
    for (const f of before) expect(after.includes(f) || after.includes(`${backup}/${f}`)).toBe(true);
  }, 120000);

  it('refuses to run when a pack file does not match changes.json, and changes nothing', async () => {
    const { base, other, exportsDir, lmp } = await scenario();
    setPlanItems(db, base.id, other.id, 'mod', ['a'], true);
    const r = await build(base, other, exportsDir);
    fs.appendFileSync(path.join(r.folder, 'mods-add', 'a-1.1.jar'), 'x');
    const inst = path.join(tmp, 'instance');
    fs.cpSync(lmp.clientDir, inst, { recursive: true });
    const before = listFiles(inst);
    const run = runApply(pwsh!, path.join(r.folder, 'apply.ps1'), ['-InstanceDir', inst, '-Apply']);
    expect(run.status).not.toBe(0);
    expect(run.stdout + run.stderr).toMatch(/sha256/i);
    expect(listFiles(inst)).toEqual(before);
  }, 120000);

  it('refuses a folder that is not an instance', async () => {
    const { base, other, exportsDir } = await scenario();
    setPlanItems(db, base.id, other.id, 'mod', ['a'], true);
    const r = await build(base, other, exportsDir);
    const empty = path.join(tmp, 'not-an-instance');
    fs.mkdirSync(empty);
    const run = runApply(pwsh!, path.join(r.folder, 'apply.ps1'), ['-InstanceDir', empty, '-Apply']);
    expect(run.status).not.toBe(0);
    expect(run.stdout + run.stderr).toMatch(/mods/);
    expect(fs.readdirSync(empty)).toEqual([]);
  }, 120000);
});

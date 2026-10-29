import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/server/api/auth.js';
import { buildApp } from '../../src/server/api/app.js';
import type { Config } from '../../src/server/config.js';
import { openDb, type Db } from '../../src/server/db/open.js';
import { JobRunner } from '../../src/server/jobs/runner.js';
import { buildZip } from '../fixtures-gen/zip.js';

let db: Db;
let app: FastifyInstance;
let tmp: string;
let cookie: string;

beforeEach(async () => {
  db = openDb(':memory:');
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'configs-api-'));
  const config: Config = { bindHost: '127.0.0.1', port: 0, passwordHash: hashPassword('pw'), allowedHosts: [] };
  app = buildApp({ db, jobs: new JobRunner(db), config, dataDir: path.join(tmp, 'data') });
  await app.ready();
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { password: 'pw' } });
  cookie = String(res.headers['set-cookie']).split(';')[0]!;
});
afterEach(async () => {
  await app.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, payload: payload as object, headers: { cookie } });

function tree(root: string, files: Record<string, string | Buffer>) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

async function waitJob(jobId: string): Promise<{ status: string; message: string | null }> {
  for (let i = 0; i < 200; i++) {
    const res = await call('GET', `/configs/scan/${jobId}`);
    const row = res.json() as { status: string; message: string | null };
    if (!['queued', 'running'].includes(row.status)) return row;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('scan job timed out');
}

async function scan(profile: number, force = false, deep = false) {
  const res = await call('POST', '/configs/scan', { profile, force, deep });
  expect(res.statusCode).toBe(202);
  return waitJob((res.json() as { jobId: string }).jobId);
}

const mk = async (body: object) => {
  const res = await call('POST', '/profiles', body);
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { id: number }).id;
};

async function scenario() {
  const atmDir = tree(path.join(tmp, 'atm'), {
    'config/same.toml': 'a = 1\n',
    'config/changed.toml': '[general]\nspeed = 1\nname = "x"\n',
    'config/format.json': '{"b":2,"a":1}',
    'config/only-atm.toml': 'x = 1\n',
    'config/icon.png': Buffer.from([0x89, 0x50, 0, 0, 1]),
    'kubejs/server_scripts/main.js': 'ServerEvents.recipes(e => {\n  e.remove({ id: "a" })\n})\n',
    'mods/a.jar': 'jar',
  });
  const lmpDir = tree(path.join(tmp, 'lmp'), {
    'config/same.toml': 'a = 1\n',
    'config/changed.toml': '[general]\nspeed = 3\nname = "x"\n',
    'config/changed.toml.bak': 'backup',
    'config/format.json': '{\n  "a": 1,\n  "b": 2\n}\n',
    'config/icon.png': Buffer.from([0x89, 0x50, 0, 0, 2]),
    'kubejs/server_scripts/main.js': 'ServerEvents.recipes(e => {\n  e.remove({ id: "a" })\n})\n',
    'kubejs/server_scripts/mine.js': '// mine\n',
    'logs/latest.log': 'x',
  });
  const atm = await mk({ pack: 'ATM10', version: '8.3', side: 'client', state: 'clean', locationKind: 'folder', location: atmDir });
  const lmp = await mk({ pack: 'LMP', version: '1.0', side: 'client', state: 'launched', locationKind: 'folder', location: lmpDir });
  return { atm, lmp, atmDir, lmpDir };
}

describe('configs api', () => {
  it('requires a session and validates queries', async () => {
    expect((await app.inject({ url: '/api/v1/configs/inventory?profile=1' })).statusCode).toBe(401);
    expect((await call('GET', '/configs/inventory?profile=abc')).statusCode).toBe(400);
    expect((await call('GET', '/configs/inventory?profile=99')).statusCode).toBe(404);
    expect((await call('POST', '/configs/scan', { profile: 99 })).statusCode).toBe(404);
    expect((await call('GET', '/configs/scan/not-a-uuid')).statusCode).toBe(400);
  });

  it('answers 409 until a profile is scanned, then reports its inventory', async () => {
    const { atm, lmp } = await scenario();
    const before = await call('GET', `/configs/inventory?profile=${lmp}`);
    expect(before.statusCode).toBe(409);
    expect(before.json().error).toMatch(/scan/);
    expect((await call('GET', `/configs/diff?base=${atm}&other=${lmp}`)).statusCode).toBe(409);

    expect((await scan(lmp)).status).toBe('done');
    const inv = (await call('GET', `/configs/inventory?profile=${lmp}`)).json();
    expect(inv.total).toBe(6); // the .bak and logs/ are not tracked
    expect(inv.perRoot.config.files).toBe(4);
    expect(inv.perRoot.kubejs.files).toBe(2);
    expect(inv.perRoot.defaultconfigs.files).toBe(0);
    expect(inv.profile.state).toBe('launched');
    expect(inv.files).toBeUndefined();
    const full = (await call('GET', `/configs/inventory?profile=${lmp}&full=1`)).json();
    expect(Object.keys(full.files)).toContain('config/changed.toml');
  });

  it('reuses the scan of an immutable profile unless forced', async () => {
    const { atm } = await scenario();
    await scan(atm);
    const again = await call('POST', '/configs/scan', { profile: atm });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ jobId: null, cached: true });
    expect((await scan(atm, true)).status).toBe('done');
  });

  it('always rescans a run profile', async () => {
    const dir = tree(path.join(tmp, 'run'), { 'config/a.toml': 'a = 1\n' });
    const id = await mk({ pack: 'LMP', version: '1.0', side: 'server', state: 'run', locationKind: 'folder', location: dir });
    await scan(id);
    expect((await scan(id)).status).toBe('done');
  });

  it('fails the scan job of a missing location and keeps the 409', async () => {
    const id = await mk({ pack: 'LMP', version: '2.0', side: 'client', state: 'launched', locationKind: 'folder', location: path.join(tmp, 'missing') });
    const job = await scan(id);
    expect(job.status).toBe('failed');
    expect(job.message).toMatch(/cannot read the location/);
    expect((await call('GET', `/configs/inventory?profile=${id}`)).statusCode).toBe(409);
  });

  it('compares known binaries by size unless the scan is deep', async () => {
    const { atm, lmp } = await scenario();
    await scan(atm);
    await scan(lmp);
    const quick = (await call('GET', `/configs/diff?base=${atm}&other=${lmp}`)).json().files.find((f: { path: string }) => f.path === 'config/icon.png');
    expect(quick.status).toBe('identical'); // same size, content not read
    await scan(atm, false, true);
    await scan(lmp, false, true);
    const deep = (await call('GET', `/configs/diff?base=${atm}&other=${lmp}`)).json().files.find((f: { path: string }) => f.path === 'config/icon.png');
    expect(deep.status).toBe('binaryDiffers');
  });

  it('diffs two scanned profiles with statuses, roots and states', async () => {
    const { atm, lmp } = await scenario();
    await scan(atm, false, true);
    await scan(lmp, false, true);
    const res = await call('GET', `/configs/diff?base=${atm}&other=${lmp}`);
    expect(res.statusCode).toBe(200);
    const d = res.json();
    expect(d.base).toMatchObject({ id: atm, state: 'clean' });
    expect(d.other).toMatchObject({ id: lmp, state: 'launched' });
    const st = Object.fromEntries(d.files.map((f: { path: string; status: string }) => [f.path, f.status]));
    expect(st).toEqual({
      'config/only-atm.toml': 'onlyInBase',
      'config/changed.toml': 'modified',
      'config/icon.png': 'binaryDiffers',
      'kubejs/server_scripts/mine.js': 'onlyInOther',
      'config/format.json': 'cosmetic',
      'config/same.toml': 'identical',
      'kubejs/server_scripts/main.js': 'identical',
    });
    expect(d.summary.perStatus.identical).toBe(2);
    expect(d.summary.perRoot.kubejs.onlyInOther).toBe(1);
    expect(d.truncated).toBe(false);
  });

  it('serves a text file and refuses unsafe or unknown paths', async () => {
    const { lmp } = await scenario();
    await scan(lmp);
    const ok = await call('GET', `/configs/file?profile=${lmp}&path=${encodeURIComponent('config/changed.toml')}`);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ path: 'config/changed.toml', kind: 'text', truncated: false, stale: false, content: '[general]\nspeed = 3\nname = "x"\n' });
    expect((await call('GET', `/configs/file?profile=${lmp}&path=${encodeURIComponent('CONFIG/Changed.toml')}`)).json().path).toBe('config/changed.toml');

    const bad = ['../atm/config/same.toml', 'config/../../atm/config/same.toml', '/etc/passwd', 'C:\\Windows\\win.ini', 'C:/Windows/win.ini', '\\\\server\\share\\x.toml', '//server/share/x.toml', 'config\\changed.toml', 'config/./changed.toml', 'config/changed.toml:secret', 'mods/a.jar', 'config'];
    for (const p of bad) {
      const res = await call('GET', `/configs/file?profile=${lmp}&path=${encodeURIComponent(p)}`);
      expect(res.statusCode, p).toBe(400);
    }
    expect((await call('GET', `/configs/file?profile=${lmp}&path=%2e%2e%2fatm%2fconfig%2fsame.toml`)).statusCode).toBe(400);
    expect((await call('GET', `/configs/file?profile=${lmp}&path=${encodeURIComponent('config/changed.toml.bak')}`)).statusCode).toBe(404);
    expect((await call('GET', `/configs/file?profile=${lmp}&path=${encodeURIComponent('config/icon.png')}`)).statusCode).toBe(415);
  });

  it('flags a file changed since the scan as stale', async () => {
    const { lmp, lmpDir } = await scenario();
    await scan(lmp);
    fs.writeFileSync(path.join(lmpDir, 'config', 'changed.toml'), 'edited = true\n');
    const res = (await call('GET', `/configs/file?profile=${lmp}&path=config/changed.toml`)).json();
    expect(res.stale).toBe(true);
    expect(res.content).toBe('edited = true\n');
  });

  it('returns a structured line diff', async () => {
    const { atm, lmp } = await scenario();
    await scan(atm, false, true);
    await scan(lmp, false, true);
    const d = (await call('GET', `/configs/filediff?base=${atm}&other=${lmp}&path=config/changed.toml`)).json();
    expect(d).toMatchObject({ status: 'modified', kind: 'text', binary: false, added: 1, removed: 1, truncated: false });
    expect(d.lines).toEqual([
      { type: 'equal', text: '[general]', oldNo: 1, newNo: 1 },
      { type: 'del', text: 'speed = 1', oldNo: 2, newNo: null },
      { type: 'add', text: 'speed = 3', oldNo: null, newNo: 2 },
      { type: 'equal', text: 'name = "x"', oldNo: 3, newNo: 3 },
    ]);
    expect(d.hunks).toHaveLength(1);

    const onlyBase = (await call('GET', `/configs/filediff?base=${atm}&other=${lmp}&path=config/only-atm.toml`)).json();
    expect(onlyBase).toMatchObject({ status: 'onlyInBase', removed: 1, added: 0, otherSize: null });
    const onlyOther = (await call('GET', `/configs/filediff?base=${atm}&other=${lmp}&path=kubejs/server_scripts/mine.js`)).json();
    expect(onlyOther).toMatchObject({ status: 'onlyInOther', added: 1, removed: 0 });
    const bin = (await call('GET', `/configs/filediff?base=${atm}&other=${lmp}&path=config/icon.png`)).json();
    expect(bin).toMatchObject({ status: 'binaryDiffers', binary: true, lines: [] });
    expect((await call('GET', `/configs/filediff?base=${atm}&other=${lmp}&path=config/nope.toml`)).statusCode).toBe(404);
    expect((await call('GET', `/configs/filediff?base=${atm}&other=${lmp}&path=..%2Fx`)).statusCode).toBe(400);
  });

  it('plans only modified files and files missing from the compared profile', async () => {
    const { atm, lmp } = await scenario();
    await scan(atm);
    await scan(lmp);
    expect((await call('GET', `/configs/plan?base=${atm}&other=${lmp}`)).json()).toEqual({ paths: [] });

    const ok = await call('PUT', '/configs/plan', { base: atm, other: lmp, paths: ['config/changed.toml', 'config/only-atm.toml'], selected: true });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().paths).toEqual(['config/changed.toml', 'config/only-atm.toml']);

    const bad = await call('PUT', '/configs/plan', { base: atm, other: lmp, paths: ['config/format.json', 'kubejs/server_scripts/mine.js', 'config/same.toml', 'config/ghost.toml', 'config/changed.toml'], selected: true });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().rejected).toEqual([
      { path: 'config/format.json', status: 'cosmetic' },
      { path: 'kubejs/server_scripts/mine.js', status: 'onlyInOther' },
      { path: 'config/same.toml', status: 'identical' },
      { path: 'config/ghost.toml', status: 'unknown' },
    ]);

    await call('PUT', '/configs/plan', { base: atm, other: lmp, paths: ['config/changed.toml'], selected: false });
    expect((await call('GET', `/configs/plan?base=${atm}&other=${lmp}`)).json()).toEqual({ paths: ['config/only-atm.toml'] });
    const rows = db.sqlite.prepare('SELECT kind, key FROM update_plan_item').all();
    expect(rows).toEqual([{ kind: 'file', key: 'config/only-atm.toml' }]);
  });

  it('scans and diffs a server pack zip with a wrapper folder', async () => {
    const zipPath = path.join(tmp, 'server.zip');
    fs.writeFileSync(zipPath, buildZip([
      { name: 'Server-Files-8.3/config/same.toml', data: Buffer.from('a = 1\n') },
      { name: 'Server-Files-8.3/config/changed.toml', data: Buffer.from('[general]\r\nspeed = 1\r\nname = "x"\r\n'), method: 'deflate' },
      { name: 'Server-Files-8.3/mods/a.jar', data: Buffer.from('jar') },
    ]));
    const srv = await mk({ pack: 'ATM10', version: '8.3', side: 'server', state: 'clean', locationKind: 'zip', location: zipPath });
    const dir = tree(path.join(tmp, 'mine'), { 'config/same.toml': 'a = 1\n', 'config/changed.toml': '[general]\nspeed = 1\nname = "x"\n' });
    const mine = await mk({ pack: 'LMP', version: '1.0', side: 'server', state: 'clean', locationKind: 'folder', location: dir });
    await scan(srv);
    await scan(mine);
    const d = (await call('GET', `/configs/diff?base=${srv}&other=${mine}`)).json();
    expect(d.files.map((f: { path: string; status: string }) => `${f.path}:${f.status}`)).toEqual(['config/changed.toml:cosmetic', 'config/same.toml:identical']);
    const file = (await call('GET', `/configs/file?profile=${srv}&path=config/changed.toml`)).json();
    expect(file.content).toBe('[general]\r\nspeed = 1\r\nname = "x"\r\n');
  });
});

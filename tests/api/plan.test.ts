import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/server/api/auth.js';
import { buildApp } from '../../src/server/api/app.js';
import type { Config } from '../../src/server/config.js';
import { openDb, type Db } from '../../src/server/db/open.js';
import { closePool } from '../../src/server/jobs/pool.js';
import { JobRunner } from '../../src/server/jobs/runner.js';
import type { JarSpec } from '../fixtures-gen/jar.js';
import { writeAtmPack } from '../fixtures-gen/packs.js';

let db: Db;
let app: FastifyInstance;
let tmp: string;
let dataDir: string;
let cookie: string;

const jar = (id: string, version = '1.0'): JarSpec => ({ fileName: `${id}-${version}.jar`, loader: 'neoforge', mods: [{ modId: id, version }] });

beforeEach(async () => {
  db = openDb(':memory:');
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-api-'));
  dataDir = path.join(tmp, 'data');
  const config: Config = { bindHost: '127.0.0.1', port: 0, passwordHash: hashPassword('pw'), allowedHosts: [] };
  app = buildApp({ db, jobs: new JobRunner(db), config, dataDir });
  await app.ready();
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { password: 'pw' } });
  cookie = String(res.headers['set-cookie']).split(';')[0]!;
});
afterEach(async () => {
  await app.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
afterAll(() => closePool());

const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, payload: payload as object, headers: { cookie } });

async function waitJob(jobId: string): Promise<{ status: string; message: string | null }> {
  for (let i = 0; i < 200; i++) {
    const row = db.sqlite.prepare('SELECT status, message FROM job WHERE id = ?').get(jobId) as { status: string; message: string | null };
    if (!['queued', 'running'].includes(row.status)) return row;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('job timed out');
}

async function importAndWait(profileId: number, source: unknown) {
  const res = await call('POST', `/profiles/${profileId}/import`, { source });
  expect(res.statusCode).toBe(202);
  expect((await waitJob((res.json() as { jobId: string }).jobId)).status).toBe('done');
}

/** Base client (reference) vs Own: a older in Own, b missing from Own, n newer in Own, mine added. */
async function scenario() {
  const atm = await writeAtmPack(path.join(tmp, 'atm'), { atm: '8.3', neoforge: '21.1.259', mc: '1.21.1', serverMods: [], clientMods: [jar('a', '1.1'), jar('b'), jar('n', '1.0')] });
  fs.mkdirSync(path.join(atm.clientDir, 'config'));
  fs.writeFileSync(path.join(atm.clientDir, 'config', 'x.toml'), 'ref = 1\n');
  const lmp = await writeAtmPack(path.join(tmp, 'lmp'), { atm: '1.0', neoforge: '21.1.259', mc: '1.21.1', serverMods: [], clientMods: [jar('a', '1.0'), jar('n', '2.0'), jar('mine')] });
  const mk = async (body: object) => ((await call('POST', '/profiles', body)).json() as { id: number }).id;
  const c = await mk({ pack: 'Base', version: '8.3', side: 'client', state: 'clean', locationKind: 'folder', location: atm.clientDir });
  const l = await mk({ pack: 'Own', version: '1.0', side: 'client', state: 'clean', locationKind: 'folder', location: lmp.clientDir });
  await importAndWait(c, { kind: 'folder', path: atm.clientDir });
  await importAndWait(l, { kind: 'folder', path: lmp.clientDir });
  return { c, l, atm, lmp };
}

describe('plan api', () => {
  it('selects actionable mods only, lists them with the decisions in force, and clears', async () => {
    const { c, l } = await scenario();
    expect((await call('PUT', '/plan', { base: c, other: l, kind: 'mod', keys: ['a', 'b'], selected: true })).statusCode).toBe(200);

    const bad = await call('PUT', '/plan', { base: c, other: l, kind: 'mod', keys: ['a', 'n', 'mine', 'ghost'], selected: true });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/n, mine, ghost/);

    await call('PUT', '/mods/b/decision', { kind: 'ignore', reason: 'x' });
    await call('PUT', '/mods/mine/decision', { kind: 'side', side: 'client', reason: 'x' });
    const plan = (await call('GET', `/plan?base=${c}&other=${l}`)).json();
    expect(plan.items).toEqual([{ kind: 'mod', key: 'a', action: 'take_ref' }, { kind: 'mod', key: 'b', action: 'take_ref' }]);
    expect(plan.decisions).toEqual({ pins: [], ignored: ['b'], clientOnly: ['mine'] });

    // unselecting is always allowed, even for a key that is no longer actionable
    expect((await call('PUT', '/plan', { base: c, other: l, kind: 'mod', keys: ['a', 'ghost'], selected: false })).statusCode).toBe(200);
    expect((await call('GET', `/plan?base=${c}&other=${l}`)).json().items.map((i: { key: string }) => i.key)).toEqual(['b']);

    expect((await call('DELETE', `/plan?base=${c}&other=${l}&kind=mod`)).statusCode).toBe(200);
    expect((await call('GET', `/plan?base=${c}&other=${l}`)).json().items).toEqual([]);
  });

  it('checks the shape of file keys and the request', async () => {
    const { c, l } = await scenario();
    expect((await call('PUT', '/plan', { base: c, other: l, kind: 'file', keys: ['config/x.toml'], selected: true })).statusCode).toBe(200);
    for (const key of ['../x', 'C:/x', 'config\\x.toml', '/etc/x', 'config/../../x']) {
      const res = await call('PUT', '/plan', { base: c, other: l, kind: 'file', keys: [key], selected: true });
      expect(res.statusCode, key).toBe(400);
    }
    expect((await call('PUT', '/plan', { base: c, other: l, kind: 'nope', keys: ['a'], selected: true })).statusCode).toBe(400);
    expect((await call('PUT', '/plan', { base: c, other: l, kind: 'mod', keys: Array.from({ length: 5001 }, (_, i) => `k${i}`), selected: true })).statusCode).toBe(400);
    expect((await call('GET', `/plan?base=${c}&other=999`)).statusCode).toBe(404);
    expect((await call('GET', `/plan?base=x&other=1`)).statusCode).toBe(400);
  });

  it('exports the plan as an update pack, lists it and serves the zip', async () => {
    const { c, l } = await scenario();
    expect((await call('POST', '/plan/export', { base: c, other: l })).statusCode).toBe(409); // empty plan
    await call('PUT', '/plan', { base: c, other: l, kind: 'mod', keys: ['a', 'b'], selected: true });
    await call('PUT', '/plan', { base: c, other: l, kind: 'file', keys: ['config/x.toml'], selected: true });

    const res = await call('POST', '/plan/export', { base: c, other: l });
    expect(res.statusCode).toBe(202);
    const { jobId } = res.json() as { jobId: string };
    expect((await waitJob(jobId)).status).toBe('done');

    const job = (await call('GET', `/plan/jobs/${jobId}`)).json();
    expect(job).toMatchObject({ status: 'done' });
    expect(job.name).toMatch(/^update-Own-1\.0-from-Base-8\.3-\d{8}-\d{6}$/);

    const list = (await call('GET', '/plan/exports')).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: job.name, counts: { modsUpdated: 1, modsRestored: 1, files: 1, failures: 0 } });
    expect(list[0].zipBytes).toBeGreaterThan(0);

    const one = (await call('GET', `/plan/exports/${job.name}`)).json();
    expect(one.folder).toBe(path.join(dataDir, 'exports', job.name));
    expect(one.result.counts.jarsToRemove).toBe(1);
    expect(fs.existsSync(path.join(one.folder, 'apply.ps1'))).toBe(true);

    const dl = await call('GET', `/plan/exports/${job.name}/download`);
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toBe('application/zip');
    expect(String(dl.headers['content-disposition'])).toContain(`attachment; filename="${job.name}.zip"`);
    expect(dl.rawPayload.subarray(0, 2).toString()).toBe('PK');

    expect((await call('GET', '/plan/exports/..%2F..%2Fsecret/download')).statusCode).toBe(404);
    expect((await call('GET', '/plan/exports/nope/download')).statusCode).toBe(404);
    expect((await call('GET', '/plan/exports/nope')).statusCode).toBe(404);
    expect((await call('GET', '/plan/jobs/nope')).statusCode).toBe(404);
  });

  it('fails the export job when nothing can be copied', async () => {
    const { c, l, atm } = await scenario();
    await call('PUT', '/plan', { base: c, other: l, kind: 'mod', keys: ['b'], selected: true });
    fs.rmSync(path.join(atm.clientDir, 'mods', 'b-1.0.jar'));
    const res = await call('POST', '/plan/export', { base: c, other: l });
    const job = await waitJob((res.json() as { jobId: string }).jobId);
    expect(job.status).toBe('failed');
    expect(job.message).toMatch(/nothing could be exported/);
    expect((await call('GET', '/plan/exports')).json()).toEqual([]);
  });

  it('refuses to export before both profiles are imported or when the reference location is gone', async () => {
    const { c, l, atm } = await scenario();
    const empty = ((await call('POST', '/profiles', { pack: 'Own', version: '2.0', side: 'client', state: 'clean', locationKind: 'folder', location: path.join(tmp, 'none') })).json() as { id: number }).id;
    expect((await call('POST', '/plan/export', { base: c, other: empty })).statusCode).toBe(409);
    await call('PUT', '/plan', { base: c, other: l, kind: 'mod', keys: ['a'], selected: true });
    fs.renameSync(atm.clientDir, `${atm.clientDir}-moved`);
    expect((await call('POST', '/plan/export', { base: c, other: l })).statusCode).toBe(409);
    expect((await call('POST', '/plan/export', { base: c, other: 999 })).statusCode).toBe(404);
  });

  it('serves a debug document for one row with a source jar check', async () => {
    const { c, l, atm } = await scenario();
    await call('PUT', '/plan', { base: c, other: l, kind: 'mod', keys: ['a'], selected: true });
    const dbg = (await call('GET', `/mods/a/debug?base=${c}&other=${l}`)).json();
    expect(dbg.modId).toBe('a');
    expect(dbg.status).toBe('older');
    expect(dbg.base.entry).toMatchObject({ version: '1.1', file: 'a-1.1.jar' });
    expect(dbg.other.entry).toMatchObject({ version: '1.0', file: 'a-1.0.jar' });
    expect(dbg.base.profile).toMatchObject({ id: c, label: expect.stringContaining('Base 8.3'), location: atm.clientDir });
    expect(dbg.comparison).toMatchObject({ result: 'older', deciding: { index: 1, tokenA: '0', tokenB: '1' } });
    expect(dbg.plan).toEqual({ planned: true, actionable: true, action: 'update' });
    expect(dbg.decisions).toMatchObject({ pin: null, ignore: null, side: null, blacklisted: null });
    expect(dbg.duplicates).toEqual({ base: null, other: null });
    expect(dbg.sourceJar).toMatchObject({ path: path.join(atm.clientDir, 'mods', 'a-1.1.jar'), exists: true, matches: true });
    expect(dbg.sourceJar.sha256Actual).toBe(dbg.base.entry.sha256);

    fs.appendFileSync(path.join(atm.clientDir, 'mods', 'a-1.1.jar'), 'x');
    const changed = (await call('GET', `/mods/a/debug?base=${c}&other=${l}`)).json();
    expect(changed.sourceJar).toMatchObject({ exists: true, matches: false });

    const added = (await call('GET', `/mods/mine/debug?base=${c}&other=${l}`)).json();
    expect(added).toMatchObject({ status: 'added', base: { entry: null }, sourceJar: null, plan: { planned: false, actionable: false, action: null } });
    expect((await call('GET', `/mods/ghost/debug?base=${c}&other=${l}`)).statusCode).toBe(404);
    expect((await call('GET', `/mods/a/debug?base=${c}&other=999`)).statusCode).toBe(404);
  });
});

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
let cookie: string;

const jar = (id: string, version = '1.0'): JarSpec => ({ fileName: `${id}-${version}.jar`, loader: 'neoforge', mods: [{ modId: id, version }] });

beforeEach(async () => {
  db = openDb(':memory:');
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1-'));
  const config: Config = { bindHost: '127.0.0.1', port: 0, passwordHash: hashPassword('pw'), allowedHosts: [] };
  app = buildApp({ db, jobs: new JobRunner(db), config });
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

const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, payload: payload as object, headers: { cookie } });

async function importAndWait(profileId: number, source: unknown): Promise<void> {
  const res = await call('POST', `/profiles/${profileId}/import`, { source });
  expect(res.statusCode).toBe(202);
  const { jobId } = res.json() as { jobId: string };
  for (let i = 0; i < 100; i++) {
    const row = db.sqlite.prepare('SELECT status FROM job WHERE id = ?').get(jobId) as { status: string };
    if (row.status === 'done') return;
    if (row.status === 'failed') throw new Error('import job failed');
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('import job timed out');
}

async function scenario() {
  const atm = await writeAtmPack(path.join(tmp, 'atm'), { atm: '8.3', neoforge: '21.1.259', mc: '1.21.1', serverMods: [jar('a'), jar('b'), jar('srv')], clientMods: [jar('a'), jar('b'), jar('cli')] });
  const lmp = await writeAtmPack(path.join(tmp, 'lmp'), { atm: '1.0', neoforge: '21.1.251', mc: '1.21.1', serverMods: [], clientMods: [jar('a', '1.1'), jar('cli'), jar('mine')] });
  const mk = async (body: object) => ((await call('POST', '/profiles', body)).json() as { id: number }).id;
  const s = await mk({ pack: 'ATM10', version: '8.3', side: 'server', state: 'clean', locationKind: 'zip', location: atm.serverZip });
  const c = await mk({ pack: 'ATM10', version: '8.3', side: 'client', state: 'clean', locationKind: 'folder', location: atm.clientDir });
  const l = await mk({ pack: 'LMP', version: '1.0', side: 'client', state: 'clean', locationKind: 'folder', location: lmp.clientDir });
  await importAndWait(s, { kind: 'zip', path: atm.serverZip });
  await importAndWait(c, { kind: 'folder', path: atm.clientDir });
  await importAndWait(l, { kind: 'folder', path: lmp.clientDir });
  return { s, c, l };
}

describe('phase 1 api', () => {
  it('rejects unauthenticated calls and bad bodies', async () => {
    expect((await app.inject({ url: '/api/v1/profiles/matrix' })).statusCode).toBe(401);
    const bad = await call('POST', '/profiles', { pack: 'NOPE' });
    expect(bad.statusCode).toBe(400);
    expect(String(bad.json().error)).toBeTruthy();
  });

  it('derives ATM sides, diffs LMP against ATM, and checks loaders', async () => {
    const { s, c, l } = await scenario();

    const sides = (await call('GET', `/mods/atm-sides?server=${s}&client=${c}`)).json();
    expect(sides).toEqual({ clientOnly: ['cli'], serverOnly: ['srv'], both: ['a', 'b'] });

    const diff = (await call('GET', `/mods/diff?base=${c}&other=${l}`)).json();
    expect(diff.updated.map((u: { modId: string }) => u.modId)).toEqual(['a']);
    expect(diff.added.map((e: { modId: string }) => e.modId)).toEqual(['mine']);

    const check = (await call('GET', `/loader/check?profiles=${s},${c},${l}`)).json();
    expect(check.ok).toBe(false);
    expect(check.mismatches.some((m: { field: string }) => m.field === 'loaderVersion')).toBe(true);
  });

  it('blocks the build on an anomaly until it is resolved by a decision', async () => {
    const { c, l } = await scenario();
    const first = (await call('GET', `/build/blockers?atmClient=${c}&lmp=${l}`)).json();
    expect(first).toEqual([{ code: 'ANOMALY', modId: 'b' }]);
    expect((await call('PUT', '/mods/b/decision', { kind: 'ignore', reason: 'removed on purpose' })).statusCode).toBe(200);
    expect((await call('GET', `/build/blockers?atmClient=${c}&lmp=${l}`)).json()).toEqual([]);
  });

  it('adopts the ATM-derived blacklist in one call', async () => {
    const { s, c } = await scenario();
    expect((await call('PUT', '/blacklist', { action: 'adopt-atm', server: s, client: c })).statusCode).toBe(200);
    const list = (await call('GET', `/blacklist?atmVersion=8.3`)).json();
    expect(list.map((e: { modId: string }) => e.modId)).toEqual(['cli']);
  });

  it('refuses sides when the ATM client and server versions differ', async () => {
    const atm = await writeAtmPack(path.join(tmp, 'atm'), { atm: '8.3', neoforge: '21.1.259', mc: '1.21.1', serverMods: [jar('a')], clientMods: [jar('a')] });
    const mk = async (body: object) => ((await call('POST', '/profiles', body)).json() as { id: number }).id;
    const s = await mk({ pack: 'ATM10', version: '8.2', side: 'server', state: 'clean', locationKind: 'zip', location: atm.serverZip });
    const c = await mk({ pack: 'ATM10', version: '8.3', side: 'client', state: 'clean', locationKind: 'folder', location: atm.clientDir });
    expect((await call('GET', `/mods/atm-sides?server=${s}&client=${c}`)).statusCode).toBe(409);
  });
});

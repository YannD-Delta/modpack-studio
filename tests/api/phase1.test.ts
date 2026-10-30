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
import { makeJar, type JarSpec } from '../fixtures-gen/jar.js';
import { writeBasePack } from '../fixtures-gen/packs.js';

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

async function finalStatus(jobId: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const row = db.sqlite.prepare('SELECT status FROM job WHERE id = ?').get(jobId) as { status: string };
    if (!['queued', 'running'].includes(row.status)) return row.status;
    await new Promise((r) => setTimeout(r, 50));
  }
  return 'timeout';
}

async function scenario(opts: { brokenInUpstreamClient?: boolean } = {}) {
  const upstream = await writeBasePack(path.join(tmp, 'upstream'), { upstream: '8.3', neoforge: '21.1.259', mc: '1.21.1', serverMods: [jar('a'), jar('b'), jar('srv')], clientMods: [jar('a'), jar('b'), jar('cli')] });
  if (opts.brokenInUpstreamClient) fs.writeFileSync(path.join(upstream.clientDir, 'mods', 'broken.jar'), 'not a zip');
  const own = await writeBasePack(path.join(tmp, 'own'), { upstream: '1.0', neoforge: '21.1.251', mc: '1.21.1', serverMods: [], clientMods: [jar('a', '1.1'), jar('cli'), jar('mine')] });
  const mk = async (body: object) => ((await call('POST', '/profiles', body)).json() as { id: number }).id;
  const s = await mk({ pack: 'Base', version: '8.3', side: 'server', state: 'clean', locationKind: 'zip', location: upstream.serverZip });
  const c = await mk({ pack: 'Base', version: '8.3', side: 'client', state: 'clean', locationKind: 'folder', location: upstream.clientDir });
  const l = await mk({ pack: 'Own', version: '1.0', side: 'client', state: 'clean', locationKind: 'folder', location: own.clientDir });
  await importAndWait(s, { kind: 'zip', path: upstream.serverZip });
  await importAndWait(c, { kind: 'folder', path: upstream.clientDir });
  await importAndWait(l, { kind: 'folder', path: own.clientDir });
  return { s, c, l, upstream, own };
}

const mkProfile = async (body: object) => ((await call('POST', '/profiles', body)).json() as { id: number }).id;

describe('phase 1 api', () => {
  it('rejects unauthenticated calls and bad bodies', async () => {
    expect((await app.inject({ url: '/api/v1/profiles/matrix' })).statusCode).toBe(401);
    const bad = await call('POST', '/profiles', { pack: 'NOPE' });
    expect(bad.statusCode).toBe(400);
    expect(String(bad.json().error)).toBeTruthy();
  });

  it('derives base sides, diffs Own against base, and checks loaders', async () => {
    const { s, c, l } = await scenario();

    const sides = (await call('GET', `/mods/upstream-sides?server=${s}&client=${c}`)).json();
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
    const first = (await call('GET', `/build/blockers?upstreamClient=${c}&own=${l}`)).json();
    expect(first).toEqual([{ code: 'ANOMALY', modId: 'b' }]);
    expect((await call('PUT', '/mods/b/decision', { kind: 'ignore', reason: 'removed on purpose' })).statusCode).toBe(200);
    expect((await call('GET', `/build/blockers?upstreamClient=${c}&own=${l}`)).json()).toEqual([]);
  });

  it('does not block on a duplicate id that base itself ships, but blocks on a new one', async () => {
    const twin = [jar('dup', '1.0'), jar('dup', '2.0')];
    const upstream = await writeBasePack(path.join(tmp, 'upstream'), { upstream: '8.3', neoforge: '21.1.259', mc: '1.21.1', serverMods: [], clientMods: [...twin, jar('a')] });
    const own = await writeBasePack(path.join(tmp, 'own'), { upstream: '1.0', neoforge: '21.1.259', mc: '1.21.1', serverMods: [], clientMods: [...twin, jar('a'), jar('mine', '1.0'), { ...jar('mine', '2.0'), fileName: 'mine-copy-2.0.jar' }] });
    const c = await mkProfile({ pack: 'Base', version: '8.3', side: 'client', state: 'clean', locationKind: 'folder', location: upstream.clientDir });
    const l = await mkProfile({ pack: 'Own', version: '1.0', side: 'client', state: 'clean', locationKind: 'folder', location: own.clientDir });
    await importAndWait(c, { kind: 'folder', path: upstream.clientDir });
    await importAndWait(l, { kind: 'folder', path: own.clientDir });
    const blockers = (await call('GET', `/build/blockers?upstreamClient=${c}&own=${l}`)).json() as { code: string; modId: string }[];
    expect(blockers).toEqual([{ code: 'DUPLICATE_ID', modId: 'mine' }]);
  });

  it('adopts the base-derived blacklist in one call', async () => {
    const { s, c } = await scenario();
    expect((await call('PUT', '/blacklist', { action: 'adopt-upstream', server: s, client: c })).statusCode).toBe(200);
    const list = (await call('GET', `/blacklist?upstreamVersion=8.3`)).json();
    expect(list.map((e: { modId: string }) => e.modId)).toEqual(['cli']);
  });

  it('refuses an import whose path differs from the profile location', async () => {
    const upstream = await writeBasePack(path.join(tmp, 'upstream'), { upstream: '8.3', neoforge: '21.1.259', mc: '1.21.1', serverMods: [jar('a')], clientMods: [jar('a')] });
    const c = await mkProfile({ pack: 'Base', version: '8.3', side: 'client', state: 'clean', locationKind: 'folder', location: upstream.clientDir });
    const res = await call('POST', `/profiles/${c}/import`, { source: { kind: 'folder', path: path.join(tmp, 'somewhere-else') } });
    expect(res.statusCode).toBe(400);
  });

  it('refuses to import again into an immutable profile that already has mods', async () => {
    const { c, upstream } = await scenario();
    const res = await call('POST', `/profiles/${c}/import`, { source: { kind: 'folder', path: upstream.clientDir } });
    expect(res.statusCode).toBe(409);
  });

  it('fails the import job when the folder holds no jar', async () => {
    const empty = path.join(tmp, 'empty-folder');
    fs.mkdirSync(empty, { recursive: true });
    const c = await mkProfile({ pack: 'Base', version: '9.9', side: 'client', state: 'clean', locationKind: 'folder', location: empty });
    const res = await call('POST', `/profiles/${c}/import`, { source: { kind: 'folder', path: empty } });
    expect(await finalStatus((res.json() as { jobId: string }).jobId)).toBe('failed');
  });

  it('re-checks launch artifacts of a clean folder at import time', async () => {
    const upstream = await writeBasePack(path.join(tmp, 'upstream'), { upstream: '8.3', neoforge: '21.1.259', mc: '1.21.1', serverMods: [jar('a')], clientMods: [jar('a')] });
    const c = await mkProfile({ pack: 'Base', version: '8.3', side: 'client', state: 'clean', locationKind: 'folder', location: upstream.clientDir });
    fs.mkdirSync(path.join(upstream.clientDir, 'logs')); // the game was started after the profile was registered
    fs.writeFileSync(path.join(upstream.clientDir, 'logs', 'latest.log'), 'started');
    const res = await call('POST', `/profiles/${c}/import`, { source: { kind: 'folder', path: upstream.clientDir } });
    expect(res.statusCode).toBe(422);
  });

  it('turns skipped jars into build blockers and refuses base sides until the import is complete', async () => {
    const { s, c, l } = await scenario({ brokenInUpstreamClient: true });
    const blockers = (await call('GET', `/build/blockers?upstreamClient=${c}&own=${l}`)).json() as { code: string; modId: string }[];
    expect(blockers).toContainEqual({ code: 'SKIPPED_JAR', modId: 'broken.jar' });
    expect((await call('GET', `/mods/upstream-sides?server=${s}&client=${c}`)).statusCode).toBe(409);
    expect((await call('PUT', '/blacklist', { action: 'adopt-upstream', server: s, client: c })).statusCode).toBe(409);
  });

  it('refuses base sides when the profiles are not a Base server and a Base client', async () => {
    const { c, l } = await scenario();
    expect((await call('GET', `/mods/upstream-sides?server=${l}&client=${c}`)).statusCode).toBe(409);
  });

  it('refuses base sides for a profile with no imported mods', async () => {
    const upstream = await writeBasePack(path.join(tmp, 'upstream'), { upstream: '8.3', neoforge: '21.1.259', mc: '1.21.1', serverMods: [jar('a')], clientMods: [jar('a')] });
    const s = await mkProfile({ pack: 'Base', version: '8.3', side: 'server', state: 'clean', locationKind: 'zip', location: upstream.serverZip });
    const c = await mkProfile({ pack: 'Base', version: '8.3', side: 'client', state: 'clean', locationKind: 'folder', location: upstream.clientDir });
    expect((await call('GET', `/mods/upstream-sides?server=${s}&client=${c}`)).statusCode).toBe(409);
  });

  it('refuses base sides when NeoForge differs between the base server pack and client', async () => {
    const srv = await writeBasePack(path.join(tmp, 'srv'), { upstream: '8.3', neoforge: '21.1.259', mc: '1.21.1', serverMods: [jar('a')], clientMods: [] });
    const cli = await writeBasePack(path.join(tmp, 'cli'), { upstream: '8.3', neoforge: '21.1.251', mc: '1.21.1', serverMods: [], clientMods: [jar('a')] });
    const s = await mkProfile({ pack: 'Base', version: '8.3', side: 'server', state: 'clean', locationKind: 'zip', location: srv.serverZip });
    const c = await mkProfile({ pack: 'Base', version: '8.3', side: 'client', state: 'clean', locationKind: 'folder', location: cli.clientDir });
    await importAndWait(s, { kind: 'zip', path: srv.serverZip });
    await importAndWait(c, { kind: 'folder', path: cli.clientDir });
    expect((await call('GET', `/mods/upstream-sides?server=${s}&client=${c}`)).statusCode).toBe(409);
  });

  it('derives base sides when the server pack is an unpacked folder, and reports an unknown loader without failing', async () => {
    const upstream = await writeBasePack(path.join(tmp, 'upstream'), { upstream: '8.3', neoforge: '21.1.259', mc: '1.21.1', serverMods: [jar('a'), jar('srv')], clientMods: [jar('a'), jar('cli')] });
    const srvDir = path.join(tmp, 'server-folder');
    fs.mkdirSync(path.join(srvDir, 'mods'), { recursive: true });
    fs.writeFileSync(path.join(srvDir, 'startserver.sh'), 'NEOFORGE_VERSION=21.1.259');
    for (const spec of [jar('a'), jar('srv')]) fs.writeFileSync(path.join(srvDir, 'mods', spec.fileName), await makeJar(spec));
    const s = await mkProfile({ pack: 'Base', version: '8.3', side: 'server', state: 'clean', locationKind: 'folder', location: srvDir });
    const c = await mkProfile({ pack: 'Base', version: '8.3', side: 'client', state: 'clean', locationKind: 'folder', location: upstream.clientDir });
    await importAndWait(s, { kind: 'folder', path: srvDir });
    await importAndWait(c, { kind: 'folder', path: upstream.clientDir });
    const res = await call('GET', `/mods/upstream-sides?server=${s}&client=${c}`);
    expect(res.statusCode).toBe(200);
    const bare = path.join(tmp, 'bare');
    fs.mkdirSync(bare);
    const u = await mkProfile({ pack: 'Base', version: '8.3', side: 'server', state: 'run', locationKind: 'folder', location: bare });
    const check = await call('GET', `/loader/check?profiles=${s},${c},${u}`);
    expect(check.statusCode).toBe(200);
    expect(check.json().ok).toBe(true);
  });

  it('lists the loader of each profile next to the agreement, and reports an unknown one instead of failing', async () => {
    const { s, c } = await scenario();
    const bare = path.join(tmp, 'bare-for-list');
    fs.mkdirSync(bare);
    const u = await mkProfile({ pack: 'Base', version: '8.3', side: 'server', state: 'run', locationKind: 'folder', location: bare });
    const check = (await call('GET', `/loader/check?profiles=${s},${c},${u}`)).json();
    expect(check.ok).toBe(true);
    expect(check.profiles).toHaveLength(3);
    expect(check.profiles[0]).toMatchObject({ id: s, label: 'Base 8.3 server clean', loader: { loader: 'neoforge', loaderVersion: '21.1.259', mcVersion: '1.21.1' }, error: null });
    expect(check.profiles[2]).toMatchObject({ id: u, loader: null, error: null });
  });

  it('rejects a side decision that carries no side', async () => {
    expect((await call('PUT', '/mods/x/decision', { kind: 'side', reason: 'oops' })).statusCode).toBe(400);
  });

  it('checks the loader of every profile, even when several share pack, version and side', async () => {
    const { s, c } = await scenario();
    const other = await writeBasePack(path.join(tmp, 'played'), { upstream: '8.3', neoforge: '21.1.251', mc: '1.21.1', serverMods: [], clientMods: [jar('a')] });
    const played = await mkProfile({ pack: 'Base', version: '8.3', side: 'client', state: 'run', locationKind: 'folder', location: other.clientDir });
    const check = (await call('GET', `/loader/check?profiles=${s},${c},${played}`)).json();
    expect(check.ok).toBe(false);
    // the clean copy (21.1.259) and the played copy (21.1.251) are both compared, not just the last one
    expect(check.mismatches).toContainEqual({ a: 'Base 8.3 client clean', b: 'Base 8.3 client run', field: 'loaderVersion' });
  });

  it('refuses to derive or adopt the blacklist from a played or launched copy', async () => {
    const { s } = await scenario();
    const upstream = await writeBasePack(path.join(tmp, 'played'), { upstream: '8.3', neoforge: '21.1.259', mc: '1.21.1', serverMods: [jar('a')], clientMods: [jar('a'), jar('cli')] });
    const played = await mkProfile({ pack: 'Base', version: '8.3', side: 'client', state: 'launched', locationKind: 'folder', location: upstream.clientDir });
    const adopt = await call('PUT', '/blacklist', { action: 'adopt-upstream', server: s, client: played });
    expect(adopt.statusCode).toBe(400);
    expect(adopt.json()).toMatchObject({ code: 'profile_not_clean' });
    expect(typeof adopt.json().error).toBe('string');
    expect((await call('GET', `/mods/upstream-sides?server=${s}&client=${played}`)).json()).toMatchObject({ code: 'profile_not_clean' });
    expect((await call('GET', '/blacklist?upstreamVersion=8.3')).json()).toEqual([]);
  });

  it('refuses a mods diff between a client and a server, or with a profile that was never imported', async () => {
    const { s, c, own } = await scenario();
    const cross = await call('GET', `/mods/diff?base=${c}&other=${s}`);
    expect(cross.statusCode).toBe(400);
    expect(cross.json()).toMatchObject({ code: 'sides_differ' });
    const fresh = await mkProfile({ pack: 'Own', version: '2.0', side: 'client', state: 'launched', locationKind: 'folder', location: own.clientDir });
    const empty = await call('GET', `/mods/diff?base=${c}&other=${fresh}`);
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toMatchObject({ code: 'profile_not_imported' });
    expect(empty.json().error).toContain(String(fresh));
  });

  it('answers every error with { error, code? }, framework errors included', async () => {
    const missing = await call('GET', '/mods/diff?base=998&other=999');
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'profile 998 not found', code: 'profile_not_found' });

    const badJson = await app.inject({ method: 'PUT', url: '/api/v1/blacklist', payload: '{nope', headers: { cookie, 'content-type': 'application/json' } });
    expect(badJson.statusCode).toBe(400);
    expect(Object.keys(badJson.json()).sort()).toEqual(['code', 'error']);
    expect(badJson.json().error).toMatch(/json/i);

    const huge = await app.inject({ method: 'PUT', url: '/api/v1/blacklist', payload: { action: 'add', modId: 'x', reason: 'y'.repeat(2 * 1024 * 1024) }, headers: { cookie } });
    expect(huge.statusCode).toBe(413);
    expect(typeof huge.json().error).toBe('string');
    expect(huge.json().statusCode).toBeUndefined();
  });

  it('refuses sides when the base client and server versions differ', async () => {
    const upstream = await writeBasePack(path.join(tmp, 'upstream'), { upstream: '8.3', neoforge: '21.1.259', mc: '1.21.1', serverMods: [jar('a')], clientMods: [jar('a')] });
    const mk = async (body: object) => ((await call('POST', '/profiles', body)).json() as { id: number }).id;
    const s = await mk({ pack: 'Base', version: '8.2', side: 'server', state: 'clean', locationKind: 'zip', location: upstream.serverZip });
    const c = await mk({ pack: 'Base', version: '8.3', side: 'client', state: 'clean', locationKind: 'folder', location: upstream.clientDir });
    expect((await call('GET', `/mods/upstream-sides?server=${s}&client=${c}`)).statusCode).toBe(409);
  });
});

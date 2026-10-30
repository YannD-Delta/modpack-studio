import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/api/app.js';
import { hashPassword } from '../../src/server/api/auth.js';
import type { Config } from '../../src/server/config.js';
import { openDb, type Db } from '../../src/server/db/open.js';
import { closePool } from '../../src/server/jobs/pool.js';
import { JobRunner } from '../../src/server/jobs/runner.js';
import { storeSources } from '../../src/server/mods/curseforge-sources.js';
import { createProfile } from '../../src/server/profiles/profile-service.js';
import { setSecret } from '../../src/server/settings/secrets-store.js';

let db: Db;
let app: FastifyInstance;
let cookie: string;
let dataDir: string;
let tmp: string;
let seen: { url: string; key: string | undefined }[];
let answer: (url: string) => { status: number; body: unknown };
let profileId: number;

const file = (id: number, modId: number, date: string, releaseType = 1) => ({ id, modId, displayName: `file ${id}`, fileName: `m${modId}-${id}.jar`, fileDate: date, releaseType });
const source = (projectId: number, fileId: number, name: string) => ({ fileName: `${name}-${fileId}.jar`, projectId, fileId, name, url: `https://www.curseforge.com/minecraft/mc-mods/${name}` });

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-cf-'));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-cf-inst-'));
  seen = [];
  answer = () => ({ status: 200, body: { data: [] } });
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), key: new Headers(init?.headers).get('x-api-key') ?? undefined });
    const r = answer(String(url));
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  db = openDb(':memory:');
  const config: Config = { bindHost: '127.0.0.1', port: 0, passwordHash: hashPassword('pw'), allowedHosts: [] };
  app = buildApp({ db, jobs: new JobRunner(db), config, dataDir, fetchImpl });
  await app.ready();
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { password: 'pw' } });
  cookie = String(res.headers['set-cookie']).split(';')[0]!;
  profileId = createProfile(db, { pack: 'Own', version: '1.0', side: 'client', state: 'clean', locationKind: 'folder', location: tmp }).id;
});
afterEach(async () => {
  await app.close();
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
});
afterAll(() => closePool());

const get = (url: string) => app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { cookie } });

describe('curseforge routes', () => {
  it('lists the CurseForge links of a profile', async () => {
    storeSources(db, profileId, [source(1, 10, 'alpha'), source(2, 20, 'beta')]);
    const res = await get(`/curseforge/sources?profile=${profileId}`);
    expect(res.json().sources.map((s: { name: string }) => s.name).sort()).toEqual(['alpha', 'beta']);
  });

  it('asks for a key first, without calling CurseForge', async () => {
    storeSources(db, profileId, [source(1, 10, 'alpha')]);
    const res = await get(`/curseforge/updates?profile=${profileId}`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'no_key' });
    expect(seen).toHaveLength(0);
  });

  it('reports the mods that have a newer release, ignoring betas, and counts the up-to-date ones', async () => {
    setSecret(dataDir, 'curseforge', 'cf-test-key-0123456789');
    storeSources(db, profileId, [source(1, 10, 'alpha'), source(2, 20, 'beta'), source(3, 30, 'gamma')]);
    answer = (url) => {
      if (url.includes('/mods/1/files')) return { status: 200, body: { data: [file(10, 1, '2026-01-01T00:00:00Z'), file(11, 1, '2026-02-01T00:00:00Z')] } };
      if (url.includes('/mods/2/files')) return { status: 200, body: { data: [file(20, 2, '2026-01-01T00:00:00Z'), file(21, 2, '2026-03-01T00:00:00Z', 2)] } }; // only a beta is newer
      return { status: 500, body: {} };
    };
    const res = await get(`/curseforge/updates?profile=${profileId}&gameVersion=1.21.1`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.updates).toEqual([
      { projectId: 1, name: 'alpha', url: 'https://www.curseforge.com/minecraft/mc-mods/alpha', installed: { fileId: 10, fileName: 'alpha-10.jar' }, latest: { id: 11, displayName: 'file 11', fileName: 'm1-11.jar', fileDate: '2026-02-01T00:00:00Z', releaseType: 1 } },
    ]);
    expect(body).toMatchObject({ checked: 3, upToDate: 1, gameVersion: '1.21.1' });
    expect(body.failed).toEqual([{ projectId: 3, name: 'gamma', code: 'unexpected' }]);
    expect(seen.every((s) => s.key === 'cf-test-key-0123456789')).toBe(true);
    expect(seen[0]!.url).toContain('gameVersion=1.21.1');
    expect(JSON.stringify(body)).not.toContain('cf-test-key');
  });

  it('stops and says so when CurseForge refuses the key', async () => {
    setSecret(dataDir, 'curseforge', 'cf-test-key-0123456789');
    storeSources(db, profileId, [source(1, 10, 'alpha')]);
    answer = () => ({ status: 403, body: {} });
    const res = await get(`/curseforge/updates?profile=${profileId}`);
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ code: 'rejected' });
  });

  it('says there is nothing to check for a profile without CurseForge data, and 404s an unknown profile', async () => {
    setSecret(dataDir, 'curseforge', 'cf-test-key-0123456789');
    expect((await get(`/curseforge/updates?profile=${profileId}`)).json()).toMatchObject({ noSources: true, checked: 0 });
    expect((await get('/curseforge/updates?profile=999')).statusCode).toBe(404);
  });
});

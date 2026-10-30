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

let db: Db;
let jobs: JobRunner;
let app: FastifyInstance;
let tmp: string;
let cookie: string;

beforeEach(async () => {
  db = openDb(':memory:');
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'profiles-api-'));
  jobs = new JobRunner(db);
  const config: Config = { bindHost: '127.0.0.1', port: 0, passwordHash: hashPassword('pw'), allowedHosts: [] };
  app = buildApp({ db, jobs, config, dataDir: path.join(tmp, 'data') });
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

const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, payload: payload as object, headers: { cookie } });
const dir = (name: string) => {
  const d = path.join(tmp, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const body = (over: object = {}) => ({ pack: 'Base', version: '1.0', side: 'client', state: 'launched', locationKind: 'folder', location: dir('inst'), ...over });
const create = async (over: object = {}) => (await call('POST', '/profiles', body(over))).json() as { id: number; version: string; location: string };

async function waitJob(jobId: string) {
  for (let i = 0; i < 200; i++) {
    const row = db.sqlite.prepare('SELECT status, message FROM job WHERE id = ?').get(jobId) as { status: string; message: string | null };
    if (!['queued', 'running'].includes(row.status)) return row;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('job timed out');
}
const addMod = (profileId: number) => {
  db.sqlite.prepare("INSERT OR IGNORE INTO jar (sha256, filename, size) VALUES ('h', 'a.jar', 1)").run();
  db.sqlite.prepare("INSERT INTO jar_mod (jar_sha256, profile_id, mod_id, version) VALUES ('h', ?, 'm', '1')").run(profileId);
};
const addIssue = (profileId: number) => db.sqlite.prepare("INSERT INTO import_issue (profile_id, file, reason) VALUES (?, 'x.jar', 'bad')").run(profileId);
const fakeJob = (lockKey: string) =>
  db.sqlite.prepare("INSERT INTO job (id, type, params, status, lock_key, created_at, updated_at) VALUES (?, 'import-modset', 'null', 'running', ?, 'now', 'now')").run(`j-${lockKey}`, lockKey);

describe('POST /profiles validation', () => {
  it('trims the version and rejects an empty or too long one', async () => {
    expect((await create({ version: '  8.3 ' })).version).toBe('8.3');
    expect((await call('POST', '/profiles', body({ version: '   ', side: 'server' }))).statusCode).toBe(400);
    expect((await call('POST', '/profiles', body({ version: 'v'.repeat(65), side: 'server' }))).statusCode).toBe(400);
  });
  it('rejects an unknown pack and the unreadable agent kind with 400', async () => {
    expect((await call('POST', '/profiles', body({ pack: 'Nope' }))).statusCode).toBe(400);
    expect((await call('POST', '/profiles', body({ locationKind: 'agent' }))).statusCode).toBe(400);
  });
  it('rejects relative and quoted paths with 400 and a code', async () => {
    for (const location of ['relative/dir', `"${dir('q')}"`]) {
      const res = await call('POST', '/profiles', body({ location }));
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'location_not_absolute' });
    }
  });
  it('rejects a missing path and a kind mismatch with 422 instead of 500', async () => {
    const missing = await call('POST', '/profiles', body({ location: path.join(tmp, 'missing') }));
    expect(missing.statusCode).toBe(422);
    expect(missing.json()).toMatchObject({ code: 'location_not_found' });
    const file = path.join(tmp, 'a.zip');
    fs.writeFileSync(file, 'x');
    const asFolder = await call('POST', '/profiles', body({ location: file, state: 'clean' }));
    expect(asFolder.statusCode).toBe(422);
    expect(asFolder.json()).toMatchObject({ code: 'location_wrong_kind' });
    expect((await call('POST', '/profiles', body({ locationKind: 'zip', location: dir('d') }))).statusCode).toBe(422);
  });
  it('accepts a run folder profile even when a process runs from it', async () => {
    expect((await call('POST', '/profiles', body({ state: 'run', location: process.cwd() }))).statusCode).toBe(201);
  });
});

describe('PATCH /profiles/:id', () => {
  it('relocates a profile and returns it', async () => {
    const p = await create();
    const to = dir('moved');
    const res = await call('PATCH', `/profiles/${p.id}`, { location: to });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: p.id, location: to });
  });
  it('validates like creation, 404 for an unknown id, 409 while a job runs', async () => {
    const p = await create();
    expect((await call('PATCH', `/profiles/${p.id}`, { location: 'rel' })).statusCode).toBe(400);
    expect((await call('PATCH', `/profiles/${p.id}`, { location: path.join(tmp, 'nope') })).statusCode).toBe(422);
    expect((await call('PATCH', '/profiles/999', { location: dir('x') })).statusCode).toBe(404);
    fakeJob(`import:${p.id}`);
    const res = await call('PATCH', `/profiles/${p.id}`, { location: dir('y') });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toHaveProperty('error');
  });
});

describe('DELETE /profiles/:id', () => {
  it('removes the profile and its rows, answers 204, then 404', async () => {
    const p = await create();
    addMod(p.id);
    addIssue(p.id);
    expect((await call('DELETE', `/profiles/${p.id}`)).statusCode).toBe(204);
    expect((db.sqlite.prepare('SELECT count(*) AS n FROM jar_mod').get() as { n: number }).n).toBe(0);
    expect((db.sqlite.prepare('SELECT count(*) AS n FROM import_issue').get() as { n: number }).n).toBe(0);
    expect((await call('GET', '/profiles/matrix')).json()).toEqual([]);
    expect((await call('DELETE', `/profiles/${p.id}`)).statusCode).toBe(404);
  });
  it('removes the configs scan cache of the profile too, and only that one', async () => {
    const p = await create();
    const other = await create({ version: '9.9' });
    const cache = path.join(tmp, 'data', 'cache');
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(path.join(cache, `configs-${p.id}.json`), '{}');
    fs.writeFileSync(path.join(cache, `configs-${other.id}.json`), '{}');
    expect((await call('DELETE', `/profiles/${p.id}`)).statusCode).toBe(204);
    expect(fs.existsSync(path.join(cache, `configs-${p.id}.json`))).toBe(false);
    expect(fs.existsSync(path.join(cache, `configs-${other.id}.json`))).toBe(true);
  });
  it('answers 409 while a job runs for it', async () => {
    const p = await create();
    fakeJob(`configs:${p.id}`);
    expect((await call('DELETE', `/profiles/${p.id}`)).statusCode).toBe(409);
  });
});

describe('import guard', () => {
  const importBody = (p: { location: string }) => ({ source: { kind: 'folder', path: p.location } });
  it('refuses a second import once complete, allows a retry when jars were skipped', async () => {
    const p = await create({ state: 'clean' });
    addMod(p.id);
    expect((await call('POST', `/profiles/${p.id}/import`, importBody(p))).statusCode).toBe(409);
    addIssue(p.id);
    const retry = await call('POST', `/profiles/${p.id}/import`, importBody(p));
    expect(retry.statusCode).toBe(202);
    await waitJob((retry.json() as { jobId: string }).jobId);
  });
  it('refuses a second import while one is running', async () => {
    const p = await create({ state: 'clean' });
    fakeJob(`import:${p.id}`);
    expect((await call('POST', `/profiles/${p.id}/import`, importBody(p))).statusCode).toBe(409);
  });
  it('re-checks when the job starts: a job queued on a complete immutable profile fails and leaves the snapshot alone', async () => {
    const p = await create({ state: 'clean' });
    addMod(p.id);
    const jobId = jobs.enqueue('import-modset', { profileId: p.id, source: { kind: 'folder', path: p.location } }, { lockKey: `import:${p.id}` });
    const job = await waitJob(jobId);
    expect(job.status).toBe('failed');
    expect(job.message).toMatch(/already imported/);
    expect((db.sqlite.prepare('SELECT count(*) AS n FROM jar_mod WHERE profile_id = ?').get(p.id) as { n: number }).n).toBe(1);
  });
});

describe('GET /profiles/matrix', () => {
  it('adds importedAt and importIssueCount to each profile', async () => {
    const p = await create();
    type Cells = { cells: Record<string, Record<string, unknown>> }[];
    let cell = ((await call('GET', '/profiles/matrix')).json() as Cells)[0]!.cells['client-launched']!;
    expect(cell).toMatchObject({ importedAt: null, importIssueCount: 0 });
    addMod(p.id);
    addIssue(p.id);
    cell = ((await call('GET', '/profiles/matrix')).json() as Cells)[0]!.cells['client-launched']!;
    expect(typeof cell.importedAt).toBe('string');
    expect(cell.importIssueCount).toBe(1);
  });
});

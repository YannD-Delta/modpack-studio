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

let db: Db;
let app: FastifyInstance;
let tmp: string;
let cookie: string;
let clean: number;
let launched: number;
let played: number;

const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => app.inject({ method, url: `/api/v1${url}`, payload: payload as object, headers: { cookie } });

function tree(name: string, files: Record<string, string>): string {
  const root = path.join(tmp, name);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

async function scan(profile: number) {
  const res = await call('POST', '/configs/scan', { profile, force: true });
  expect(res.statusCode).toBe(202);
  const jobId = (res.json() as { jobId: string }).jobId;
  for (let i = 0; i < 200; i++) {
    const row = (await call('GET', `/configs/scan/${jobId}`)).json() as { status: string };
    if (!['queued', 'running'].includes(row.status)) return row.status;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('scan timed out');
}

const profile = async (pack: string, state: string, location: string) => {
  const res = await call('POST', '/profiles', { pack, version: '8.3', side: 'client', state, locationKind: 'folder', location });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { id: number }).id;
};

beforeEach(async () => {
  db = openDb(':memory:');
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-'));
  const config: Config = { bindHost: '127.0.0.1', port: 0, passwordHash: hashPassword('pw'), allowedHosts: [] };
  app = buildApp({ db, jobs: new JobRunner(db), config, dataDir: path.join(tmp, 'data') });
  await app.ready();
  cookie = String((await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { password: 'pw' } })).headers['set-cookie']).split(';')[0]!;

  // clean: what the pack ships. launched: clean + generated files. played: launched + what the player did.
  const cleanDir = tree('clean', {
    'config/shipped-same.toml': 'a = 1\n',
    'config/shipped-edited.toml': 'volume = 50\n',
    'config/shipped-regen.toml': '# shipped\nx = 1\n',
    'config/shipped-reverted.toml': 'mode = "normal"\n',
    'kubejs/server_scripts/a.js': '// script\n',
  });
  const launchedDir = tree('launched', {
    'config/shipped-same.toml': 'a = 1\n',
    'config/shipped-edited.toml': 'volume = 50\n',
    'config/shipped-regen.toml': '# shipped\n# comment added by the mod\nx = 1\n', // the game rewrote it
    'config/shipped-reverted.toml': 'mode = "normal"\n# regenerated\n',
    'kubejs/server_scripts/a.js': '// script\n',
    'config/generated-same.toml': 'seed = 12\n',
    'config/generated-edited.toml': 'difficulty = "normal"\n',
    'config/generated-cosmetic.toml': 'a = 1\nb = 2\n',
    'config/generated-gone.toml': 'z = 0\n',
  });
  const playedDir = tree('played', {
    'config/shipped-same.toml': 'a = 1\n',
    'config/shipped-edited.toml': 'volume = 80\n', // touched: a file the pack ships
    'config/shipped-regen.toml': '# shipped\n# comment added by the mod\nx = 1\n', // same as launched: untouched
    'config/shipped-reverted.toml': 'mode = "normal"\n', // back to the clean content
    'kubejs/server_scripts/a.js': '// script\n',
    'config/generated-same.toml': 'seed = 12\n',
    'config/generated-edited.toml': 'difficulty = "hard"\n', // touched: a file the first launch generated
    'config/generated-cosmetic.toml': 'a = 1\r\nb = 2   \r\n', // only formatting
    'config/mine.toml': 'custom = true\n', // added by the player
    'config/old.toml.bak': 'ignored backup\n',
  });
  clean = await profile('LMP', 'clean', cleanDir);
  launched = await profile('LMP', 'launched', launchedDir);
  played = await profile('LMP', 'run', playedDir);
  for (const id of [clean, launched, played]) expect(await scan(id)).toBe('done');
});
afterEach(async () => {
  await app.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
afterAll(() => closePool());

const customizations = async (extra = '') => (await call('GET', `/configs/customizations?clean=${clean}&launched=${launched}&played=${played}${extra}`)).json();
const statusOf = (res: { files: { path: string; status: string }[] }) => Object.fromEntries(res.files.map((f) => [f.path, f.status]));

describe('customizations', () => {
  it('tells a changed generated file from a changed shipped file, an addition and a removal', async () => {
    const res = await customizations();
    expect(statusOf(res)).toEqual({
      'config/generated-edited.toml': 'modifiedGenerated',
      'config/shipped-edited.toml': 'modifiedShipped',
      'config/mine.toml': 'added',
      'config/generated-gone.toml': 'removed',
    });
  });

  it('counts what is untouched without listing it, and what has to go into the pack', async () => {
    const res = await customizations();
    expect(res.summary.perStatus).toEqual({ modifiedGenerated: 1, modifiedShipped: 1, added: 1, removed: 1, untouched: 6 });
    expect(res.summary.include).toBe(3);
    expect(res.summary.perRoot.config.modifiedGenerated).toBe(1);
    expect(res.files.find((f: { path: string }) => f.path === 'config/generated-edited.toml')).toMatchObject({ include: true, inClean: false, launchedSize: 22, playedSize: 20 });
    expect(res.files.find((f: { path: string }) => f.path === 'config/generated-gone.toml')).toMatchObject({ include: false });
  });

  it('lists the untouched files too when asked', async () => {
    const res = await customizations('&untouched=1');
    expect(statusOf(res)).toMatchObject({
      'config/shipped-same.toml': 'untouched',
      'config/shipped-regen.toml': 'untouched', // the game rewrote it at the first launch, the player did not
      'config/shipped-reverted.toml': 'untouched', // back to the clean content
      'config/generated-cosmetic.toml': 'untouched', // formatting only
      'config/generated-same.toml': 'untouched',
    });
    expect(Object.keys(statusOf(res))).not.toContain('config/old.toml.bak');
  });

  it('refuses the same profile twice and a profile that was never scanned', async () => {
    expect((await call('GET', `/configs/customizations?clean=${clean}&launched=${clean}&played=${played}`)).statusCode).toBe(400);
    const fresh = await profile('ATM10', 'clean', tree('fresh', { 'config/x.toml': 'x\n' }));
    expect((await call('GET', `/configs/customizations?clean=${fresh}&launched=${launched}&played=${played}`)).statusCode).toBe(409);
    expect((await call('GET', `/configs/customizations?clean=999&launched=${launched}&played=${played}`)).statusCode).toBe(404);
  });

  it('keeps the chosen files as a plan taken from the played instance, and rejects what does not need to travel', async () => {
    const ok = await call('PUT', '/configs/customizations/plan', { clean, launched, played, paths: ['config/generated-edited.toml', 'config/mine.toml'], selected: true });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().paths).toEqual(['config/generated-edited.toml', 'config/mine.toml']);
    // the plan lives on the pair (played -> launched): the export copies from the played side
    expect(((await call('GET', `/configs/plan?base=${played}&other=${launched}`)).json() as { paths: string[] }).paths).toEqual(['config/generated-edited.toml', 'config/mine.toml']);
    const bad = await call('PUT', '/configs/customizations/plan', { clean, launched, played, paths: ['config/shipped-same.toml', 'config/generated-gone.toml'], selected: true });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toContain('shipped-same.toml');
    expect((await call('PUT', '/configs/customizations/plan', { clean, launched, played, paths: ['config/mine.toml'], selected: false })).json().paths).toEqual(['config/generated-edited.toml']);
  });

  it('exports the chosen files from the played instance without needing the jars imported', async () => {
    await call('PUT', '/configs/customizations/plan', { clean, launched, played, paths: ['config/generated-edited.toml', 'config/mine.toml', 'config/shipped-edited.toml'], selected: true });
    const started = await call('POST', '/plan/export', { base: played, other: launched });
    expect(started.statusCode, started.body).toBe(202);
    const jobId = (started.json() as { jobId: string }).jobId;
    let job: { status: string; name?: string; message?: string | null } = { status: 'queued' };
    for (let i = 0; i < 200 && ['queued', 'running'].includes(job.status); i++) {
      await new Promise((r) => setTimeout(r, 50));
      job = (await call('GET', `/plan/jobs/${jobId}`)).json();
    }
    expect(job.status, JSON.stringify(job)).toBe('done');
    const name = job.name!;
    const folder = path.join(tmp, 'data', 'exports', name);
    expect(fs.readFileSync(path.join(folder, 'files-add', 'config', 'generated-edited.toml'), 'utf8')).toBe('difficulty = "hard"\n');
    expect(fs.readFileSync(path.join(folder, 'files-add', 'config', 'mine.toml'), 'utf8')).toBe('custom = true\n');
    expect(fs.readFileSync(path.join(folder, 'files-add', 'config', 'shipped-edited.toml'), 'utf8')).toBe('volume = 80\n');
  });
});

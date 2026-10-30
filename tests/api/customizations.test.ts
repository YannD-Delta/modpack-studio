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

function tree(name: string, files: Record<string, string | Buffer>): string {
  const root = path.join(tmp, name);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

async function scan(profile: number, deep = false) {
  const res = await call('POST', '/configs/scan', { profile, force: true, deep });
  expect(res.statusCode).toBe(202);
  const jobId = (res.json() as { jobId: string }).jobId;
  for (let i = 0; i < 200; i++) {
    const row = (await call('GET', `/configs/scan/${jobId}`)).json() as { status: string };
    if (!['queued', 'running'].includes(row.status)) return row.status;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('scan timed out');
}

const profile = async (pack: string, state: string, location: string, extra: { version?: string; side?: string } = {}) => {
  const res = await call('POST', '/profiles', { pack, version: '8.3', side: 'client', state, locationKind: 'folder', location, ...extra });
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
    'config/shipped-gone-edited.toml': 'k = 1\n', // shipped, removed by the first launch, edited when played
    'config/shipped-gone-same.toml': 'k = 1\n', // shipped, removed by the first launch, back to the shipped content when played
    'config/shipped-removed.toml': 'r = 1\n', // shipped and kept by the first launch, removed by the player
    'config/Case.toml': 'c = 1\n',
    'kubejs/assets/t.png': Buffer.from([1, 2, 3, 4]),
    'kubejs/assets/same.png': Buffer.from([5, 6, 7]),
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
    'config/shipped-removed.toml': 'r = 1\n',
    'config/case.toml': 'c = 1\n', // same file as the clean one, other spelling
    'kubejs/assets/t.png': Buffer.from([1, 2, 3, 4]),
    'kubejs/assets/same.png': Buffer.from([5, 6, 7]),
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
    'config/shipped-gone-edited.toml': 'k = 2\n',
    'config/shipped-gone-same.toml': 'k = 1\n',
    'config/CASE.toml': 'c = 1\n', // same file, third spelling
    'kubejs/assets/t.png': Buffer.from([1, 2, 3, 4, 5]), // a texture the player changed (other size)
    'kubejs/assets/same.png': Buffer.from([5, 6, 7]),
  });
  clean = await profile('Own', 'clean', cleanDir);
  launched = await profile('Own', 'launched', launchedDir);
  played = await profile('Own', 'run', playedDir);
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
      'config/shipped-gone-edited.toml': 'modifiedShipped', // in the clean pack, gone at the first launch, edited when played
      'kubejs/assets/t.png': 'modifiedShipped', // a binary the player changed
      'config/mine.toml': 'added',
      'config/generated-gone.toml': 'removed',
      'config/shipped-removed.toml': 'removed',
    });
  });

  it('pins the include flag and inClean of the rows around a shipped file', async () => {
    const res = await customizations();
    const row = (p: string) => res.files.find((f: { path: string }) => f.path === p);
    expect(row('config/shipped-gone-edited.toml')).toMatchObject({ status: 'modifiedShipped', inClean: true, include: true, launchedSize: null, playedSize: 6 });
    expect(row('kubejs/assets/t.png')).toMatchObject({ kind: 'binary', include: true, inClean: true, launchedSize: 4, playedSize: 5 });
    expect(row('config/shipped-removed.toml')).toMatchObject({ status: 'removed', inClean: true, include: false });
    const all = await customizations('&untouched=1');
    expect(statusOf(all)).toMatchObject({
      'config/shipped-gone-same.toml': 'untouched', // gone at launch, back to the shipped content when played
      'config/case.toml': 'untouched', // only the case of the path differs between the copies
      'kubejs/assets/same.png': 'untouched',
    });
  });

  it('does not list a texture as changed when the played copy was deep-scanned and the others quick-scanned', async () => {
    expect(await scan(played, true)).toBe('done');
    const res = await customizations('&untouched=1');
    expect(statusOf(res)['kubejs/assets/same.png']).toBe('untouched');
    expect(res.summary.include).toBe(5);
  });

  it('tells when each copy was scanned, since the analysis uses the last scan', async () => {
    const res = await customizations();
    for (const key of ['clean', 'launched', 'played']) expect(Date.parse(res.scannedAt[key]), key).not.toBeNaN();
  });

  it('counts what is untouched without listing it, and what has to go into the pack', async () => {
    const res = await customizations();
    expect(res.summary.perStatus).toEqual({ modifiedGenerated: 1, modifiedShipped: 3, added: 1, removed: 2, untouched: 9 });
    expect(res.summary.include).toBe(5);
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
    const v = { version: '9.0' };
    const fresh = {
      clean: await profile('Own', 'clean', tree('fresh-c', { 'config/x.toml': 'x\n' }), v),
      launched: await profile('Own', 'launched', tree('fresh-l', { 'config/x.toml': 'x\n' }), v),
      played: await profile('Own', 'run', tree('fresh-p', { 'config/x.toml': 'x\n' }), v),
    };
    const res = await call('GET', `/configs/customizations?clean=${fresh.clean}&launched=${fresh.launched}&played=${fresh.played}`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'not_scanned' });
    expect((await call('GET', `/configs/customizations?clean=999&launched=${launched}&played=${played}`)).statusCode).toBe(404);
  });

  describe('checks that the three copies are what they are declared to be', () => {
    const q = (c: number, l: number, p: number) => `/configs/customizations?clean=${c}&launched=${l}&played=${p}`;

    it('refuses a copy in the wrong state', async () => {
      const swapped = await call('GET', q(played, launched, clean));
      expect(swapped.statusCode).toBe(400);
      expect(swapped.json()).toMatchObject({ code: 'triad_state' });
      expect(swapped.json().error).toContain('clean');
      expect((await call('GET', q(launched, clean, played))).json()).toMatchObject({ code: 'triad_state' });
    });

    it('refuses copies of another side, pack or version', async () => {
      const server = await profile('Own', 'clean', tree('srv', { 'config/x.toml': 'x\n' }), { side: 'server' });
      const other = await profile('Base', 'run', tree('other', { 'config/x.toml': 'x\n' }));
      const old = await profile('Own', 'launched', tree('old', { 'config/x.toml': 'x\n' }), { version: '7.0' });
      for (const [c, l, p] of [[server, launched, played], [clean, launched, other], [clean, old, played]] as const) {
        const res = await call('GET', q(c, l, p));
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ code: 'triad_mismatch' });
      }
    });

    it('applies the same checks when the plan is saved', async () => {
      const res = await call('PUT', '/configs/customizations/plan', { clean: played, launched, played: clean, paths: ['config/mine.toml'], selected: true });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'triad_state' });
    });
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

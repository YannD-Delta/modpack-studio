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
import { importModSet } from '../../src/server/mods/import-modset.js';
import { makeJar } from '../fixtures-gen/jar.js';

let db: Db;
let app: FastifyInstance;
let cookie: string;
let tmp: string;
let dataDir: string;

const call = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) => app.inject({ method, url: `/api/v1${url}`, headers: { cookie }, payload: payload as object | undefined });

function tree(name: string, files: Record<string, string>): string {
  const root = path.join(tmp, name);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  fs.mkdirSync(root, { recursive: true });
  return root;
}

async function scan(profile: number) {
  const res = await call('POST', '/configs/scan', { profile, force: true });
  const jobId = (res.json() as { jobId: string }).jobId;
  for (let i = 0; i < 200; i++) {
    const row = (await call('GET', `/configs/scan/${jobId}`)).json() as { status: string };
    if (!['queued', 'running'].includes(row.status)) return row.status;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('scan timed out');
}

const profile = async (pack: string, version: string, state: string, dir: string) => {
  const res = await call('POST', '/profiles', { pack, version, side: 'client', state, locationKind: 'folder', location: dir });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { id: number }).id;
};

let clean: number;
let launched: number;
let candidate: number;
let newClean: number;
let projectId: number;
const triad = () => `clean=${clean}&launched=${launched}&candidate=${candidate}`;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  dataDir = path.join(tmp, 'data');
  db = openDb(':memory:');
  const config: Config = { bindHost: '127.0.0.1', port: 0, passwordHash: hashPassword('pw'), allowedHosts: [] };
  app = buildApp({ db, jobs: new JobRunner(db), config, dataDir });
  await app.ready();
  cookie = String((await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { password: 'pw' } })).headers['set-cookie']).split(';')[0]!;

  const cleanDir = tree('clean', { 'config/a.toml': 'a = 1\n', 'config/b.toml': 'b = 1\n', 'config/c.toml': 'c = 1\n' });
  const launchedDir = tree('launched', { 'config/a.toml': 'a = 1\n', 'config/b.toml': 'b = 1\n', 'config/c.toml': 'c = 1\n', 'config/gen.toml': 'g = 1\n' });
  const candidateDir = tree('candidate', { 'config/a.toml': 'a = 2\n', 'config/b.toml': 'b = 1\n', 'config/c.toml': 'c = 5\n', 'config/gen.toml': 'g = 1\n', 'config/mine.toml': 'mine = true\n' });
  // The new version of the base changed c.toml (which you also edited), left a.toml alone, and does not have mine.toml.
  const newDir = tree('new', { 'config/a.toml': 'a = 1\n', 'config/b.toml': 'b = 2\n', 'config/c.toml': 'c = 9\n' });
  clean = await profile('Base', '8.4', 'clean', cleanDir);
  launched = await profile('Base', '8.4', 'launched', launchedDir);
  candidate = await profile('Own', 'test-1', 'candidate', candidateDir);
  newClean = await profile('Base', '8.5', 'clean', newDir);
  for (const id of [clean, launched, candidate]) expect(await scan(id)).toBe('done');
  const created = await call('POST', '/projects', { name: 'My pack 2026' });
  expect(created.statusCode).toBe(201);
  projectId = created.json().id;
});
afterEach(async () => {
  await app.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
afterAll(() => closePool());

describe('projects', () => {
  it('creates a named project once', async () => {
    expect((await call('POST', '/projects', { name: 'my pack 2026' })).statusCode).toBe(409);
    expect((await call('POST', '/projects', { name: '   ' })).statusCode).toBe(400);
    const list = (await call('GET', '/projects')).json().projects as { name: string; changes: number }[];
    expect(list).toEqual([expect.objectContaining({ name: 'My pack 2026', changes: 0 })]);
  });

  it('proposes the config files you changed and the mods that differ, then keeps what you validate', async () => {
    const prop = (await call('GET', `/projects/${projectId}/proposal?${triad()}`)).json();
    expect(prop.files.map((f: { path: string; status: string }) => `${f.path}:${f.status}`).sort()).toEqual(['config/a.toml:modifiedShipped', 'config/c.toml:modifiedShipped', 'config/mine.toml:added']);
    expect(prop.files.every((f: { validated: boolean }) => !f.validated)).toBe(true);

    const saved = await call('POST', `/projects/${projectId}/changes`, { clean, launched, candidate, files: ['config/a.toml', 'config/c.toml', 'config/mine.toml'] });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({ files: 3, mods: 0 });
    expect(saved.json().changes).toHaveLength(3);
    // the content of your files is kept in Studio's data, so replaying never depends on the old instance
    expect(fs.existsSync(path.join(dataDir, 'blobs'))).toBe(true);
    const again = (await call('GET', `/projects/${projectId}/proposal?${triad()}`)).json();
    expect(again.files.every((f: { validated: boolean }) => f.validated)).toBe(true);
    expect((await call('GET', `/projects/${projectId}`)).json().project.baseVersion).toBe('8.4');
  });

  it('previews a new base version item by item: replay what is safe, flag what the base changed under you', async () => {
    await call('POST', `/projects/${projectId}/changes`, { clean, launched, candidate, files: ['config/a.toml', 'config/c.toml', 'config/mine.toml'] });
    const early = (await call('GET', `/projects/${projectId}/preview?newClean=${newClean}`)).json();
    expect(early.missing.scan).toBe(true);
    expect(early.items).toEqual([]);

    expect(await scan(newClean)).toBe('done');
    const prev = (await call('GET', `/projects/${projectId}/preview?newClean=${newClean}`)).json();
    const by = Object.fromEntries(prev.items.map((i: { key: string; status: string; reason: string }) => [i.key, `${i.status}:${i.reason}`]));
    expect(by).toEqual({
      'config/a.toml': 'safe:base-unchanged',
      'config/c.toml': 'conflict:base-changed',
      'config/mine.toml': 'safe:new-file',
    });
    expect(prev.summary).toEqual({ safe: 2, already: 0, conflict: 1, warning: 0 });
    expect(prev.missing).toEqual({ scan: false, import: false });
  });

  it('removes a validated change', async () => {
    const saved = (await call('POST', `/projects/${projectId}/changes`, { clean, launched, candidate, files: ['config/a.toml'] })).json();
    const changeId = saved.changes[0].id;
    expect((await call('DELETE', `/projects/${projectId}/changes/${changeId}`)).statusCode).toBe(204);
    expect((await call('GET', `/projects/${projectId}`)).json().changes).toEqual([]);
    expect((await call('DELETE', `/projects/${projectId}/changes/${changeId}`)).statusCode).toBe(404);
  });

  it('refuses wrong copies and files that are not retouches of the candidate', async () => {
    const wrong = await call('GET', `/projects/${projectId}/proposal?clean=${launched}&launched=${clean}&candidate=${candidate}`);
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toMatchObject({ code: 'triad_state' });
    const unknown = await call('POST', `/projects/${projectId}/changes`, { clean, launched, candidate, files: ['config/b.toml'] });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ code: 'unknown_change' });
    expect((await call('GET', `/projects/99/proposal?${triad()}`)).statusCode).toBe(404);
    expect((await call('GET', `/projects/${projectId}/preview?newClean=${candidate}`)).json()).toMatchObject({ code: 'triad_state' });
  });

  it('handles mods: what you added or replaced is replayed unless the new base moved the same mod', async () => {
    const jar = (id: string, version: string) => makeJar({ fileName: `${id}-${version}.jar`, loader: 'neoforge', mods: [{ modId: id, version }] });
    const modsDir = async (name: string, jars: [string, string][]) => {
      const dir = path.join(tmp, name);
      fs.mkdirSync(path.join(dir, 'mods'), { recursive: true });
      for (const [id, v] of jars) fs.writeFileSync(path.join(dir, 'mods', `${id}-${v}.jar`), await jar(id, v));
      return dir;
    };
    const ctx = { params: null, signal: new AbortController().signal, progress: () => undefined };
    const imp = async (id: number, dir: string) => importModSet(db, { kind: 'folder', path: dir }, id, ctx);
    await imp(clean, await modsDir('m-clean', [['x', '1.0'], ['y', '1.0']]));
    await imp(candidate, await modsDir('m-cand', [['x', '2.0'], ['y', '1.0'], ['mine', '1.0']]));
    await imp(newClean, await modsDir('m-new', [['x', '1.5'], ['y', '1.0']]));

    const prop = (await call('GET', `/projects/${projectId}/proposal?${triad()}`)).json();
    expect(prop.mods.map((m: { modId: string; action: string }) => `${m.modId}:${m.action}`).sort()).toEqual(['mine:add', 'x:update']);
    const saved = await call('POST', `/projects/${projectId}/changes`, { clean, launched, candidate, mods: ['x', 'mine'] });
    expect(saved.statusCode, saved.body).toBe(200);

    const prev = (await call('GET', `/projects/${projectId}/preview?newClean=${newClean}&oldClean=${clean}`)).json();
    const by = Object.fromEntries(prev.items.map((i: { key: string; status: string; reason: string }) => [i.key, `${i.status}:${i.reason}`]));
    expect(by).toEqual({ x: 'conflict:base-updated', mine: 'safe:new-mod' });
    expect(prev.baseDiff).toEqual({ added: 0, removed: 0, updated: 1 });
  });
});

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
import { addToBlacklist } from '../../src/server/mods/blacklist-service.js';
import { importModSet } from '../../src/server/mods/import-modset.js';
import { createProfile } from '../../src/server/profiles/profile-service.js';
import { makeJar } from '../fixtures-gen/jar.js';

let tmp: string;
let db: Db;
let app: FastifyInstance;
let cookie: string;
const ctx = { params: null, signal: new AbortController().signal, progress: () => undefined };

const put = (root: string, rel: string, content: string | Buffer) => {
  const full = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
};
const jar = (root: string, id: string) => makeJar({ fileName: `${id}-1.0.jar`, loader: 'neoforge', mods: [{ modId: id, version: '1.0' }] }).then((b) => put(root, `mods/${id}-1.0.jar`, b));

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'build-api-'));
  db = openDb(':memory:');
  const config: Config = { bindHost: '127.0.0.1', port: 0, passwordHash: hashPassword('pw'), allowedHosts: [] };
  app = buildApp({ db, jobs: new JobRunner(db), config, dataDir: path.join(tmp, 'data') });
  await app.ready();
  cookie = String((await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { password: 'pw' } })).headers['set-cookie']).split(';')[0]!;
});
afterEach(async () => {
  await app.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
afterAll(() => closePool());

const call = (method: 'GET' | 'POST', url: string, payload?: unknown) => app.inject({ method, url: `/api/v1${url}`, headers: { cookie }, payload: payload as object | undefined });

describe('POST /build/server-pack', () => {
  it('builds the pack and reports what was left out', async () => {
    const dir = path.join(tmp, 'server');
    await jar(dir, 'alpha');
    await jar(dir, 'clientonly');
    put(dir, 'config/a.toml', 'a');
    put(dir, 'eula.txt', 'eula=true');
    put(dir, 'run.bat', '@echo off');
    const p = createProfile(db, { pack: 'Own', version: 'My pack 2026', side: 'server', state: 'launched', locationKind: 'folder', location: dir });
    await importModSet(db, { kind: 'folder', path: dir }, p.id, ctx);
    addToBlacklist(db, 'clientonly', 'client side only');
    const res = await call('POST', '/build/server-pack', { profile: p.id });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mods).toBe(1);
    expect(body.leftOut).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'mod', key: 'clientonly' }), expect.objectContaining({ key: 'eula.txt' })]));
    expect(fs.existsSync(body.zip)).toBe(true);
    expect(fs.existsSync(path.join(body.folder, 'SERVER-PACK.md'))).toBe(true);
    expect(JSON.stringify(db.sqlite.prepare('SELECT action FROM audit_log').all())).toContain('build.server-pack');
  });

  it('answers readable errors', async () => {
    const dir = path.join(tmp, 'server');
    await jar(dir, 'alpha');
    const p = createProfile(db, { pack: 'Own', version: '1', side: 'server', state: 'launched', locationKind: 'folder', location: dir });
    expect((await call('POST', '/build/server-pack', { profile: p.id })).json()).toMatchObject({ code: 'not_imported' });
    expect((await call('POST', '/build/server-pack', { profile: 999 })).statusCode).toBe(404);
    expect((await call('POST', '/build/server-pack', { profile: 'x' })).statusCode).toBe(400);
  });
});

describe('client logs', () => {
  it('summarises the logs of a candidate and builds the Claude prompt', async () => {
    const dir = path.join(tmp, 'client');
    await jar(dir, 'alpha');
    put(dir, 'logs/latest.log', ['[10:00:01] [Render thread/INFO] [Minecraft/]: Reloading ResourceManager: vanilla', '[10:00:02] [main/ERROR] [mod_x/]: Failed to load mod_x'].join('\n'));
    put(dir, 'crash-reports/crash-1.txt', 'Description: Initializing game\n\njava.lang.Error: boom');
    const p = createProfile(db, { pack: 'Own', version: 'My pack 2026', side: 'client', state: 'candidate', locationKind: 'folder', location: dir });
    const res = await call('GET', `/testbench/client-logs?profile=${p.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ log: { present: true, errorLines: 1 }, crashReports: [{ headline: 'Initializing game: java.lang.Error: boom' }], mods: { count: 1 } });
    const prompt = await call('POST', '/testbench/client-logs/prompt', { profile: p.id });
    expect(prompt.json()).toMatchObject({ action: 'analyze-client-run' });
    expect(prompt.json().prompt).toContain('Failed to load mod_x');
  });

  it('refuses a profile that is not a candidate or run client', async () => {
    const dir = path.join(tmp, 'client');
    fs.mkdirSync(dir);
    const p = createProfile(db, { pack: 'Own', version: '1', side: 'client', state: 'launched', locationKind: 'folder', location: dir });
    expect((await call('GET', `/testbench/client-logs?profile=${p.id}`)).json()).toMatchObject({ code: 'wrong_state' });
    expect((await call('GET', '/testbench/client-logs?profile=999')).statusCode).toBe(404);
    expect((await call('GET', '/testbench/client-logs')).statusCode).toBe(400);
  });
});

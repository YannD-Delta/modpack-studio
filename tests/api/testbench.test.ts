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
import { createProfile } from '../../src/server/profiles/profile-service.js';

let tmp: string;
let db: Db;
let app: FastifyInstance;
let cookie: string;
let serverProfile: number;
let clientProfile: number;
let fake: { command: string; args: string[] };

function put(root: string, rel: string, content: string) {
  const full = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-api-'));
  const src = path.join(tmp, 'server-src');
  put(src, 'mods/a.jar', 'jar');
  put(src, 'eula.txt', 'eula=true\n');
  put(src, 'run.bat', '@echo off\r\n');
  const script = path.join(tmp, 'fake.cjs');
  fs.writeFileSync(
    script,
    [
      "console.log('[10:00:00] [main/INFO] [FML]: starting');",
      "console.log('[10:00:01] [main/WARN] [mixin]: odd');",
      "setTimeout(() => console.log('[10:00:02] [Server thread/INFO] [DedicatedServer]: Done (2.5s)! For help, type \"help\"'), 100);",
      "process.stdin.on('data', (d) => { if (String(d).includes('stop')) process.exit(0); });",
      'setInterval(() => {}, 1000);',
    ].join('\n'),
  );
  fake = { command: process.execPath, args: [script] };
  db = openDb(':memory:');
  const config: Config = { bindHost: '127.0.0.1', port: 0, passwordHash: hashPassword('pw'), allowedHosts: [] };
  app = buildApp({ db, jobs: new JobRunner(db), config, dataDir: path.join(tmp, 'data'), testBenchStartCommand: fake });
  await app.ready();
  cookie = String((await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { password: 'pw' } })).headers['set-cookie']).split(';')[0]!;
  serverProfile = createProfile(db, { pack: 'LMP', version: 'test', side: 'server', state: 'launched', locationKind: 'folder', location: src }).id;
  clientProfile = createProfile(db, { pack: 'LMP', version: 'test', side: 'client', state: 'launched', locationKind: 'folder', location: src }).id;
});
afterEach(async () => {
  await app.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
afterAll(() => closePool());

const call = (method: 'GET' | 'POST', url: string, payload?: unknown) => app.inject({ method, url: `/api/v1${url}`, headers: { cookie }, payload: payload as object | undefined });

async function waitFor<T>(fn: () => Promise<T | null | false>, ms = 15000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timeout waiting');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('testbench api', () => {
  it('starts a server test, follows it to the end and keeps the result and the log', async () => {
    const res = await call('POST', '/testbench/server', { profile: serverProfile, memoryMb: 1024, port: 25577, timeoutMin: 1 });
    expect(res.statusCode).toBe(202);
    const { runId } = res.json() as { runId: string };
    expect(runId).toMatch(/^\d{8}-\d{6}_LMP-test-launched$/);

    const done = await waitFor(async () => {
      const d = (await call('GET', `/testbench/runs/${runId}`)).json();
      return d.status === 'done' ? d : false;
    });
    expect(done.result.bootSeconds).toBeCloseTo(2.5, 3);
    expect(done.result.summary.warnLines).toBe(1);
    expect(done.meta).toMatchObject({ profileId: serverProfile, memoryMb: 1024, port: 25577 });

    const log = (await call('GET', `/testbench/runs/${runId}/log?tail=50`)).json();
    expect(log.lines.join('\n')).toContain('Done (2.5s)!');

    const list = (await call('GET', '/testbench/runs')).json();
    expect(list[0]).toMatchObject({ id: runId, status: 'done', bootSeconds: 2.5, errorLines: 0, warnLines: 1, crashReports: 0 });
    const audit = JSON.stringify(db.sqlite.prepare('SELECT action, target FROM audit_log').all());
    expect(audit).toContain('testbench.start');
    expect(audit).toContain('testbench.server');
  });

  it('refuses a client profile, a zip, an unknown profile and a missing folder', async () => {
    expect((await call('POST', '/testbench/server', { profile: clientProfile })).statusCode).toBe(409);
    expect((await call('POST', '/testbench/server', { profile: 999 })).statusCode).toBe(404);
    const zip = createProfile(db, { pack: 'ATM10', version: '8.3', side: 'server', state: 'clean', locationKind: 'zip', location: path.join(tmp, 'x.zip') }).id;
    expect((await call('POST', '/testbench/server', { profile: zip })).statusCode).toBe(409);
    const gone = createProfile(db, { pack: 'ATM10', version: '8.4', side: 'server', state: 'clean', locationKind: 'folder', location: path.join(tmp, 'missing') }).id;
    expect((await call('POST', '/testbench/server', { profile: gone })).statusCode).toBe(409);
  });

  it('validates the options', async () => {
    expect((await call('POST', '/testbench/server', { profile: serverProfile, memoryMb: 12 })).statusCode).toBe(400);
    expect((await call('POST', '/testbench/server', { profile: serverProfile, port: 80 })).statusCode).toBe(400);
  });

  it('reports a failure (EULA not accepted) as a failed run with its reason', async () => {
    fs.rmSync(path.join(tmp, 'server-src', 'eula.txt'));
    const { runId } = (await call('POST', '/testbench/server', { profile: serverProfile, timeoutMin: 1 })).json() as { runId: string };
    const failed = await waitFor(async () => {
      const d = (await call('GET', `/testbench/runs/${runId}`)).json();
      return d.status === 'failed' ? d : false;
    });
    expect(failed.message).toMatch(/EULA/);
  });

  it('answers 404 for an unknown run and refuses path tricks in the run id', async () => {
    expect((await call('GET', '/testbench/runs/nope')).statusCode).toBe(404);
    expect((await call('GET', '/testbench/runs/..%2F..%2Fsettings/log')).statusCode).toBe(404);
    expect((await call('GET', '/testbench/runs/x/log?tail=0')).statusCode).toBe(400);
  });

  it('cancels a run in progress', async () => {
    const { runId } = (await call('POST', '/testbench/server', { profile: serverProfile, timeoutMin: 5 })).json() as { runId: string };
    await waitFor(async () => (await call('GET', `/testbench/runs/${runId}`)).json().status === 'starting');
    expect((await call('POST', `/testbench/runs/${runId}/cancel`)).statusCode).toBe(200);
    await waitFor(async () => {
      const s = (await call('GET', `/testbench/runs/${runId}`)).json().status;
      return s === 'failed' || s === 'done';
    });
  });
});

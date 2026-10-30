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
import { markOrphanRuns } from '../../src/server/testbench/runs.js';

let tmp: string;
let db: Db;
let app: FastifyInstance;
let cookie: string;
let serverProfile: number;
let clientProfile: number;
let fake: { command: string; args: string[] };
let timings: { settleMs: number; stopGraceMs: number };

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
  timings = { settleMs: 50, stopGraceMs: 2000 };
  app = buildApp({ db, jobs: new JobRunner(db), config, dataDir: path.join(tmp, 'data'), testBenchStartCommand: fake, testBenchTimings: timings });
  await app.ready();
  cookie = String((await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { password: 'pw' } })).headers['set-cookie']).split(';')[0]!;
  serverProfile = createProfile(db, { pack: 'Own', version: 'test', side: 'server', state: 'launched', locationKind: 'folder', location: src }).id;
  clientProfile = createProfile(db, { pack: 'Own', version: 'test', side: 'client', state: 'launched', locationKind: 'folder', location: src }).id;
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
    expect(runId).toMatch(/^\d{8}-\d{6}_Own-test-launched$/);

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
    const zip = createProfile(db, { pack: 'Base', version: '8.3', side: 'server', state: 'clean', locationKind: 'zip', location: path.join(tmp, 'x.zip') }).id;
    expect((await call('POST', '/testbench/server', { profile: zip })).statusCode).toBe(409);
    const gone = createProfile(db, { pack: 'Base', version: '8.4', side: 'server', state: 'clean', locationKind: 'folder', location: path.join(tmp, 'missing') }).id;
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

  const runState = async (runId: string) => (await call('GET', `/testbench/runs/${runId}`)).json();
  const start = async (extra: Record<string, unknown> = {}) => (await call('POST', '/testbench/server', { profile: serverProfile, timeoutMin: 5, ...extra })).json() as { runId: string; jobId: string };

  it('cancels a run before Done: failed with a cancel message', async () => {
    const { runId } = await start();
    await waitFor(async () => (await runState(runId)).status === 'starting');
    expect((await call('POST', `/testbench/runs/${runId}/cancel`)).statusCode).toBe(200);
    const d = await waitFor(async () => {
      const r = await runState(runId);
      return r.result ? r : false;
    });
    expect(d.status).toBe('failed');
    expect(d.message).toMatch(/cancel/i);
  });

  it('cancels a run during the pause after Done, right away', async () => {
    timings.settleMs = 20_000;
    const { runId } = await start();
    await waitFor(async () => (await runState(runId)).status === 'ready');
    const t0 = Date.now();
    expect((await call('POST', `/testbench/runs/${runId}/cancel`)).statusCode).toBe(200);
    const d = await waitFor(async () => {
      const r = await runState(runId);
      return r.result ? r : false;
    });
    expect(d.status).toBe('failed');
    expect(d.message).toMatch(/cancel/i);
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it('refuses to cancel a run that is already finished, and leaves its result alone', async () => {
    const { runId } = await start();
    const done = await waitFor(async () => {
      const r = await runState(runId);
      return r.status === 'done' ? r : false;
    });
    const res = await call('POST', `/testbench/runs/${runId}/cancel`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'run-finished' });
    expect((await runState(runId)).result).toEqual(done.result);
  });

  it('a run cancelled while queued ends interrupted instead of staying queued forever', async () => {
    timings.settleMs = 20_000;
    const a = await start();
    const b = await start({ port: 25571 });
    expect(b.runId).not.toBe(a.runId);
    expect((await runState(b.runId)).status).toBe('queued');
    expect((await call('POST', `/testbench/runs/${b.runId}/cancel`)).statusCode).toBe(200);
    const dB = await runState(b.runId);
    expect(dB.status).toBe('interrupted');
    expect(dB.result.status).toBe('interrupted');
    expect((await call('POST', `/testbench/runs/${b.runId}/cancel`)).statusCode).toBe(409);
    expect((await call('GET', '/testbench/runs')).json().find((r: { id: string }) => r.id === b.runId).status).toBe('interrupted');
    await call('POST', `/testbench/runs/${a.runId}/cancel`);
  });

  it('a run left live by a previous process is interrupted at startup and when read', async () => {
    const dataDir = path.join(tmp, 'data');
    const runDir = path.join(dataDir, 'tests', 'old-run');
    put(runDir, 'meta.json', JSON.stringify({ id: 'old-run', profileId: serverProfile, label: 'Own', memoryMb: 1024, port: 25570, createdAt: '2020-01-01T00:00:00.000Z', jobId: null }));
    put(runDir, 'status.json', JSON.stringify({ status: 'ready', message: null, at: '2020-01-01T00:00:00.000Z' }));
    expect(markOrphanRuns(dataDir)).toBe(1);
    expect(markOrphanRuns(dataDir)).toBe(0); // finished runs are never rewritten
    const d = await runState('old-run');
    expect(d.status).toBe('interrupted');
    expect(d.message).toMatch(/restarted/);

    // same thing seen through the job row: the job was interrupted, the run left a live status behind
    const { runId, jobId } = await start();
    await waitFor(async () => (db.sqlite.prepare('SELECT status FROM job WHERE id = ?').get(jobId) as { status: string }).status === 'done');
    fs.rmSync(path.join(tmp, 'data', 'tests', runId, 'result.json'), { force: true });
    db.sqlite.prepare("UPDATE job SET status = 'interrupted' WHERE id = ?").run(jobId);
    expect((await runState(runId)).status).toBe('interrupted');
  });

  it('lists a run whose job was interrupted without a result as interrupted, and exposes the stop outcome of a finished one', async () => {
    const finished = await start();
    const done = await waitFor(async () => {
      const r = await runState(finished.runId);
      return r.result ? r : false;
    });
    expect(['clean', 'forced', 'exited-early']).toContain(done.result.stopOutcome);
    const { runId, jobId } = await start({ port: 25573 });
    await waitFor(async () => (db.sqlite.prepare('SELECT status FROM job WHERE id = ?').get(jobId) as { status: string }).status === 'done');
    fs.rmSync(path.join(tmp, 'data', 'tests', runId, 'result.json'), { force: true });
    fs.writeFileSync(path.join(tmp, 'data', 'tests', runId, 'status.json'), JSON.stringify({ status: 'starting', message: null, at: new Date().toISOString() }));
    db.sqlite.prepare("UPDATE job SET status = 'interrupted' WHERE id = ?").run(jobId);
    const listed = (await call('GET', '/testbench/runs')).json() as { id: string; status: string }[];
    expect(listed.find((r) => r.id === runId)?.status).toBe('interrupted');
  });

  it('gives two starts of the same profile in the same second different runs, and a double click only one job', async () => {
    timings.settleMs = 20_000;
    const first = await start();
    const doubleClick = await start();
    expect(doubleClick).toMatchObject({ runId: first.runId, jobId: first.jobId });
    const other = await start({ port: 25572 });
    expect(other.runId).not.toBe(first.runId);
    expect(other.jobId).not.toBe(first.jobId);
    const metaOf = (id: string) => JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'tests', id, 'meta.json'), 'utf8')) as { jobId: string };
    expect(metaOf(first.runId).jobId).toBe(first.jobId);
    expect(metaOf(other.runId).jobId).toBe(other.jobId);
    await call('POST', `/testbench/runs/${other.runId}/cancel`);
    await call('POST', `/testbench/runs/${first.runId}/cancel`);
  });

  it('removes the server copy after the run unless keepCopy is set', async () => {
    const { runId } = await start();
    await waitFor(async () => (await runState(runId)).status === 'done');
    expect(fs.existsSync(path.join(tmp, 'data', 'tests', runId, 'server'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'data', 'tests', runId, 'console.log'))).toBe(true);
    const kept = await start({ keepCopy: true, port: 25573 });
    await waitFor(async () => (await runState(kept.runId)).status === 'done');
    expect(fs.existsSync(path.join(tmp, 'data', 'tests', kept.runId, 'server', 'mods', 'a.jar'))).toBe(true);
  });
});

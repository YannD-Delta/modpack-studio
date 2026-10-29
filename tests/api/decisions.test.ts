import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/server/api/auth.js';
import { buildApp } from '../../src/server/api/app.js';
import type { Config } from '../../src/server/config.js';
import { openDb, type Db } from '../../src/server/db/open.js';
import { closePool } from '../../src/server/jobs/pool.js';
import { JobRunner } from '../../src/server/jobs/runner.js';
import { addToBlacklist, recomputeAtmDerived, setDecision } from '../../src/server/mods/blacklist-service.js';

let db: Db;
let app: FastifyInstance;
let cookie: string;
let config: Config;

beforeEach(async () => {
  db = openDb(':memory:');
  config = { bindHost: '127.0.0.1', port: 0, passwordHash: hashPassword('pw'), allowedHosts: [] };
  app = buildApp({ db, jobs: new JobRunner(db), config, dataDir: 'synthetic-data' });
  await app.ready();
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { password: 'pw' } });
  cookie = String(res.headers['set-cookie']).split(';')[0]!;
});
afterEach(async () => {
  await app.close();
  db.close();
});
afterAll(() => closePool());

const call = (method: 'GET' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, payload: payload as object, headers: { cookie } });

/** Two synthetic profiles with mods inserted straight into the tables (no jars on disk). */
function seedProfiles(): { base: number; other: number } {
  const pv = (pack: string, version: string) => Number(db.sqlite.prepare('INSERT INTO pack_version (pack, version) VALUES (?, ?)').run(pack, version).lastInsertRowid);
  const prof = (pvId: number) =>
    Number(db.sqlite.prepare("INSERT INTO profile (pack_version_id, side, state, location_kind, location) VALUES (?, 'client', 'clean', 'folder', 'synthetic')").run(pvId).lastInsertRowid);
  const base = prof(pv('Base', '8.3'));
  const other = prof(pv('Own', '1.0'));
  const mod = (profileId: number, modId: string, version: string) => {
    const sha = `${modId}-${version}-${profileId}`;
    db.sqlite.prepare('INSERT OR IGNORE INTO jar (sha256, filename, size) VALUES (?, ?, 1)').run(sha, `${modId}-${version}.jar`);
    db.sqlite.prepare('INSERT INTO jar_mod (jar_sha256, profile_id, mod_id, version) VALUES (?, ?, ?, ?)').run(sha, profileId, modId, version);
  };
  mod(base, 'old', '2.0');
  mod(other, 'old', '1.0');
  return { base, other };
}

describe('decisions api', () => {
  it('requires a session', async () => {
    for (const url of ['/decisions', '/debug/audit', '/debug/jobs', '/debug/info']) {
      expect((await app.inject({ method: 'GET', url: `/api/v1${url}` })).statusCode).toBe(401);
    }
  });

  it('lists decisions and only user blacklist rows', async () => {
    setDecision(db, { modId: 'old', kind: 'pin', reason: 'keep 1.0' });
    setDecision(db, { modId: 'hud', kind: 'side', side: 'client', reason: '' });
    addToBlacklist(db, 'mine', 'crash');
    recomputeAtmDerived(db, '8.3', ['cli']);
    const res = await call('GET', '/decisions');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.decisions.map((d: { modId: string; kind: string; side: string | null }) => [d.modId, d.kind, d.side])).toEqual([
      ['hud', 'side', 'client'],
      ['old', 'pin', null],
    ]);
    expect(body.blacklist.map((b: { modId: string; origin: string }) => [b.modId, b.origin])).toEqual([['mine', 'user']]);
    expect(body.atmDerivedCount).toBe(1);
  });

  it('undoing a pin takes effect on the next diff', async () => {
    const { base, other } = seedProfiles();
    setDecision(db, { modId: 'old', kind: 'pin', reason: '' });
    const diff = async () => (await call('GET', `/mods/diff?base=${base}&other=${other}`)).json();
    expect((await diff()).updated).toEqual([]);

    const res = await call('DELETE', '/decisions/old/pin');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect((await diff()).updated.map((u: { modId: string; direction: string }) => [u.modId, u.direction])).toEqual([['old', 'older']]);
    const audited = db.sqlite.prepare("SELECT target FROM audit_log WHERE action = 'decision.unset'").all();
    expect(audited).toEqual([{ target: 'old' }]);
  });

  it('undoing a client side decision takes the mod off the blacklist at once', async () => {
    setDecision(db, { modId: 'hud', kind: 'side', side: 'client', reason: '' });
    const list = async () => (await call('GET', '/blacklist?atmVersion=8.3')).json().map((e: { modId: string }) => e.modId);
    expect(await list()).toEqual(['hud']);
    expect((await call('DELETE', '/decisions/hud/side')).statusCode).toBe(200);
    expect(await list()).toEqual([]);
  });

  it('returns 404 for an absent decision and 400 for an unknown kind', async () => {
    expect((await call('DELETE', '/decisions/nope/pin')).statusCode).toBe(404);
    expect((await call('DELETE', '/decisions/nope/banana')).statusCode).toBe(400);
  });

  it('decodes a mod id with special characters', async () => {
    setDecision(db, { modId: 'a b:c', kind: 'ignore', reason: '' });
    expect((await call('DELETE', `/decisions/${encodeURIComponent('a b:c')}/ignore`)).statusCode).toBe(200);
  });

  it('edits a reason, validates it and audits it', async () => {
    setDecision(db, { modId: 'old', kind: 'pin', reason: 'before' });
    expect((await call('PUT', '/decisions/old/pin/reason', { reason: 'after' })).statusCode).toBe(200);
    expect((await call('GET', '/decisions')).json().decisions[0].reason).toBe('after');
    expect(db.sqlite.prepare("SELECT target FROM audit_log WHERE action = 'decision.reason'").all()).toEqual([{ target: 'old' }]);

    expect((await call('PUT', '/decisions/old/pin/reason', { reason: 'x'.repeat(501) })).statusCode).toBe(400);
    expect((await call('PUT', '/decisions/old/pin/reason', {})).statusCode).toBe(400);
    expect((await call('PUT', '/decisions/old/pin/reason', { reason: '' })).statusCode).toBe(200);
    expect((await call('PUT', '/decisions/nope/pin/reason', { reason: 'y' })).statusCode).toBe(404);
  });

  it('edits the reason of a user blacklist entry only', async () => {
    addToBlacklist(db, 'mine', 'before');
    recomputeAtmDerived(db, '8.3', ['cli']);
    expect((await call('PUT', '/blacklist/entry/mine/reason', { reason: 'after' })).statusCode).toBe(200);
    expect((await call('GET', '/decisions')).json().blacklist[0].reason).toBe('after');
    expect((await call('PUT', '/blacklist/entry/cli/reason', { reason: 'x' })).statusCode).toBe(409);
    expect((await call('PUT', '/blacklist/entry/nope/reason', { reason: 'x' })).statusCode).toBe(404);
    expect((await call('PUT', '/blacklist/entry/mine/reason', { reason: 'x'.repeat(501) })).statusCode).toBe(400);
  });

  it('removes only user blacklist entries', async () => {
    addToBlacklist(db, 'mine', '');
    recomputeAtmDerived(db, '8.3', ['cli']);
    expect((await call('DELETE', '/blacklist/entry/mine')).statusCode).toBe(200);
    expect((await call('DELETE', '/blacklist/entry/mine')).statusCode).toBe(404);
    expect((await call('DELETE', '/blacklist/entry/cli')).statusCode).toBe(409);
    expect((await call('GET', '/blacklist?atmVersion=8.3')).json().map((e: { modId: string }) => e.modId)).toEqual(['cli']);
    expect(db.sqlite.prepare("SELECT target FROM audit_log WHERE action = 'blacklist.remove'").all()).toEqual([{ target: 'mine' }]);
  });
});

describe('debug api', () => {
  it('pages the audit log and filters it', async () => {
    for (let i = 1; i <= 5; i++) addToBlacklist(db, `mod${i}`, '');
    const first = (await call('GET', '/debug/audit?limit=2')).json();
    expect(first.entries.map((e: { target: string }) => e.target)).toEqual(['mod5', 'mod4']);
    expect(first.entries[0].payload).toEqual({ reason: '' });
    const next = (await call('GET', `/debug/audit?limit=2&before=${first.nextBefore}`)).json();
    expect(next.entries.map((e: { target: string }) => e.target)).toEqual(['mod3', 'mod2']);
    expect((await call('GET', '/debug/audit?q=mod1')).json().entries.map((e: { target: string }) => e.target)).toEqual(['mod1']);
    expect((await call('GET', '/debug/audit')).json().entries).toHaveLength(5);
  });

  it('validates the audit and jobs queries', async () => {
    expect((await call('GET', '/debug/audit?limit=501')).statusCode).toBe(400);
    expect((await call('GET', '/debug/audit?limit=0')).statusCode).toBe(400);
    expect((await call('GET', '/debug/audit?before=abc')).statusCode).toBe(400);
    expect((await call('GET', '/debug/audit?q=' + 'x'.repeat(201))).statusCode).toBe(400);
    expect((await call('GET', '/debug/jobs?status=exploded')).statusCode).toBe(400);
    expect((await call('GET', '/debug/jobs?limit=501')).statusCode).toBe(400);
  });

  it('lists jobs with a status filter', async () => {
    db.sqlite
      .prepare("INSERT INTO job (id, type, params, status, message, created_at, updated_at) VALUES ('j1', 'import', '{}', 'failed', 'bad jar', '2026-01-01', '2026-01-01'), ('j2', 'import', '{}', 'done', NULL, '2026-01-02', '2026-01-02')")
      .run();
    const all = (await call('GET', '/debug/jobs')).json();
    expect(all.jobs.map((j: { id: string }) => j.id)).toEqual(['j2', 'j1']);
    const failed = (await call('GET', '/debug/jobs?status=failed')).json();
    expect(failed.jobs).toEqual([expect.objectContaining({ id: 'j1', status: 'failed', message: 'bad jar' })]);
  });

  it('reports app facts and never leaks config or session material', async () => {
    const res = await call('GET', '/debug/info');
    expect(res.statusCode).toBe(200);
    const info = res.json();
    expect(info.node).toBe(process.version);
    expect(info.dataDir).toMatch(/synthetic-data$/);
    expect(info.counts.jobs).toHaveProperty('interrupted', 0);
    const text = res.body;
    expect(text).not.toContain(config.passwordHash!);
    expect(text).not.toContain(cookie.split('=')[1]!);
    expect(text).not.toMatch(/passwordHash|allowedHosts|lanIp|session/i);
  });
});

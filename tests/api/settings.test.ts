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
import { getSecret } from '../../src/server/settings/secrets-store.js';

const CLAUDE_KEY = 'sk-test-claude-0123456789abcdef';
const CF_KEY = '$2a$10$synthetic.curseforge.key.value';

let db: Db;
let app: FastifyInstance;
let cookie: string;
let dataDir: string;
let calls: { url: string; headers: Record<string, string> }[];
let reply: { status: number } | 'throw';

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-settings-'));
  calls = [];
  reply = { status: 200 };
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    if (reply === 'throw') throw new Error('connect ECONNREFUSED');
    return new Response('{}', { status: reply.status });
  }) as typeof fetch;
  db = openDb(':memory:');
  const config: Config = { bindHost: '127.0.0.1', port: 0, passwordHash: hashPassword('pw'), allowedHosts: [] };
  app = buildApp({ db, jobs: new JobRunner(db), config, dataDir, fetchImpl });
  await app.ready();
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { password: 'pw' } });
  cookie = String(res.headers['set-cookie']).split(';')[0]!;
});
afterEach(async () => {
  await app.close();
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
afterAll(() => closePool());

const call = (method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { cookie }, payload: payload as object | undefined });

describe('settings api', () => {
  it('requires a session', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/settings' })).statusCode).toBe(401);
  });

  it('starts with nothing configured and the default assistant preferences', async () => {
    const s = (await call('GET', '/settings')).json();
    expect(s.keys).toEqual({ claude: { configured: false, last4: null }, curseforge: { configured: false, last4: null } });
    expect(s.assistant).toEqual({ model: 'claude-sonnet-5-5', effort: 'medium' });
    expect(s.models.map((m: { id: string }) => m.id)).toContain('claude-sonnet-5-5');
  });

  it('stores a key on disk, reports only its last 4 characters and never returns it', async () => {
    const put = await call('PUT', '/settings/keys', { provider: 'claude', key: CLAUDE_KEY });
    expect(put.statusCode).toBe(200);
    expect(put.body).not.toContain(CLAUDE_KEY);
    const get = await call('GET', '/settings');
    expect(get.body).not.toContain(CLAUDE_KEY);
    expect(get.json().keys.claude).toEqual({ configured: true, last4: CLAUDE_KEY.slice(-4) });
    expect(getSecret(dataDir, 'claude')).toBe(CLAUDE_KEY);
    expect(get.json().keys.curseforge.configured).toBe(false);
  });

  it('keeps the key out of the audit log and the debug journal', async () => {
    await call('PUT', '/settings/keys', { provider: 'curseforge', key: CF_KEY });
    const rows = db.sqlite.prepare('SELECT action, target, detail FROM audit_log').all() as { action: string; target: string; detail: string }[];
    expect(rows.some((r) => r.action === 'settings.key_set' && r.target === 'curseforge')).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(CF_KEY);
    const journal = (await call('GET', '/debug/audit?limit=50')).body;
    expect(journal).not.toContain(CF_KEY);
    expect((await call('GET', '/debug/info')).body).not.toContain(CF_KEY);
  });

  it.each([
    ['too short', 'abc'],
    ['contains a space', 'sk-test with space-0123456789'],
    ['contains a newline', 'sk-test-0123456789\nabc'],
    ['non-ASCII', 'sk-tést-0123456789abcdef'],
  ])('rejects a key that %s without storing it', async (_label, key) => {
    const res = await call('PUT', '/settings/keys', { provider: 'claude', key });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain(key);
    expect(getSecret(dataDir, 'claude')).toBeNull();
  });

  it('rejects an unknown provider', async () => {
    expect((await call('PUT', '/settings/keys', { provider: 'openai', key: CLAUDE_KEY })).statusCode).toBe(400);
  });

  it('removes a key when asked, and keeps the other one', async () => {
    await call('PUT', '/settings/keys', { provider: 'claude', key: CLAUDE_KEY });
    await call('PUT', '/settings/keys', { provider: 'curseforge', key: CF_KEY });
    expect((await call('DELETE', '/settings/keys/claude')).statusCode).toBe(200);
    const s = (await call('GET', '/settings')).json();
    expect(s.keys.claude.configured).toBe(false);
    expect(s.keys.curseforge.configured).toBe(true);
    expect(getSecret(dataDir, 'claude')).toBeNull();
    expect(getSecret(dataDir, 'curseforge')).toBe(CF_KEY);
  });

  it('tests the Claude key against the Anthropic API with the right headers', async () => {
    await call('PUT', '/settings/keys', { provider: 'claude', key: CLAUDE_KEY });
    const res = await call('POST', '/settings/keys/test', { provider: 'claude' });
    expect(res.json()).toEqual({ ok: true, code: 'ok' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.startsWith('https://api.anthropic.com/v1/models')).toBe(true);
    expect(calls[0]!.headers['x-api-key']).toBe(CLAUDE_KEY);
    expect(calls[0]!.headers['anthropic-version']).toBe('2023-06-01');
  });

  it('tests the CurseForge key against the CurseForge API', async () => {
    await call('PUT', '/settings/keys', { provider: 'curseforge', key: CF_KEY });
    expect((await call('POST', '/settings/keys/test', { provider: 'curseforge' })).json()).toEqual({ ok: true, code: 'ok' });
    expect(calls[0]!.url.startsWith('https://api.curseforge.com/v1/games')).toBe(true);
    expect(calls[0]!.headers['x-api-key']).toBe(CF_KEY);
  });

  it.each([
    [401, 'rejected'],
    [403, 'rejected'],
    [500, 'unexpected'],
  ])('maps an API answer of %i to %s without echoing the key', async (status, code) => {
    await call('PUT', '/settings/keys', { provider: 'claude', key: CLAUDE_KEY });
    reply = { status };
    const res = await call('POST', '/settings/keys/test', { provider: 'claude' });
    expect(res.json()).toEqual({ ok: false, code, status });
    expect(res.body).not.toContain(CLAUDE_KEY);
  });

  it('reports an unreachable API and a missing key', async () => {
    expect((await call('POST', '/settings/keys/test', { provider: 'claude' })).json()).toEqual({ ok: false, code: 'not_configured' });
    expect(calls).toHaveLength(0);
    await call('PUT', '/settings/keys', { provider: 'claude', key: CLAUDE_KEY });
    reply = 'throw';
    const res = await call('POST', '/settings/keys/test', { provider: 'claude' });
    expect(res.json()).toEqual({ ok: false, code: 'unreachable' });
    expect(res.body).not.toContain(CLAUDE_KEY);
  });

  it('saves the assistant model and effort, and validates them', async () => {
    expect((await call('PUT', '/settings/assistant', { model: 'claude-opus-5-5', effort: 'high' })).statusCode).toBe(200);
    expect((await call('GET', '/settings')).json().assistant).toEqual({ model: 'claude-opus-5-5', effort: 'high' });
    expect((await call('PUT', '/settings/assistant', { model: 'claude-opus-5-5', effort: 'extreme' })).statusCode).toBe(400);
    expect((await call('PUT', '/settings/assistant', { model: 'gpt-9', effort: 'low' })).statusCode).toBe(400);
    expect((await call('GET', '/settings')).json().assistant.effort).toBe('high');
  });
});

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
    calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    if (reply === 'throw') throw new Error('connect ECONNREFUSED');
    const body = String(url).includes('anthropic') ? { data: [], has_more: false, first_id: null, last_id: null } : {};
    return new Response(JSON.stringify(body), { status: reply.status, headers: { 'content-type': 'application/json' } });
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
  it('never overwrites an unreadable preferences file: the save is refused and a copy is kept aside', async () => {
    const file = path.join(dataDir, 'preferences.json');
    fs.writeFileSync(file, '{ "packs": { "upstream": "Alpha Pack", ');
    const res = await call('PUT', '/settings/assistant', { model: 'claude-opus-5-5', effort: 'high' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ code: 'settings_unreadable' });
    expect(fs.readFileSync(file, 'utf8')).toBe('{ "packs": { "upstream": "Alpha Pack", ');
    expect(fs.readdirSync(dataDir).some((f) => f.startsWith('preferences.json.corrupt-'))).toBe(true);
    expect((await call('GET', '/settings')).statusCode).toBe(200); // reading still works, on defaults
  });

  it('refuses to rename the packs when the preferences file is unreadable, and leaves the rows alone', async () => {
    fs.writeFileSync(path.join(dataDir, 'preferences.json'), 'oops');
    const res = await call('PUT', '/settings/packs', { upstream: 'Alpha Pack', own: 'Beta Pack' });
    expect(res.statusCode).toBe(500);
    expect(res.json().code).toBe('settings_unreadable');
  });

  it('reads a preferences file saved with a UTF-8 BOM and keeps the other sections on save', async () => {
    fs.writeFileSync(path.join(dataDir, 'preferences.json'), '﻿' + JSON.stringify({ packs: { upstream: 'Alpha Pack', own: 'Beta Pack' } }));
    expect((await call('GET', '/settings')).json().packs).toEqual({ upstream: 'Alpha Pack', own: 'Beta Pack' });
    expect((await call('PUT', '/settings/assistant', { model: 'claude-opus-5-5', effort: 'high' })).statusCode).toBe(200);
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'preferences.json'), 'utf8')).packs.upstream).toBe('Alpha Pack');
  });

  it('refuses to save a key over an unreadable secrets file', async () => {
    const file = path.join(dataDir, 'secrets.json');
    fs.writeFileSync(file, '{ not json');
    const res = await call('PUT', '/settings/keys', { provider: 'curseforge', key: CF_KEY });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain(CF_KEY);
    expect(fs.readFileSync(file, 'utf8')).toBe('{ not json');
  });

  it('leaves no temporary file behind after a save', async () => {
    await call('PUT', '/settings/assistant', { model: 'claude-opus-5-5', effort: 'high' });
    expect(fs.readdirSync(dataDir).filter((f) => f.endsWith('.part'))).toEqual([]);
  });

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
    // the official SDK sends the key as a bearer token and picks the API version itself
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${CLAUDE_KEY}`);
    expect(calls[0]!.headers['anthropic-version']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
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

  it('names the two packs Base and Own by default and lets Settings rename them, existing profiles included', async () => {
    expect((await call('GET', '/settings')).json().packs).toEqual({ upstream: 'Base', own: 'Own' });
    const mk = (pack: string, state: string) => db.sqlite.prepare('INSERT INTO pack_version (pack, version) VALUES (?, ?)').run(pack, state);
    mk('Base', '8.3');
    mk('Own', '1.0');
    const res = await call('PUT', '/settings/packs', { upstream: 'Alpha Pack', own: 'Beta Pack' });
    expect(res.statusCode).toBe(200);
    expect((await call('GET', '/settings')).json().packs).toEqual({ upstream: 'Alpha Pack', own: 'Beta Pack' });
    expect((db.sqlite.prepare('SELECT pack FROM pack_version ORDER BY id').all() as { pack: string }[]).map((r) => r.pack)).toEqual(['Alpha Pack', 'Beta Pack']);
    expect(JSON.stringify(db.sqlite.prepare('SELECT action, detail FROM audit_log').all())).toContain('settings.packs');
  });

  it('lets the two names swap places without mixing the profiles up', async () => {
    db.sqlite.prepare('INSERT INTO pack_version (pack, version) VALUES (?, ?)').run('Base', '8.3');
    db.sqlite.prepare('INSERT INTO pack_version (pack, version) VALUES (?, ?)').run('Own', '1.0');
    expect((await call('PUT', '/settings/packs', { upstream: 'Own', own: 'Base' })).statusCode).toBe(200);
    expect((db.sqlite.prepare('SELECT pack, version FROM pack_version ORDER BY id').all() as { pack: string; version: string }[])).toEqual([{ pack: 'Own', version: '8.3' }, { pack: 'Base', version: '1.0' }]);
  });

  it.each([
    ['empty', { upstream: '', own: 'X' }],
    ['the same name twice (any case)', { upstream: 'Pack', own: 'pack' }],
    ['a symbol', { upstream: 'A/B', own: 'C' }],
    ['too long', { upstream: 'x'.repeat(41), own: 'C' }],
  ])('rejects pack names that are %s and changes nothing', async (_l, body) => {
    expect((await call('PUT', '/settings/packs', body)).statusCode).toBe(400);
    expect((await call('GET', '/settings')).json().packs).toEqual({ upstream: 'Base', own: 'Own' });
  });

  it('only accepts profiles of one of the two configured packs, and follows a rename', async () => {
    const zipA = path.join(dataDir, 'a.zip');
    const zipB = path.join(dataDir, 'b.zip');
    fs.writeFileSync(zipA, 'x');
    fs.writeFileSync(zipB, 'x');
    const mkProfile = (pack: string) => call('POST', '/profiles', { pack, version: '1', side: 'client', state: 'clean', locationKind: 'zip', location: zipA });
    expect((await mkProfile('Other')).statusCode).toBe(400);
    expect((await mkProfile('Base')).statusCode).toBe(201);
    await call('PUT', '/settings/packs', { upstream: 'Followed', own: 'Mine' });
    expect((await mkProfile('Base')).statusCode).toBe(400);
    expect((await call('POST', '/profiles', { pack: 'Mine', version: '2', side: 'client', state: 'clean', locationKind: 'zip', location: zipB })).statusCode).toBe(201);
    const matrix = (await call('GET', '/profiles/matrix')).json() as { pack: string }[];
    expect(matrix.map((m) => m.pack)).toEqual(['Followed', 'Mine']);
  });
});

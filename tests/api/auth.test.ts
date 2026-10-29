import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/api/app.js';
import { hashPassword, verifyPassword } from '../../src/server/api/auth.js';
import { loadConfig, type Config } from '../../src/server/config.js';
import { openDb, type Db } from '../../src/server/db/open.js';
import { JobRunner } from '../../src/server/jobs/runner.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let db: Db;
let jobs: JobRunner;
let app: FastifyInstance;
let config: Config;

beforeEach(async () => {
  db = openDb(':memory:');
  jobs = new JobRunner(db);
  config = { bindHost: '127.0.0.1', port: 0, passwordHash: hashPassword('secret'), allowedHosts: [] };
  app = buildApp({ db, jobs, config });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  db.close();
});

const login = (password: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { password }, headers });

describe('password hashing', () => {
  it('verifies the right password and rejects the wrong one', () => {
    const h = hashPassword('pw');
    expect(verifyPassword('pw', h)).toBe(true);
    expect(verifyPassword('other', h)).toBe(false);
    expect(h).not.toContain('pw');
  });
});

describe('config', () => {
  it('applies defaults when settings.json is missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
    expect(loadConfig(dir)).toMatchObject({ bindHost: '127.0.0.1', port: 8480 });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('auth and request guards', () => {
  it('serves /health without a session', async () => {
    expect((await app.inject({ url: '/api/v1/health' })).statusCode).toBe(200);
  });

  it('returns 401 on a protected route without a session', async () => {
    expect((await app.inject({ url: '/api/v1/auth/me' })).statusCode).toBe(401);
  });

  it('returns 403 when Origin does not match Host', async () => {
    const res = await login('secret', { origin: 'http://evil.example' });
    expect(res.statusCode).toBe(403);
  });

  it('returns 403 for an unknown Host header (DNS rebinding)', async () => {
    const res = await app.inject({ url: '/api/v1/health', headers: { host: 'evil.example' } });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a wrong password with 401 and rate-limits the sixth attempt with 429', async () => {
    for (let i = 0; i < 5; i++) expect((await login('wrong')).statusCode).toBe(401);
    expect((await login('wrong')).statusCode).toBe(429);
  });

  it('sets an HttpOnly SameSite=Strict cookie on success, then allows /auth/me and logout', async () => {
    const res = await login('secret');
    expect(res.statusCode).toBe(200);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    const session = cookie.split(';')[0]!;
    expect((await app.inject({ url: '/api/v1/auth/me', headers: { cookie: session } })).statusCode).toBe(200);
    await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: session } });
    expect((await app.inject({ url: '/api/v1/auth/me', headers: { cookie: session } })).statusCode).toBe(401);
  });

  it('streams job events over SSE to an authenticated client', async () => {
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`${address}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'secret' }) });
    const session = res.headers.get('set-cookie')!.split(';')[0]!;
    const ctrl = new AbortController();
    const stream = await fetch(`${address}/api/v1/events`, { headers: { cookie: session }, signal: ctrl.signal });
    expect(stream.headers.get('content-type')).toContain('text/event-stream');

    jobs.register('noop', async () => undefined);
    jobs.enqueue('noop', null);
    const reader = stream.body!.getReader();
    let text = '';
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !(text.includes('"queued"') && text.includes('"done"'))) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    ctrl.abort();
    expect(text).toContain('"queued"');
    expect(text).toContain('"done"');
  });
});

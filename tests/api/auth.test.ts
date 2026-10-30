import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { buildApp } from '../../src/server/api/app.js';
import { hashPassword, needsRehash, PASSWORD_COST, verifyPassword } from '../../src/server/api/auth.js';
import { loadConfig, writeSettingsPassword, type Config } from '../../src/server/config.js';
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
    const pw = 'correct horse battery staple';
    const h = hashPassword(pw);
    expect(verifyPassword(pw, h)).toBe(true);
    expect(verifyPassword('other', h)).toBe(false);
    expect(h).toMatch(/^scrypt\$\d+\$8\$\d+\$/);
    expect(h).not.toContain(pw);
  });

  it('stores the current cost in the hash and keeps verifying an older hash', () => {
    expect(hashPassword('pw').split('$')[1]).toBe(String(PASSWORD_COST.N));
    const salt = Buffer.from('0123456789abcdef');
    const legacy = `scrypt$16384$8$1$${salt.toString('base64')}$${crypto.scryptSync('pw', salt, 32, { N: 16384, r: 8, p: 1 }).toString('base64')}`;
    expect(verifyPassword('pw', legacy)).toBe(true);
    expect(needsRehash(legacy)).toBe(true);
    expect(needsRehash(hashPassword('pw'))).toBe(false);
  });

  it.each(['', 'scrypt', 'scrypt$16384$8$1$$', 'scrypt$16384$8$1$AAAA$=', 'scrypt$16384$8$1$AAAA$!', 'scrypt$16384$8$1$AAAA$AAAA', 'scrypt$abc$8$1$AAAA$AAAA', 'scrypt$3$8$1$AAAA$AAAA', 'scrypt$1073741824$8$1$AAAA$AAAA', 'md5$1$1$1$AAAA$AAAA'])('never accepts or throws on the malformed stored value %j', (stored) => {
    expect(verifyPassword('', stored)).toBe(false);
    expect(verifyPassword('anything', stored)).toBe(false);
  });
});

describe('config', () => {
  it('applies defaults when settings.json is missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
    expect(loadConfig(dir)).toMatchObject({ bindHost: '127.0.0.1', port: 8480 });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('settings.json handling', () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));

  it('names the file when settings.json is not valid JSON, and does not fall back to defaults', () => {
    const d = dir();
    fs.writeFileSync(path.join(d, 'settings.json'), '{ "port": ');
    expect(() => loadConfig(d)).toThrow(/settings\.json is not valid JSON/);
    expect(() => writeSettingsPassword(d, 'h')).toThrow(/not valid JSON/);
    expect(fs.readFileSync(path.join(d, 'settings.json'), 'utf8')).toBe('{ "port": ');
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('writes the password hash atomically and keeps the other settings (BOM tolerated)', () => {
    const d = dir();
    fs.writeFileSync(path.join(d, 'settings.json'), '﻿' + JSON.stringify({ port: 9000 }));
    writeSettingsPassword(d, hashPassword('a long enough password'));
    const saved = JSON.parse(fs.readFileSync(path.join(d, 'settings.json'), 'utf8'));
    expect(saved.port).toBe(9000);
    expect(verifyPassword('a long enough password', saved.passwordHash)).toBe(true);
    expect(fs.readdirSync(d).filter((f) => f.endsWith('.part'))).toEqual([]);
    fs.rmSync(d, { recursive: true, force: true });
  });
});

describe('auth and request guards', () => {
  it('serves /health without a session', async () => {
    expect((await app.inject({ url: '/api/v1/health' })).statusCode).toBe(200);
  });

  it('returns 401 on a protected route without a session', async () => {
    expect((await app.inject({ url: '/api/v1/auth/me' })).statusCode).toBe(401);
  });

  it('does not require a session outside the API, so the login page itself can load', async () => {
    expect((await app.inject({ url: '/' })).statusCode).toBe(404);
  });

  it.each(['/%61pi/v1/auth/me', '/api/v1/%61uth/me', '/api%2Fv1/auth/me'])('still requires a session on the percent-encoded path %s', async (url) => {
    const res = await app.inject({ url });
    expect([401, 404]).toContain(res.statusCode);
    expect(res.statusCode).not.toBe(200);
  });

  it('keeps /health public even when its path is encoded', async () => {
    expect((await app.inject({ url: '/%61pi/v1/health' })).statusCode).toBe(200);
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

  it('answers 401, not 500, when the stored hash is malformed', async () => {
    config.passwordHash = 'scrypt$16384$8$1$AAAA$=';
    expect((await login('')).statusCode).toBe(401);
  });

  it('names the session cookie after the port, so two instances on one host do not overwrite each other', async () => {
    const other = buildApp({ db, jobs, config: { ...config, port: 8481 }, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cookie-')) });
    await other.ready();
    const a = String((await login('secret')).headers['set-cookie']);
    const b = String((await other.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { password: 'secret' } })).headers['set-cookie']);
    expect(a.split('=')[0]).not.toBe(b.split('=')[0]);
    await other.close();
  });

  it('rehashes an old hash after a successful login, only when settings.json still holds that hash', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rehash-'));
    const salt = Buffer.from('0123456789abcdef');
    const legacy = `scrypt$16384$8$1$${salt.toString('base64')}$${crypto.scryptSync('secret', salt, 32, { N: 16384, r: 8, p: 1 }).toString('base64')}`;
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ passwordHash: legacy, port: 9 }));
    const other = buildApp({ db, jobs, config: { ...config, passwordHash: legacy }, dataDir: dir });
    await other.ready();
    const post = (pw: string) => other.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { password: pw } });
    expect((await post('nope')).statusCode).toBe(401);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).passwordHash).toBe(legacy);
    expect((await post('secret')).statusCode).toBe(200);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(saved.port).toBe(9);
    expect(saved.passwordHash).not.toBe(legacy);
    expect(verifyPassword('secret', saved.passwordHash)).toBe(true);
    expect(needsRehash(saved.passwordHash)).toBe(false);
    // a password changed out of band is never reverted by a stale in-memory hash
    const changed = hashPassword('fresh');
    fs.writeFileSync(file, JSON.stringify({ passwordHash: changed }));
    await other.close();
    const stale = buildApp({ db, jobs, config: { ...config, passwordHash: legacy }, dataDir: dir });
    await stale.ready();
    expect((await stale.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { password: 'secret' } })).statusCode).toBe(200);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).passwordHash).toBe(changed);
    await stale.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('closes an open event stream after logout', async () => {
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`${address}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'secret' }) });
    const session = res.headers.get('set-cookie')!.split(';')[0]!;
    const stream = await fetch(`${address}/api/v1/events`, { headers: { cookie: session } });
    const reader = stream.body!.getReader();
    await fetch(`${address}/api/v1/auth/logout`, { method: 'POST', headers: { cookie: session } });
    jobs.register('noop', async () => undefined);
    jobs.enqueue('noop', null);
    let text = '';
    const deadline = Date.now() + 5000;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
      if (Date.now() > deadline) break;
    }
    expect(Date.now()).toBeLessThanOrEqual(deadline);
    expect(text).not.toContain('"queued"');
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

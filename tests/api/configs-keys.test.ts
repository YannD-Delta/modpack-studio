import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/server/api/auth.js';
import { buildApp } from '../../src/server/api/app.js';
import type { Config } from '../../src/server/config.js';
import { openDb, type Db } from '../../src/server/db/open.js';
import { JobRunner } from '../../src/server/jobs/runner.js';

let db: Db;
let app: FastifyInstance;
let tmp: string;
let cookie: string;

beforeEach(async () => {
  db = openDb(':memory:');
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'keys-api-'));
  const config: Config = { bindHost: '127.0.0.1', port: 0, passwordHash: hashPassword('pw'), allowedHosts: [] };
  app = buildApp({ db, jobs: new JobRunner(db), config, dataDir: path.join(tmp, 'data') });
  await app.ready();
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { password: 'pw' } });
  cookie = String(res.headers['set-cookie']).split(';')[0]!;
});
afterEach(async () => {
  await app.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const call = (method: 'GET' | 'POST', url: string, payload?: unknown) => app.inject({ method, url: `/api/v1${url}`, payload: payload as object, headers: { cookie } });

function tree(root: string, files: Record<string, string | Buffer>) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

async function scan(profile: number) {
  const res = await call('POST', '/configs/scan', { profile, force: true });
  expect(res.statusCode).toBe(202);
  const jobId = (res.json() as { jobId: string }).jobId;
  for (let i = 0; i < 200; i++) {
    const row = (await call('GET', `/configs/scan/${jobId}`)).json() as { status: string };
    if (!['queued', 'running'].includes(row.status)) return row.status;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('scan timed out');
}

async function setup() {
  const a = tree(path.join(tmp, 'a'), {
    'config/game.toml': '[general]\nspeed = 1\nname = "x"\n[old]\nlimit = 5\n',
    'config/data.json': '{"k": 1, "arr": [1, 2]}',
    'config/broken.toml': 'speed = \n',
    'config/server.properties': 'motd=hello\nport=1\n',
    'config/notes.txt': 'plain',
  });
  const b = tree(path.join(tmp, 'b'), {
    'config/game.toml': '[general]\nspeed = 3\nname = "x"\nextra = true\n[new]\nlimit = 5\n',
    'config/data.json': '{\n // c\n "k": 1, "arr": [1, 2],\n}',
    'config/broken.toml': 'speed = 2\n',
    'config/server.properties': 'motd=hi\nport=1\n',
    'config/notes.txt': 'plain 2',
    'config/only-b.toml': 'a = 1\n',
  });
  const mk = async (body: object) => (await call('POST', '/profiles', body)).json() as { id: number };
  const base = await mk({ pack: 'Base', version: '8.3', side: 'client', state: 'clean', locationKind: 'folder', location: a });
  const other = await mk({ pack: 'Own', version: '1.0', side: 'client', state: 'launched', locationKind: 'folder', location: b });
  return { base: base.id, other: other.id };
}

const url = (b: number, o: number, p: string) => `/configs/keydiff?base=${b}&other=${o}&path=${encodeURIComponent(p)}`;

describe('GET /configs/keydiff', () => {
  it('requires a session and validates the query', async () => {
    expect((await app.inject({ url: '/api/v1/configs/keydiff?base=1&other=2&path=a.toml' })).statusCode).toBe(401);
    expect((await call('GET', '/configs/keydiff?base=x&other=2&path=a.toml')).statusCode).toBe(400);
    expect((await call('GET', url(1, 2, '../x.toml'))).statusCode).toBe(400);
    expect((await call('GET', url(98, 99, 'config/a.toml'))).statusCode).toBe(404);
  });

  it('answers 409 not_scanned until both profiles are scanned', async () => {
    const { base, other } = await setup();
    const r = await call('GET', url(base, other, 'config/game.toml'));
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('not_scanned');
  });

  it('diffs keys of a TOML file, with a moved key', async () => {
    const { base, other } = await setup();
    expect(await scan(base)).toBe('done');
    expect(await scan(other)).toBe('done');
    const r = await call('GET', url(base, other, 'config/game.toml'));
    expect(r.statusCode, r.body).toBe(200);
    const j = r.json();
    expect(j).toMatchObject({ format: 'toml', parsable: true });
    expect(j.diff.changed).toEqual([{ key: 'general.speed', old: '1', new: '3' }]);
    expect(j.diff.added).toEqual([{ key: 'general.extra', value: 'true' }]);
    expect(j.diff.moved).toEqual([{ from: 'old.limit', to: 'new.limit', value: '5' }]);
    expect(j.diff.removed).toEqual([]);
    expect(j.counts).toEqual({ added: 1, removed: 0, changed: 1, moved: 1 });
  });

  it('ignores formatting, comments and trailing commas in JSON', async () => {
    const { base, other } = await setup();
    await scan(base);
    await scan(other);
    const j = (await call('GET', url(base, other, 'config/data.json'))).json();
    expect(j.parsable).toBe(true);
    expect(j.counts).toEqual({ added: 0, removed: 0, changed: 0, moved: 0 });
  });

  it('handles properties and a file present on one side only', async () => {
    const { base, other } = await setup();
    await scan(base);
    await scan(other);
    const p = (await call('GET', url(base, other, 'config/server.properties'))).json();
    expect(p.diff.changed).toEqual([{ key: 'motd', old: 'hello', new: 'hi' }]);
    const one = (await call('GET', url(base, other, 'config/only-b.toml'))).json();
    expect(one.diff.added).toEqual([{ key: 'a', value: '1' }]);
    expect(one.baseSize).toBeNull();
  });

  it('falls back to lines when a file is unsupported or unparsable', async () => {
    const { base, other } = await setup();
    await scan(base);
    await scan(other);
    const txt = (await call('GET', url(base, other, 'config/notes.txt'))).json();
    expect(txt).toMatchObject({ parsable: false, reason: 'unsupported', format: null });
    const bad = (await call('GET', url(base, other, 'config/broken.toml'))).json();
    expect(bad).toMatchObject({ parsable: false, reason: 'unparsable', format: 'toml' });
    expect((await call('GET', url(base, other, 'config/missing.toml'))).statusCode).toBe(404);
  });
});

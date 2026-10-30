import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/api/app.js';
import { hashPassword } from '../../src/server/api/auth.js';
import { buildClientRunPrompt, buildPrompt } from '../../src/server/assistant/prompts.js';
import { summarizeClientLog } from '../../src/server/testbench/client-logs.js';
import type { Config } from '../../src/server/config.js';
import { openDb, type Db } from '../../src/server/db/open.js';
import { closePool } from '../../src/server/jobs/pool.js';
import { JobRunner } from '../../src/server/jobs/runner.js';
import { storeSources } from '../../src/server/mods/curseforge-sources.js';
import { createProfile, getProfile } from '../../src/server/profiles/profile-service.js';
import { setSecret } from '../../src/server/settings/secrets-store.js';

const KEY = 'sk-test-assistant-0123456789abcdef';

let db: Db;
let app: FastifyInstance;
let cookie: string;
let dataDir: string;
let sent: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[];
let answer: { status: number; body: unknown };
let upstreamId: number;
let ownId: number;

/** One mod set per profile, written straight into the tables the importer fills. */
function seed(profileId: number, mods: [string, string, string][]) {
  for (const [id, version, file] of mods) {
    const sha = `sha-${profileId}-${id}-${version}`;
    db.sqlite.prepare('INSERT OR IGNORE INTO jar (sha256, filename, size) VALUES (?, ?, 1)').run(sha, file);
    db.sqlite.prepare("INSERT INTO jar_mod (jar_sha256, profile_id, mod_id, version, declared_side, is_jij) VALUES (?, ?, ?, ?, 'unknown', 0)").run(sha, profileId, id, version);
  }
}

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-assistant-'));
  sent = [];
  answer = {
    status: 200,
    body: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'Verdict : garder.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 120, output_tokens: 30 } },
  };
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  db = openDb(':memory:');
  const config: Config = { bindHost: '127.0.0.1', port: 0, passwordHash: hashPassword('pw'), allowedHosts: [] };
  app = buildApp({ db, jobs: new JobRunner(db), config, dataDir, fetchImpl });
  await app.ready();
  cookie = String((await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { password: 'pw' } })).headers['set-cookie']).split(';')[0]!;

  upstreamId = createProfile(db, { pack: 'Base', version: '8.3', side: 'client', state: 'clean', locationKind: 'folder', location: path.join(dataDir, 'upstreamId') }).id;
  ownId = createProfile(db, { pack: 'Own', version: 'test', side: 'client', state: 'launched', locationKind: 'folder', location: path.join(dataDir, 'ownId') }).id;
  seed(upstreamId, [['alpha', '2.0', 'alpha-2.0.jar'], ['beta', '1.0', 'beta-1.0.jar'], ['same', '1.0', 'same-1.0.jar'], ['gone', '3.1', 'gone-3.1.jar']]);
  seed(ownId, [['alpha', '1.0', 'alpha-1.0.jar'], ['beta', '1.5', 'beta-1.5.jar'], ['same', '1.0', 'same-1.0.jar'], ['mine', '0.9', 'mine-0.9.jar']]);
  storeSources(db, upstreamId, [
    { fileName: 'alpha-2.0.jar', projectId: 11, fileId: 1, name: 'Alpha', url: 'https://www.curseforge.com/minecraft/mc-mods/alpha' },
    { fileName: 'gone-3.1.jar', projectId: 33, fileId: 3, name: 'Gone', url: 'https://www.curseforge.com/minecraft/mc-mods/gone' },
  ]);
  storeSources(db, ownId, [{ fileName: 'mine-0.9.jar', projectId: 44, fileId: 4, name: 'Mine', url: 'https://www.curseforge.com/minecraft/mc-mods/mine' }]);
});
afterEach(async () => {
  await app.close();
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
afterAll(() => closePool());

const call = (method: 'GET' | 'POST', url: string, payload?: unknown) => app.inject({ method, url: `/api/v1${url}`, headers: { cookie }, payload: payload as object | undefined });

describe('prompt builder', () => {
  const ctx = () => ({ base: getProfile(db, upstreamId), other: getProfile(db, ownId), baseLoader: { loader: 'neoforge' as const, loaderVersion: '21.1.259', mcVersion: '1.21.1' }, otherLoader: null, names: { upstream: 'Base', own: 'Own' } });

  it('lists the out-of-date mods with both versions and the CurseForge page, and nothing else', () => {
    const b = buildPrompt(db, { action: 'review-updates', ...ctx(), mode: 'chat' });
    expect(b.prompt).toContain('- alpha : 1.0 chez le comparé → 2.0 dans la référence | page : https://www.curseforge.com/minecraft/mc-mods/alpha | page chez le comparé : lien inconnu');
    expect(b.prompt).not.toContain('- beta'); // the compared side is newer
    expect(b.prompt).not.toContain('- same');
    expect(b.prompt).toContain('neoforge 21.1.259, Minecraft 1.21.1');
    expect(b.prompt).toContain('loader non détecté');
    expect(b.rows).toBe(1);
  });

  it('lists the mods only the compared side has, and the ones only the reference has', () => {
    expect(buildPrompt(db, { action: 'review-added', ...ctx(), mode: 'chat' }).prompt).toContain('- mine 0.9 | page : https://www.curseforge.com/minecraft/mc-mods/mine');
    const missing = buildPrompt(db, { action: 'review-missing', ...ctx(), mode: 'chat' }).prompt;
    expect(missing).toContain('- gone 3.1 | page : https://www.curseforge.com/minecraft/mc-mods/gone');
    expect(missing).not.toContain('- mine');
  });

  it('frames the old-pack migration with the loader comparison and the shared count', () => {
    const p = buildPrompt(db, { action: 'migrate-old-pack', ...ctx(), mode: 'chat' }).prompt;
    expect(p).toContain('ancien pack');
    expect(p).toContain('en commun avec Base');
    expect(p).toContain('version neoforge');
    expect(p).toContain('- mine 0.9');
  });

  it('says "lien inconnu" when a jar has no CurseForge source', () => {
    expect(buildPrompt(db, { action: 'review-updates', ...ctx(), mode: 'chat' }).prompt).not.toContain('page : lien inconnu');
    db.sqlite.prepare('DELETE FROM jar_source').run();
    expect(buildPrompt(db, { action: 'review-updates', ...ctx(), mode: 'chat' }).prompt).toContain('page : lien inconnu');
  });

  it('tells a chat model to open the links and an API model that it has no web access', () => {
    expect(buildPrompt(db, { action: 'review-added', ...ctx(), mode: 'chat' }).prompt).toContain('recherche web');
    expect(buildPrompt(db, { action: 'review-added', ...ctx(), mode: 'api' }).prompt).toContain('pas accès à internet');
  });

  it('never names a loader that was not detected', () => {
    const p = buildPrompt(db, { action: 'migrate-old-pack', ...ctx(), baseLoader: { loader: 'fabric' as const, loaderVersion: '0.16', mcVersion: '1.20.1' }, mode: 'chat' }).prompt;
    expect(p).not.toMatch(/neoforge/i);
    expect(p).toContain('version fabric');
    const none = buildPrompt(db, { action: 'migrate-old-pack', ...ctx(), baseLoader: null, mode: 'chat' }).prompt;
    expect(none).not.toMatch(/neoforge/i);
  });

  it('speaks with the pack names chosen in Settings instead of Base and Own', () => {
    const names = { upstream: 'Alpha Pack', own: 'Beta Pack' };
    const p = buildPrompt(db, { action: 'migrate-old-pack', ...ctx(), names, mode: 'chat' }).prompt;
    expect(p).toContain('maintenir Beta Pack');
    expect(p).toContain('construit sur Alpha Pack');
    expect(p).toContain('en commun avec Alpha Pack');
    // the profile header lines still show the names stored with the profiles; every sentence of the prompt follows the settings
    expect(p.split('\n').filter((l) => !l.startsWith('Référence') && !l.startsWith('Comparé')).join('\n')).not.toMatch(/Base/);
    expect(p).not.toContain('{upstream}');
    expect(p).not.toContain('{own}');
  });

  it('caps a long list and says so', () => {
    for (let i = 0; i < 12; i++) seed(ownId, [[`extra${i}`, '1.0', `extra${i}-1.0.jar`]]);
    const b = buildPrompt(db, { action: 'review-added', ...ctx(), mode: 'chat', maxRows: 5 });
    expect(b.shown).toBe(5);
    expect(b.rows).toBe(13);
    expect(b.prompt).toContain('Liste tronquée : 5 mods affichés sur 13');
  });
});

describe('assistant api', () => {
  it('lists the predefined actions with a plain explanation each', async () => {
    const actions = (await call('GET', '/assistant/actions')).json() as { id: string; label: string; tip: string }[];
    expect(actions.map((a) => a.id)).toEqual(['review-updates', 'review-added', 'review-missing', 'migrate-old-pack', 'analyze-test-run']);
    expect(actions.every((a) => a.label && a.tip.length > 20)).toBe(true);
  });

  it('returns a copyable prompt without needing a key, and rejects unknown input', async () => {
    const res = await call('POST', '/assistant/prompt', { action: 'review-updates', base: upstreamId, other: ownId });
    expect(res.statusCode).toBe(200);
    expect(res.json().prompt).toContain('alpha');
    expect((await call('POST', '/assistant/prompt', { action: 'nope', base: upstreamId, other: ownId })).statusCode).toBe(400);
    expect((await call('POST', '/assistant/prompt', { action: 'review-updates', base: 999, other: ownId })).statusCode).toBe(404);
    const empty = createProfile(db, { pack: 'Own', version: 'empty', side: 'client', state: 'launched', locationKind: 'folder', location: path.join(dataDir, 'empty') }).id;
    expect((await call('POST', '/assistant/prompt', { action: 'review-updates', base: upstreamId, other: empty })).statusCode).toBe(409);
  });

  it('refuses to run without a key', async () => {
    const res = await call('POST', '/assistant/run', { action: 'review-updates', base: upstreamId, other: ownId });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('not_configured');
    expect(sent).toHaveLength(0);
  });

  it('runs an action with the saved key, model and effort, and returns the text', async () => {
    setSecret(dataDir, 'claude', KEY);
    
    const res = await call('POST', '/assistant/run', { action: 'review-updates', base: upstreamId, other: ownId });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ text: 'Verdict : garder.', model: 'claude-sonnet-5-5', effort: 'medium', inputTokens: 120, outputTokens: 30, rows: 1 });
    expect(res.body).not.toContain(KEY);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toContain('/v1/messages');
    expect(sent[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(sent[0]!.body.model).toBe('claude-sonnet-5-5');
    expect(sent[0]!.body.output_config).toMatchObject({ effort: 'medium' });
    expect(JSON.stringify(sent[0]!.body.messages)).toContain('pas accès à internet');
    expect(JSON.stringify(sent[0]!.body.messages)).toContain('alpha');
  });

  it('uses the model and effort saved in the settings', async () => {
    setSecret(dataDir, 'claude', KEY);
    const saved = await app.inject({ method: 'PUT', url: '/api/v1/settings/assistant', headers: { cookie }, payload: { model: 'claude-opus-5-5', effort: 'high' } });
    expect(saved.statusCode).toBe(200);
    await call('POST', '/assistant/run', { action: 'review-added', base: upstreamId, other: ownId });
    expect(sent[0]!.body.model).toBe('claude-opus-5-5');
    expect(sent[0]!.body.output_config).toMatchObject({ effort: 'high' });
  });

  it('keeps the prompt and the key out of the audit log', async () => {
    setSecret(dataDir, 'claude', KEY);
    await call('POST', '/assistant/run', { action: 'review-updates', base: upstreamId, other: ownId });
    const rows = JSON.stringify(db.sqlite.prepare('SELECT action, target, detail FROM audit_log').all());
    expect(rows).toContain('assistant.run');
    expect(rows).not.toContain(KEY);
    expect(rows).not.toContain('alpha-2.0');
  });

  it.each([
    [401, 502, 'rejected'],
    [429, 429, 'rate_limited'],
    [500, 502, 'unexpected'],
  ])('maps an API answer of %i to %i %s', async (apiStatus, status, code) => {
    setSecret(dataDir, 'claude', KEY);
    answer = { status: apiStatus, body: { type: 'error', error: { type: 'x', message: 'boom' } } };
    const res = await call('POST', '/assistant/run', { action: 'review-updates', base: upstreamId, other: ownId });
    expect(res.statusCode).toBe(status);
    expect(res.json().code).toBe(code);
    expect(res.body).not.toContain(KEY);
  });

  it('reports a refusal instead of an empty answer', async () => {
    setSecret(dataDir, 'claude', KEY);
    answer = { status: 200, body: { id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: 'refusal', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } };
    const res = await call('POST', '/assistant/run', { action: 'review-updates', base: upstreamId, other: ownId });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('refused');
  });

  it('ignores ANTHROPIC_BASE_URL from the environment and always calls the official API', async () => {
    setSecret(dataDir, 'claude', KEY);
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.invalid';
    try {
      await call('POST', '/assistant/run', { action: 'review-updates', base: upstreamId, other: ownId });
    } finally {
      delete process.env.ANTHROPIC_BASE_URL;
    }
    expect(sent[0]!.url.startsWith('https://api.anthropic.com/')).toBe(true);
  });

  it('flags an answer cut at max_tokens instead of returning it as a normal one', async () => {
    setSecret(dataDir, 'claude', KEY);
    answer = { status: 200, body: { id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'Début' }], stop_reason: 'max_tokens', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 16000 } } };
    const res = await call('POST', '/assistant/run', { action: 'review-updates', base: upstreamId, other: ownId });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ text: 'Début', truncated: true, code: 'truncated' });
  });

  it('reports an empty answer as an error', async () => {
    setSecret(dataDir, 'claude', KEY);
    answer = { status: 200, body: { id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } };
    const res = await call('POST', '/assistant/run', { action: 'review-updates', base: upstreamId, other: ownId });
    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe('unexpected');
  });

  it('does not retry a failing paid call', async () => {
    setSecret(dataDir, 'claude', KEY);
    answer = { status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'busy' } } };
    await call('POST', '/assistant/run', { action: 'review-updates', base: upstreamId, other: ownId });
    expect(sent).toHaveLength(1);
  });

  it('gives a stable code to every precondition error', async () => {
    setSecret(dataDir, 'claude', KEY);
    const missing = await call('POST', '/assistant/run', { action: 'review-updates', base: 999, other: ownId });
    expect(missing.json()).toMatchObject({ code: 'profile_not_found' });
    const empty = createProfile(db, { pack: 'Own', version: 'empty2', side: 'client', state: 'launched', locationKind: 'folder', location: path.join(dataDir, 'empty2') }).id;
    const res = await call('POST', '/assistant/run', { action: 'review-updates', base: upstreamId, other: empty });
    expect(res.json()).toMatchObject({ code: 'profiles_not_imported' });
  });

  it('refuses to compare a client with a server profile', async () => {
    setSecret(dataDir, 'claude', KEY);
    const srv = createProfile(db, { pack: 'Own', version: 'srv', side: 'server', state: 'clean', locationKind: 'folder', location: path.join(dataDir, 'srv') }).id;
    seed(srv, [['alpha', '1.0', 'alpha-1.0.jar']]);
    for (const url of ['/assistant/prompt', '/assistant/run']) {
      const res = await call('POST', url, { action: 'review-updates', base: upstreamId, other: srv });
      expect(res.statusCode, url).toBe(400);
      expect(res.json(), url).toMatchObject({ code: 'sides_differ' });
    }
  });

  it('refreshes the CurseForge sources of an instance folder from its minecraftinstance.json', async () => {
    const dir = path.join(dataDir, 'ownId');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'minecraftinstance.json'), JSON.stringify({ installedAddons: [{ addonID: 7, name: 'Seven', fileNameOnDisk: 'alpha-1.0.jar', installedFile: { id: 70 } }] }));
    const res = await call('POST', `/profiles/${ownId}/sources`);
    expect(res.json()).toEqual({ count: 1 });
    expect((await call('POST', '/assistant/prompt', { action: 'review-updates', base: upstreamId, other: ownId })).json().prompt).toContain('https://www.curseforge.com/projects/7');
    expect((await call('POST', '/profiles/999/sources')).statusCode).toBe(404);
  });

  it('keeps the stored CurseForge links when minecraftinstance.json cannot be read', async () => {
    const dir = path.join(dataDir, 'ownId');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'minecraftinstance.json'), JSON.stringify({ installedAddons: [{ addonID: 7, name: 'Seven', fileNameOnDisk: 'alpha-1.0.jar', installedFile: { id: 70 } }] }));
    expect((await call('POST', `/profiles/${ownId}/sources`)).json()).toEqual({ count: 1 });
    fs.writeFileSync(path.join(dir, 'minecraftinstance.json'), '{ half written');
    const res = await call('POST', `/profiles/${ownId}/sources`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'instance_unreadable' });
    expect((await call('POST', '/assistant/prompt', { action: 'review-updates', base: upstreamId, other: ownId })).json().prompt).toContain('https://www.curseforge.com/projects/7');
  });
});

describe('assistant api: server test analysis', () => {
  function writeRun(id: string, finished: boolean) {
    const dir = path.join(dataDir, 'tests', id);
    fs.mkdirSync(path.join(dir, 'server', 'crash-reports'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id, profileId: ownId, label: 'Own test · server · launched', memoryMb: 8192, port: 25570, createdAt: '2026-10-29T12:00:00.000Z', jobId: null }));
    fs.writeFileSync(path.join(dir, 'console.log'), ['[10:00:00] [main/INFO] [FML]: start', '[10:00:01] [main/ERROR] [mod_x]: Failed to load mod_x', 'Exception in thread main'].join('\n'));
    fs.writeFileSync(path.join(dir, 'server', 'crash-reports', 'crash-1.txt'), 'Description: exception in loading\nCaused by: missing dependency exemple_core');
    if (finished) {
      fs.writeFileSync(
        path.join(dir, 'result.json'),
        JSON.stringify({ status: 'crashed', bootSeconds: null, exitCode: 1, startedAt: 'a', endedAt: 'b', summary: { bootSeconds: null, errorLines: 1, warnLines: 0, firstErrors: ['[main/ERROR] [mod_x]: Failed to load mod_x'] }, crashReports: ['crash-1.txt'], modJars: 12 }),
      );
    }
  }

  it('builds a prompt from the summary, the first errors, the crash report and the log tail', async () => {
    writeRun('run-a', true);
    const res = await call('POST', '/assistant/prompt', { action: 'analyze-test-run', runId: 'run-a' });
    expect(res.statusCode).toBe(200);
    const p = res.json().prompt as string;
    expect(p).toContain('Own test · server · launched');
    expect(p).toContain('crashed');
    expect(p).toContain('jamais arrivé à « Done »');
    expect(p).toContain('Failed to load mod_x');
    expect(p).toContain('missing dependency exemple_core');
    expect(p).toContain('Exception in thread main');
  });

  it('refuses an unfinished test, an unknown one and an id that tries to leave the tests folder', async () => {
    writeRun('run-b', false);
    expect((await call('POST', '/assistant/prompt', { action: 'analyze-test-run', runId: 'run-b' })).statusCode).toBe(409);
    expect((await call('POST', '/assistant/prompt', { action: 'analyze-test-run', runId: 'nope' })).statusCode).toBe(404);
    expect((await call('POST', '/assistant/prompt', { action: 'analyze-test-run', runId: '../../settings' })).statusCode).toBe(404);
  });

  it('runs the analysis through the API and logs the run id, not the log', async () => {
    writeRun('run-c', true);
    setSecret(dataDir, 'claude', KEY);
    const res = await call('POST', '/assistant/run', { action: 'analyze-test-run', runId: 'run-c' });
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(sent[0]!.body.messages)).toContain('Failed to load mod_x');
    const rows = JSON.stringify(db.sqlite.prepare('SELECT action, target, detail FROM audit_log').all());
    expect(rows).toContain('run-c');
    expect(rows).not.toContain('Failed to load');
  });
});

describe('buildClientRunPrompt', () => {
  it('states the markers used, the errors and the crash headline, and never the log lines of the player', () => {
    const summary = summarizeClientLog(['[10:00:01] [Render thread/INFO] [Minecraft/]: Setting user: SomePlayer', '[10:00:02] [main/ERROR] [mod_x/]: Failed to load mod_x'].join('\n'));
    const logs = {
      profile: { id: 1, label: 'Own My pack 2026 (client, run)' },
      log: { present: true, truncated: false, bytesRead: 10, lines: 2, ...summary },
      crashReports: [{ name: 'crash-1.txt', modified: '2026-10-29T10:00:00.000Z', headline: 'Initializing game: java.lang.Error: boom', head: 'Description: Initializing game' }],
      mods: { count: 3, onlyInInstance: ['extra-1.0.jar'], onlyInImport: [], imported: true },
      markersUsed: summary.markers.map((m) => m.pattern),
    };
    const built = buildClientRunPrompt({ logs, mode: 'chat', names: { upstream: 'Base', own: 'Own' } });
    expect(built.action).toBe('analyze-client-run');
    expect(built.prompt).toContain('Setting user:');
    expect(built.prompt).toContain('Failed to load mod_x');
    expect(built.prompt).toContain('Initializing game: java.lang.Error: boom');
    expect(built.prompt).toContain('extra-1.0.jar');
    expect(built.prompt).not.toContain('SomePlayer');
    expect(built.prompt).not.toContain('{upstream}');
  });
});

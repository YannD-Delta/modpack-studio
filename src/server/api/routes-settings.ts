import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { API_PREFIX } from '../../shared/constants.js';
import { checkClaudeKey } from '../assistant/anthropic.js';
import { PackNamesError, readPackNames, writePackNames } from '../settings/packs.js';
import { audit } from '../db/audit.js';
import { EFFORTS, getSecret, isValidKey, keyStatus, MODELS, PROVIDERS, readPrefs, setSecret, writePrefs } from '../settings/secrets-store.js';
import type { AppDeps } from './app.js';
import { sendBadRequest } from './routes-profiles.js';

const ProviderSchema = z.enum(PROVIDERS);
const KeyBody = z.object({ provider: ProviderSchema, key: z.string().refine(isValidKey, 'not a valid API key') });
const ProviderBody = z.object({ provider: ProviderSchema });
const PacksBody = z.object({ upstream: z.string().min(1).max(40), own: z.string().min(1).max(40) });
const AssistantBody = z.object({ model: z.enum(MODELS.map((m) => m.id) as [string, ...string[]]), effort: z.enum(EFFORTS) });

const TEST_TIMEOUT_MS = 10_000;

const CURSEFORGE_TEST_URL = 'https://api.curseforge.com/v1/games?index=0&pageSize=1';

/**
 * API keys and assistant preferences. A key is write-only: no route ever returns it, only whether it is set and its last 4 characters.
 * The audit log records that a key was set or removed, never its value.
 */
export function registerSettingsRoutes(api: FastifyInstance, deps: AppDeps): void {
  const { db } = deps;
  const dataDir = deps.dataDir ?? path.resolve('data');
  const doFetch = deps.fetchImpl ?? fetch;

  api.get(`${API_PREFIX}/settings`, async () => ({
    keys: { claude: keyStatus(dataDir, 'claude'), curseforge: keyStatus(dataDir, 'curseforge') },
    assistant: readPrefs(dataDir),
    packs: readPackNames(dataDir),
    models: MODELS,
    efforts: EFFORTS,
  }));

  api.put(`${API_PREFIX}/settings/keys`, async (req, reply) => {
    const body = KeyBody.safeParse(req.body);
    if (!body.success) return sendBadRequest(reply, body.error);
    setSecret(dataDir, body.data.provider, body.data.key);
    audit(db, 'settings.key_set', body.data.provider, { last4: body.data.key.slice(-4) });
    return { ok: true, status: keyStatus(dataDir, body.data.provider) };
  });

  api.delete(`${API_PREFIX}/settings/keys/:provider`, async (req, reply) => {
    const p = ProviderBody.safeParse(req.params);
    if (!p.success) return sendBadRequest(reply, p.error);
    setSecret(dataDir, p.data.provider, null);
    audit(db, 'settings.key_removed', p.data.provider, {});
    return { ok: true, status: keyStatus(dataDir, p.data.provider) };
  });

  api.post(`${API_PREFIX}/settings/keys/test`, async (req, reply) => {
    const p = ProviderBody.safeParse(req.body);
    if (!p.success) return sendBadRequest(reply, p.error);
    const key = getSecret(dataDir, p.data.provider);
    if (!key) return { ok: false, code: 'not_configured' };
    if (p.data.provider === 'claude') {
      const check = await checkClaudeKey(key, deps.fetchImpl);
      return check.ok ? { ok: true, code: 'ok' } : { ok: false, code: check.code, ...(check.status ? { status: check.status } : {}) };
    }
    try {
      const res = await doFetch(CURSEFORGE_TEST_URL, { headers: { 'x-api-key': key, accept: 'application/json' }, signal: AbortSignal.timeout(TEST_TIMEOUT_MS) });
      if (res.ok) return { ok: true, code: 'ok' };
      return { ok: false, code: res.status === 401 || res.status === 403 ? 'rejected' : 'unexpected', status: res.status };
    } catch {
      return { ok: false, code: 'unreachable' }; // the error text could carry request details: report the category only
    }
  });

  api.put(`${API_PREFIX}/settings/assistant`, async (req, reply) => {
    const body = AssistantBody.safeParse(req.body);
    if (!body.success) return sendBadRequest(reply, body.error);
    writePrefs(dataDir, body.data);
    audit(db, 'settings.assistant', 'assistant', body.data);
    return { ok: true, assistant: readPrefs(dataDir) };
  });

  /** Renames the two packs everywhere: the settings and every profile already stored follow. */
  api.put(`${API_PREFIX}/settings/packs`, async (req, reply) => {
    const body = PacksBody.safeParse(req.body);
    if (!body.success) return sendBadRequest(reply, body.error);
    try {
      const before = readPackNames(dataDir);
      const packs = writePackNames(db, dataDir, body.data);
      audit(db, 'settings.packs', 'packs', { from: before, to: packs });
      return { ok: true, packs };
    } catch (err) {
      if (err instanceof PackNamesError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });
}

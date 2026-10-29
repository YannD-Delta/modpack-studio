import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { API_PREFIX } from '../../shared/constants.js';
import { makeClient, RefusedError, runPrompt } from '../assistant/anthropic.js';
import { ACTION_INFO, ACTIONS, buildPrompt, buildTestRunPrompt, PAIR_ACTIONS, type BuiltPrompt, type PairActionId } from '../assistant/prompts.js';
import { audit } from '../db/audit.js';
import { detectLoader, type LoaderInfo } from '../loader/detect-loader.js';
import { readInstanceSources, storeSources } from '../mods/curseforge-sources.js';
import { loadModSet } from '../mods/modset-store.js';
import { getProfile, type Profile } from '../profiles/profile-service.js';
import { getSecret, readPrefs } from '../settings/secrets-store.js';
import { readCrashHead, readLogTail, readRun, validRunId } from '../testbench/runs.js';
import type { AppDeps } from './app.js';
import { sendBadRequest } from './routes-profiles.js';

const PairBody = z.object({
  action: z.enum(PAIR_ACTIONS),
  base: z.number().int().positive(),
  other: z.number().int().positive(),
  mode: z.enum(['chat', 'api']).default('chat'),
});
const TestRunBody = z.object({ action: z.literal('analyze-test-run'), runId: z.string().min(1).max(120), mode: z.enum(['chat', 'api']).default('chat') });
const PromptBody = z.union([PairBody, TestRunBody]);
const RunBody = z.union([PairBody.omit({ mode: true }), TestRunBody.omit({ mode: true })]);
type AnyBody = z.infer<typeof PromptBody> | z.infer<typeof RunBody>;

async function loaderOf(p: Profile): Promise<LoaderInfo | null> {
  try {
    return await detectLoader(p.locationKind === 'zip' ? { kind: 'serverZip', path: p.location } : { kind: 'curseforgeInstance', path: p.location });
  } catch {
    return null; // the prompt says "loader non détecté": a missing loader file must not block the analysis
  }
}

function profileOr404(deps: AppDeps, id: number, reply: FastifyReply): Profile | null {
  try {
    return getProfile(deps.db, id);
  } catch {
    void reply.code(404).send({ error: `profile ${id} not found` });
    return null;
  }
}

/**
 * Ready-made Claude actions on a comparison. A prompt can be copied (claude.ai, with web search) or sent through the API
 * with the key and the model saved in Settings. Prompts never leave the machine except toward Anthropic, and are not logged.
 */
export function registerAssistantRoutes(api: FastifyInstance, deps: AppDeps): void {
  const { db } = deps;
  const dataDir = deps.dataDir ?? path.resolve('data');

  api.get(`${API_PREFIX}/assistant/actions`, async () => ACTIONS.map((id) => ({ id, ...ACTION_INFO[id] })));

  /** Builds the prompt of an action: for two imported profiles, or for one finished server test (shared by "copy" and "run"). */
  const build = async (data: AnyBody, mode: 'chat' | 'api', reply: FastifyReply): Promise<BuiltPrompt | null> => {
    if ('runId' in data) {
      const run = validRunId(data.runId) ? readRun(dataDir, data.runId) : null;
      if (!run) {
        void reply.code(404).send({ error: 'run not found' });
        return null;
      }
      if (!run.result) {
        void reply.code(409).send({ error: 'this test is not finished yet' });
        return null;
      }
      return buildTestRunPrompt({ run, logTail: readLogTail(dataDir, data.runId, 150)?.lines ?? [], crashHead: readCrashHead(dataDir, data.runId), mode });
    }
    const base = profileOr404(deps, data.base, reply);
    if (!base) return null;
    const other = profileOr404(deps, data.other, reply);
    if (!other) return null;
    if (loadModSet(db, base.id).size === 0 || loadModSet(db, other.id).size === 0) {
      void reply.code(409).send({ error: 'both profiles must be imported first' });
      return null;
    }
    const [baseLoader, otherLoader] = await Promise.all([loaderOf(base), loaderOf(other)]);
    return buildPrompt(db, { action: data.action as PairActionId, base, other, baseLoader, otherLoader, mode });
  };

  api.post(`${API_PREFIX}/assistant/prompt`, async (req, reply) => {
    const body = PromptBody.safeParse(req.body);
    if (!body.success) return sendBadRequest(reply, body.error);
    const built = await build(body.data, body.data.mode, reply);
    return built ?? reply;
  });

  api.post(`${API_PREFIX}/assistant/run`, async (req, reply) => {
    const body = RunBody.safeParse(req.body);
    if (!body.success) return sendBadRequest(reply, body.error);
    const key = getSecret(dataDir, 'claude');
    if (!key) return reply.code(409).send({ error: 'no Claude API key: add one in Settings', code: 'not_configured' });
    const built = await build(body.data, 'api', reply);
    if (!built) return reply;
    const prefs = readPrefs(dataDir);
    try {
      const result = await runPrompt(makeClient(key, { fetchImpl: deps.fetchImpl }), { model: prefs.model, effort: prefs.effort, prompt: built.prompt });
      // The prompt itself is not stored: it lists the whole mod set.
      audit(db, 'assistant.run', body.data.action, { target: 'runId' in body.data ? body.data.runId : { base: body.data.base, other: body.data.other }, model: result.model, effort: prefs.effort, inputTokens: result.inputTokens, outputTokens: result.outputTokens });
      return { text: result.text, model: result.model, effort: prefs.effort, inputTokens: result.inputTokens, outputTokens: result.outputTokens, rows: built.rows, shown: built.shown };
    } catch (err) {
      if (err instanceof RefusedError) return reply.code(422).send({ error: 'Claude declined to answer this request', code: 'refused' });
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return reply.code(502).send({ error: 'the API refused the key', code: 'rejected' });
      if (err instanceof Anthropic.RateLimitError) return reply.code(429).send({ error: 'rate limited, try again in a moment', code: 'rate_limited' });
      if (err instanceof Anthropic.APIConnectionError) return reply.code(502).send({ error: 'the Anthropic API is unreachable', code: 'unreachable' });
      if (err instanceof Anthropic.APIError) return reply.code(502).send({ error: `the API answered ${err.status ?? 'an error'}`, code: 'unexpected' });
      throw err;
    }
  });

  /** Re-reads minecraftinstance.json of an imported instance folder: fills CurseForge links without re-importing the jars. */
  api.post(`${API_PREFIX}/profiles/:id/sources`, async (req, reply) => {
    const id = z.coerce.number().int().positive().safeParse((req.params as { id: string }).id);
    if (!id.success) return sendBadRequest(reply, id.error);
    const profile = profileOr404(deps, id.data, reply);
    if (!profile) return reply;
    if (profile.locationKind === 'zip' || profile.locationKind === 'agent') return reply.code(409).send({ error: 'only an instance folder has a minecraftinstance.json' });
    const sources = readInstanceSources(profile.location);
    storeSources(db, profile.id, sources);
    audit(db, 'profile.sources', String(profile.id), { count: sources.length });
    return { count: sources.length };
  });
}

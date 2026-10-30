import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { API_PREFIX } from '../../shared/constants.js';
import {
  AnomaliesQuerySchema,
  UpstreamSidesQuerySchema,
  BlacklistPutSchema,
  BlacklistQuerySchema,
  DecisionBodySchema,
  DiffQuerySchema,
  LoaderCheckQuerySchema,
  NewModIdSchema,
} from '../../shared/schemas/mods.js';
import type { Db } from '../db/open.js';
import { checkLoaderAgreement, detectLoaderForProfile, type LoaderInfo } from '../loader/detect-loader.js';
import { addToBlacklist, effectiveBlacklist, getPins, recomputeUpstreamDerived, setDecision } from '../mods/blacklist-service.js';
import { UpstreamVersionMismatchError, anomalies, buildBlockers, comparePairProblem, deriveUpstreamSides, diffModSets } from '../mods/diff.js';
import { findDuplicateIds, loadModSet, resolvedAnomalies } from '../mods/modset-store.js';
import { getProfile, type Profile } from '../profiles/profile-service.js';
import { readPackNames } from '../settings/packs.js';
import type { AppDeps } from './app.js';
import { sendBadRequest } from './routes-profiles.js';

/** Every error answer of this file is { error, code?, ...extra }, the same shape as the other routes. */
class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** null = the location holds no readable loader information (zip, CurseForge instance or unpacked server folder). */
function loaderOf(profile: Profile): Promise<LoaderInfo | null> {
  return detectLoaderForProfile(profile);
}

function profileOr404(db: Db, id: number): Profile {
  try {
    return getProfile(db, id);
  } catch (err) {
    if (err instanceof Error && /not found$/.test(err.message)) throw new HttpError(404, `profile ${id} not found`, 'profile_not_found');
    throw err; // a database failure is a 500, not a missing profile
  }
}

function skippedJarsOf(db: Db, profileId: number): string[] {
  return (db.sqlite.prepare('SELECT file FROM import_issue WHERE profile_id = ? ORDER BY file').all(profileId) as { file: string }[]).map((r) => r.file);
}

/** The followed pack's sides can only be derived from its server pack and its client, both fully imported and on the same loader. */
async function loadUpstreamPair(db: Db, serverId: number, clientId: number, upstream: string) {
  const server = profileOr404(db, serverId);
  const client = profileOr404(db, clientId);
  if (server.pack !== upstream || server.side !== 'server' || client.pack !== upstream || client.side !== 'client') {
    throw new HttpError(409, `the pair must be a ${upstream} server profile and a ${upstream} client profile`);
  }
  // The split comes from the pack's own server pack and client: a played or launched copy can carry added or removed mods.
  for (const p of [server, client]) {
    if (p.state !== 'clean') throw new HttpError(400, `profile ${p.id} is a ${p.state} copy: the sides can only be derived from clean profiles`, 'profile_not_clean');
  }
  const serverSet = loadModSet(db, server.id);
  const clientSet = loadModSet(db, client.id);
  if (serverSet.size === 0 || clientSet.size === 0) throw new HttpError(409, 'both profiles must be imported first');
  const skipped = [...skippedJarsOf(db, server.id), ...skippedJarsOf(db, client.id)];
  if (skipped.length > 0) throw new HttpError(409, `import incomplete, unreadable jars: ${skipped.join(', ')}`);
  let agreement;
  try {
    const [serverLoader, clientLoader] = await Promise.all([loaderOf(server), loaderOf(client)]);
    if (!serverLoader || !clientLoader) throw new Error(`no readable loader information for profile ${serverLoader ? client.id : server.id}`);
    agreement = checkLoaderAgreement({ server: serverLoader, client: clientLoader });
  } catch (err) {
    throw new HttpError(409, `cannot verify the loader: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!agreement.ok) throw new HttpError(409, `The mod loader or Minecraft version differ between the ${upstream} server pack and client: ${agreement.mismatches.map((m) => m.field).join(', ')}`);
  return { server, client, serverSet, clientSet };
}

export function registerModRoutes(api: FastifyInstance, deps: AppDeps): void {
  const { db } = deps;

  api.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ ...err.extra, error: err.message, ...(err.code ? { code: err.code } : {}) });
    const e = err as { statusCode?: number; code?: string; message: string };
    const status = e.statusCode;
    // Framework errors (bad JSON, body too large...) answer the same shape instead of Fastify's { statusCode, error: 'Bad Request', message }.
    if (status && status >= 400 && status < 500) return reply.code(status).send({ error: e.message, ...(e.code ? { code: e.code } : {}) });
    return reply.send(err);
  });

  api.get(`${API_PREFIX}/mods/diff`, async (req, reply) => {
    const q = DiffQuerySchema.safeParse(req.query);
    if (!q.success) return sendBadRequest(reply, q.error);
    const base = profileOr404(db, q.data.base);
    const other = profileOr404(db, q.data.other);
    const baseSet = loadModSet(db, base.id);
    const otherSet = loadModSet(db, other.id);
    const problem = comparePairProblem(base, other, baseSet, otherSet);
    if (problem) throw new HttpError(400, problem.message, problem.code);
    return diffModSets(baseSet, otherSet, { pins: getPins(db) });
  });

  api.get(`${API_PREFIX}/mods/upstream-sides`, async (req, reply) => {
    const q = UpstreamSidesQuerySchema.safeParse(req.query);
    if (!q.success) return sendBadRequest(reply, q.error);
    const { server, client, serverSet, clientSet } = await loadUpstreamPair(db, q.data.server, q.data.client, readPackNames(deps.dataDir ?? path.resolve('data')).upstream);
    try {
      return deriveUpstreamSides(serverSet, clientSet, { server: server.version, client: client.version });
    } catch (err) {
      if (err instanceof UpstreamVersionMismatchError) throw new HttpError(409, err.message, 'upstream_version_mismatch');
      throw err;
    }
  });

  api.get(`${API_PREFIX}/mods/anomalies`, async (req, reply) => {
    const q = AnomaliesQuerySchema.safeParse(req.query);
    if (!q.success) return sendBadRequest(reply, q.error);
    profileOr404(db, q.data.upstreamClient);
    profileOr404(db, q.data.own);
    return anomalies(loadModSet(db, q.data.upstreamClient), loadModSet(db, q.data.own), resolvedAnomalies(db));
  });

  api.get(`${API_PREFIX}/loader/check`, async (req, reply) => {
    const q = LoaderCheckQuerySchema.safeParse(req.query);
    if (!q.success) return sendBadRequest(reply, q.error);
    const infos: Record<string, LoaderInfo> = {};
    for (const id of q.data.profiles.split(',').map(Number)) {
      const p = profileOr404(db, id);
      try {
        const info = await loaderOf(p);
        if (info) infos[`${p.pack} ${p.version} ${p.side} ${p.state}`] = info; // unknown loader: nothing to compare
      } catch (err) {
        throw new HttpError(409, `cannot read the loader of profile ${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return checkLoaderAgreement(infos);
  });

  api.get(`${API_PREFIX}/build/blockers`, async (req, reply) => {
    const q = AnomaliesQuerySchema.safeParse(req.query);
    if (!q.success) return sendBadRequest(reply, q.error);
    profileOr404(db, q.data.upstreamClient);
    profileOr404(db, q.data.own);
    // A duplicate id that the followed pack's client already ships (seen on Base 8.3: two cc-tweaked jars) is inherited, not the player's mistake.
    const inherited = new Set(findDuplicateIds(db, q.data.upstreamClient).map((d) => d.modId));
    return buildBlockers({
      anomalies: anomalies(loadModSet(db, q.data.upstreamClient), loadModSet(db, q.data.own), resolvedAnomalies(db)),
      duplicateIds: findDuplicateIds(db, q.data.own).filter((d) => !inherited.has(d.modId)),
      skippedJars: [...skippedJarsOf(db, q.data.upstreamClient), ...skippedJarsOf(db, q.data.own)],
    });
  });

  api.get(`${API_PREFIX}/blacklist`, async (req, reply) => {
    const q = BlacklistQuerySchema.safeParse(req.query);
    if (!q.success) return sendBadRequest(reply, q.error);
    return effectiveBlacklist(db, q.data.upstreamVersion);
  });

  api.put(`${API_PREFIX}/blacklist`, async (req, reply) => {
    const body = BlacklistPutSchema.safeParse(req.body);
    if (!body.success) return sendBadRequest(reply, body.error);
    if (body.data.action === 'add') {
      addToBlacklist(db, body.data.modId, body.data.reason);
      return { ok: true };
    }
    const { server, client, serverSet, clientSet } = await loadUpstreamPair(db, body.data.server, body.data.client, readPackNames(deps.dataDir ?? path.resolve('data')).upstream);
    try {
      const sides = deriveUpstreamSides(serverSet, clientSet, { server: server.version, client: client.version });
      recomputeUpstreamDerived(db, server.version, sides.clientOnly);
      return { ok: true, added: sides.clientOnly.length };
    } catch (err) {
      if (err instanceof UpstreamVersionMismatchError) throw new HttpError(409, err.message, 'upstream_version_mismatch');
      throw err;
    }
  });

  api.put(`${API_PREFIX}/mods/:modId/decision`, async (req, reply) => {
    const modId = NewModIdSchema.safeParse((req.params as { modId: string }).modId);
    const body = DecisionBodySchema.safeParse(req.body);
    if (!modId.success) return sendBadRequest(reply, modId.error);
    if (!body.success) return sendBadRequest(reply, body.error);
    setDecision(db, { modId: modId.data, ...body.data });
    return { ok: true };
  });
}

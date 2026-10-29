import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { API_PREFIX } from '../../shared/constants.js';
import {
  AnomaliesQuerySchema,
  AtmSidesQuerySchema,
  BlacklistPutSchema,
  BlacklistQuerySchema,
  DecisionBodySchema,
  DiffQuerySchema,
  LoaderCheckQuerySchema,
} from '../../shared/schemas/mods.js';
import type { Db } from '../db/open.js';
import { checkLoaderAgreement, detectLoader, type LoaderInfo } from '../loader/detect-loader.js';
import { addToBlacklist, effectiveBlacklist, getPins, recomputeAtmDerived, setDecision } from '../mods/blacklist-service.js';
import { AtmVersionMismatchError, anomalies, buildBlockers, deriveAtmSides, diffModSets } from '../mods/diff.js';
import { findDuplicateIds, loadModSet, resolvedAnomalies } from '../mods/modset-store.js';
import { getProfile, type Profile } from '../profiles/profile-service.js';
import { readPackNames } from '../settings/packs.js';
import type { AppDeps } from './app.js';
import { sendBadRequest } from './routes-profiles.js';

class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

async function loaderOf(profile: Profile): Promise<LoaderInfo> {
  return detectLoader(profile.locationKind === 'zip' ? { kind: 'serverZip', path: profile.location } : { kind: 'curseforgeInstance', path: profile.location });
}

function profileOr404(db: Db, id: number): Profile {
  try {
    return getProfile(db, id);
  } catch {
    throw new HttpError(404, `profile ${id} not found`);
  }
}

function skippedJarsOf(db: Db, profileId: number): string[] {
  return (db.sqlite.prepare('SELECT file FROM import_issue WHERE profile_id = ? ORDER BY file').all(profileId) as { file: string }[]).map((r) => r.file);
}

/** The followed pack's sides can only be derived from its server pack and its client, both fully imported and on the same loader. */
async function loadAtmPair(db: Db, serverId: number, clientId: number, upstream: string) {
  const server = profileOr404(db, serverId);
  const client = profileOr404(db, clientId);
  if (server.pack !== upstream || server.side !== 'server' || client.pack !== upstream || client.side !== 'client') {
    throw new HttpError(409, `the pair must be a ${upstream} server profile and a ${upstream} client profile`);
  }
  const serverSet = loadModSet(db, server.id);
  const clientSet = loadModSet(db, client.id);
  if (serverSet.size === 0 || clientSet.size === 0) throw new HttpError(409, 'both profiles must be imported first');
  const skipped = [...skippedJarsOf(db, server.id), ...skippedJarsOf(db, client.id)];
  if (skipped.length > 0) throw new HttpError(409, `import incomplete, unreadable jars: ${skipped.join(', ')}`);
  let agreement;
  try {
    agreement = checkLoaderAgreement({ server: await loaderOf(server), client: await loaderOf(client) });
  } catch (err) {
    throw new HttpError(409, `cannot verify the loader: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!agreement.ok) throw new HttpError(409, `NeoForge/Minecraft differ between the ${upstream} server pack and client: ${agreement.mismatches.map((m) => m.field).join(', ')}`);
  return { server, client, serverSet, clientSet };
}

export function registerModRoutes(api: FastifyInstance, deps: AppDeps): void {
  const { db } = deps;

  api.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    return reply.send(err);
  });

  api.get(`${API_PREFIX}/mods/diff`, async (req, reply) => {
    const q = DiffQuerySchema.safeParse(req.query);
    if (!q.success) return sendBadRequest(reply, q.error);
    profileOr404(db, q.data.base);
    profileOr404(db, q.data.other);
    return diffModSets(loadModSet(db, q.data.base), loadModSet(db, q.data.other), { pins: getPins(db) });
  });

  api.get(`${API_PREFIX}/mods/atm-sides`, async (req, reply) => {
    const q = AtmSidesQuerySchema.safeParse(req.query);
    if (!q.success) return sendBadRequest(reply, q.error);
    const { server, client, serverSet, clientSet } = await loadAtmPair(db, q.data.server, q.data.client, readPackNames(deps.dataDir ?? path.resolve('data')).upstream);
    try {
      return deriveAtmSides(serverSet, clientSet, { server: server.version, client: client.version });
    } catch (err) {
      if (err instanceof AtmVersionMismatchError) throw new HttpError(409, err.message);
      throw err;
    }
  });

  api.get(`${API_PREFIX}/mods/anomalies`, async (req, reply) => {
    const q = AnomaliesQuerySchema.safeParse(req.query);
    if (!q.success) return sendBadRequest(reply, q.error);
    profileOr404(db, q.data.atmClient);
    profileOr404(db, q.data.lmp);
    return anomalies(loadModSet(db, q.data.atmClient), loadModSet(db, q.data.lmp), resolvedAnomalies(db));
  });

  api.get(`${API_PREFIX}/loader/check`, async (req, reply) => {
    const q = LoaderCheckQuerySchema.safeParse(req.query);
    if (!q.success) return sendBadRequest(reply, q.error);
    const infos: Record<string, LoaderInfo> = {};
    for (const id of q.data.profiles.split(',').map(Number)) {
      const p = profileOr404(db, id);
      try {
        infos[`${p.pack} ${p.version} ${p.side}`] = await loaderOf(p);
      } catch (err) {
        throw new HttpError(409, `cannot read the loader of profile ${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return checkLoaderAgreement(infos);
  });

  api.get(`${API_PREFIX}/build/blockers`, async (req, reply) => {
    const q = AnomaliesQuerySchema.safeParse(req.query);
    if (!q.success) return sendBadRequest(reply, q.error);
    profileOr404(db, q.data.atmClient);
    profileOr404(db, q.data.lmp);
    // A duplicate id that the followed pack's client already ships (seen on Base 8.3: two cc-tweaked jars) is inherited, not the player's mistake.
    const inherited = new Set(findDuplicateIds(db, q.data.atmClient).map((d) => d.modId));
    return buildBlockers({
      anomalies: anomalies(loadModSet(db, q.data.atmClient), loadModSet(db, q.data.lmp), resolvedAnomalies(db)),
      duplicateIds: findDuplicateIds(db, q.data.lmp).filter((d) => !inherited.has(d.modId)),
      skippedJars: [...skippedJarsOf(db, q.data.atmClient), ...skippedJarsOf(db, q.data.lmp)],
    });
  });

  api.get(`${API_PREFIX}/blacklist`, async (req, reply) => {
    const q = BlacklistQuerySchema.safeParse(req.query);
    if (!q.success) return sendBadRequest(reply, q.error);
    return effectiveBlacklist(db, q.data.atmVersion);
  });

  api.put(`${API_PREFIX}/blacklist`, async (req, reply) => {
    const body = BlacklistPutSchema.safeParse(req.body);
    if (!body.success) return sendBadRequest(reply, body.error);
    if (body.data.action === 'add') {
      addToBlacklist(db, body.data.modId, body.data.reason);
      return { ok: true };
    }
    const { server, client, serverSet, clientSet } = await loadAtmPair(db, body.data.server, body.data.client, readPackNames(deps.dataDir ?? path.resolve('data')).upstream);
    try {
      const sides = deriveAtmSides(serverSet, clientSet, { server: server.version, client: client.version });
      recomputeAtmDerived(db, server.version, sides.clientOnly);
      return { ok: true, added: sides.clientOnly.length };
    } catch (err) {
      if (err instanceof AtmVersionMismatchError) throw new HttpError(409, err.message);
      throw err;
    }
  });

  api.put(`${API_PREFIX}/mods/:modId/decision`, async (req, reply) => {
    const modId = z.string().min(1).safeParse((req.params as { modId: string }).modId);
    const body = DecisionBodySchema.safeParse(req.body);
    if (!modId.success) return sendBadRequest(reply, modId.error);
    if (!body.success) return sendBadRequest(reply, body.error);
    setDecision(db, { modId: modId.data, ...body.data });
    return { ok: true };
  });
}

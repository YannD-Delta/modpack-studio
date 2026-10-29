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
import { checkLoaderAgreement, detectLoader, type LoaderInfo } from '../loader/detect-loader.js';
import { addToBlacklist, effectiveBlacklist, getPins, recomputeAtmDerived, setDecision } from '../mods/blacklist-service.js';
import { AtmVersionMismatchError, anomalies, buildBlockers, deriveAtmSides, diffModSets } from '../mods/diff.js';
import { findDuplicateIds, loadModSet, resolvedAnomalies } from '../mods/modset-store.js';
import { getProfile, type Profile } from '../profiles/profile-service.js';
import type { AppDeps } from './app.js';
import { sendBadRequest } from './routes-profiles.js';

async function loaderOf(profile: Profile): Promise<LoaderInfo> {
  return detectLoader(profile.locationKind === 'zip' ? { kind: 'serverZip', path: profile.location } : { kind: 'curseforgeInstance', path: profile.location });
}

export function registerModRoutes(api: FastifyInstance, deps: AppDeps): void {
  const { db } = deps;

  api.get(`${API_PREFIX}/mods/diff`, async (req, reply) => {
    const q = DiffQuerySchema.safeParse(req.query);
    if (!q.success) return sendBadRequest(reply, q.error);
    return diffModSets(loadModSet(db, q.data.base), loadModSet(db, q.data.other), { pins: getPins(db) });
  });

  api.get(`${API_PREFIX}/mods/atm-sides`, async (req, reply) => {
    const q = AtmSidesQuerySchema.safeParse(req.query);
    if (!q.success) return sendBadRequest(reply, q.error);
    const server = getProfile(db, q.data.server);
    const client = getProfile(db, q.data.client);
    try {
      return deriveAtmSides(loadModSet(db, server.id), loadModSet(db, client.id), { server: server.version, client: client.version });
    } catch (err) {
      if (err instanceof AtmVersionMismatchError) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  api.get(`${API_PREFIX}/mods/anomalies`, async (req, reply) => {
    const q = AnomaliesQuerySchema.safeParse(req.query);
    if (!q.success) return sendBadRequest(reply, q.error);
    return anomalies(loadModSet(db, q.data.atmClient), loadModSet(db, q.data.lmp), resolvedAnomalies(db));
  });

  api.get(`${API_PREFIX}/loader/check`, async (req, reply) => {
    const q = LoaderCheckQuerySchema.safeParse(req.query);
    if (!q.success) return sendBadRequest(reply, q.error);
    const infos: Record<string, LoaderInfo> = {};
    for (const id of q.data.profiles.split(',').map(Number)) {
      const p = getProfile(db, id);
      infos[`${p.pack} ${p.version} ${p.side}`] = await loaderOf(p);
    }
    return checkLoaderAgreement(infos);
  });

  api.get(`${API_PREFIX}/build/blockers`, async (req, reply) => {
    const q = AnomaliesQuerySchema.safeParse(req.query);
    if (!q.success) return sendBadRequest(reply, q.error);
    return buildBlockers({
      anomalies: anomalies(loadModSet(db, q.data.atmClient), loadModSet(db, q.data.lmp), resolvedAnomalies(db)),
      duplicateIds: findDuplicateIds(db, q.data.lmp),
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
    const server = getProfile(db, body.data.server);
    const client = getProfile(db, body.data.client);
    try {
      const sides = deriveAtmSides(loadModSet(db, server.id), loadModSet(db, client.id), { server: server.version, client: client.version });
      recomputeAtmDerived(db, server.version, sides.clientOnly);
      return { ok: true, added: sides.clientOnly.length };
    } catch (err) {
      if (err instanceof AtmVersionMismatchError) return reply.code(409).send({ error: err.message });
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

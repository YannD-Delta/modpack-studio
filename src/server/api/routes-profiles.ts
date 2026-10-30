import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { API_PREFIX } from '../../shared/constants.js';
import { ImportBodySchema, NewProfileSchema, PatchProfileSchema } from '../../shared/schemas/profile.js';
import { audit } from '../db/audit.js';
import { inventoryCachePath } from '../configs/inventory-cache.js';
import { knownPack, readPackNames } from '../settings/packs.js';
import type { AppDeps } from './app.js';
import { importModSet } from '../mods/import-modset.js';
import {
  DuplicateProfileError,
  LaunchArtifactsError,
  LocationError,
  createProfile,
  deleteProfile,
  detectLaunchArtifacts,
  getProfile,
  importStatus,
  listMatrix,
  relocateProfile,
  validateLocation,
} from '../profiles/profile-service.js';

export function sendBadRequest(reply: FastifyReply, error: z.ZodError) {
  return reply.code(400).send({ error: error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
}

/** True while a queued or running job (import or config scan) holds the profile. */
function hasActiveJob(db: AppDeps['db'], profileId: number): boolean {
  return !!db.sqlite.prepare("SELECT 1 FROM job WHERE lock_key IN (?, ?) AND status IN ('queued', 'running')").get(`import:${profileId}`, `configs:${profileId}`);
}

const ALREADY_IMPORTED = 'this profile is immutable and already imported';
const JOB_RUNNING = 'a job is running for this profile, wait for it to finish';

const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

export function registerProfileRoutes(api: FastifyInstance, deps: AppDeps): void {
  const { db, jobs } = deps;

  jobs.register('import-modset', async (ctx) => {
    const params = z.object({ profileId: z.number(), source: ImportBodySchema.shape.source }).parse(ctx.params);
    // Re-checked when the job starts: the route check alone cannot stop two requests sent before the first job ran.
    const current = getProfile(db, params.profileId);
    if (current.immutable && importStatus(db, current.id).complete) throw new Error(ALREADY_IMPORTED);
    const result = await importModSet(db, params.source, params.profileId, ctx);
    audit(db, 'profile.import', String(params.profileId), { imported: result.imported, skipped: result.skipped.length, duplicates: result.duplicateIds.length });
    if (result.imported === 0) throw new Error(`nothing imported: ${result.skipped.map((s) => s.reason).join('; ') || 'no jar found'}`);
    ctx.progress(100, `imported ${result.imported}, skipped ${result.skipped.length}, duplicate ids ${result.duplicateIds.length}`);
  });

  api.post(`${API_PREFIX}/profiles`, async (req, reply) => {
    const body = NewProfileSchema.safeParse(req.body);
    if (!body.success) return sendBadRequest(reply, body.error);
    const names = readPackNames(deps.dataDir ?? path.resolve('data'));
    if (!knownPack(names, body.data.pack)) return reply.code(400).send({ error: `pack must be "${names.upstream}" or "${names.own}" (change the names in Settings)` });
    try {
      validateLocation(body.data.locationKind, body.data.location);
      const profile = createProfile(db, body.data);
      audit(db, 'profile.create', String(profile.id), body.data);
      return reply.code(201).send(profile);
    } catch (err) {
      if (err instanceof LaunchArtifactsError) return reply.code(422).send({ error: err.message, artifacts: err.artifacts });
      if (err instanceof LocationError) return reply.code(err.status).send({ error: err.message, code: err.code });
      if (err instanceof DuplicateProfileError) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  api.get(`${API_PREFIX}/profiles/matrix`, async () => listMatrix(db));

  api.post(`${API_PREFIX}/profiles/:id/import`, async (req, reply) => {
    const id = z.coerce.number().int().positive().safeParse((req.params as { id: string }).id);
    const body = ImportBodySchema.safeParse(req.body);
    if (!id.success) return sendBadRequest(reply, id.error);
    if (!body.success) return sendBadRequest(reply, body.error);

    let profile;
    try {
      profile = getProfile(db, id.data);
    } catch {
      return reply.code(404).send({ error: 'profile not found' });
    }
    // The only thing that can be imported into a profile is its own registered location.
    const expectedKind = profile.locationKind === 'zip' ? 'zip' : 'folder';
    if (body.data.source.kind !== expectedKind || !samePath(body.data.source.path, profile.location)) {
      return reply.code(400).send({ error: 'source must be the profile location' });
    }
    // An immutable snapshot is imported once, but stays open to a retry while the last import skipped unreadable jars or never completed.
    if (profile.immutable && importStatus(db, profile.id).complete) return reply.code(409).send({ error: ALREADY_IMPORTED });
    if (hasActiveJob(db, profile.id)) return reply.code(409).send({ error: JOB_RUNNING });
    if (profile.state === 'clean' && expectedKind === 'folder') {
      const artifacts = detectLaunchArtifacts(profile.location);
      if (artifacts.length) return reply.code(422).send({ error: `launch artifacts found, this is not a clean profile: ${artifacts.join(', ')}`, artifacts });
    }

    const jobId = jobs.enqueue('import-modset', { profileId: profile.id, source: body.data.source }, { lockKey: `import:${profile.id}` });
    return reply.code(202).send({ jobId });
  });

  const parseId = (req: { params: unknown }) => z.coerce.number().int().positive().safeParse((req.params as { id: string }).id);

  api.patch(`${API_PREFIX}/profiles/:id`, async (req, reply) => {
    const id = parseId(req);
    const body = PatchProfileSchema.safeParse(req.body);
    if (!id.success) return sendBadRequest(reply, id.error);
    if (!body.success) return sendBadRequest(reply, body.error);
    try {
      getProfile(db, id.data);
    } catch {
      return reply.code(404).send({ error: 'profile not found' });
    }
    if (hasActiveJob(db, id.data)) return reply.code(409).send({ error: JOB_RUNNING });
    try {
      const profile = relocateProfile(db, id.data, body.data.location);
      audit(db, 'profile.update', String(profile.id), { location: profile.location });
      return reply.send(profile);
    } catch (err) {
      if (err instanceof LocationError) return reply.code(err.status).send({ error: err.message, code: err.code });
      if (err instanceof LaunchArtifactsError) return reply.code(422).send({ error: err.message, artifacts: err.artifacts });
      throw err;
    }
  });

  api.delete(`${API_PREFIX}/profiles/:id`, async (req, reply) => {
    const id = parseId(req);
    if (!id.success) return sendBadRequest(reply, id.error);
    let profile;
    try {
      profile = getProfile(db, id.data);
    } catch {
      return reply.code(404).send({ error: 'profile not found' });
    }
    if (hasActiveJob(db, profile.id)) return reply.code(409).send({ error: JOB_RUNNING });
    deleteProfile(db, profile.id);
    // The scan cache is keyed by profile id: a stale file would be served to a later profile that reuses the number.
    fs.rmSync(inventoryCachePath(deps.dataDir ?? path.resolve('data'), profile.id), { force: true });
    audit(db, 'profile.delete', String(profile.id), { pack: profile.pack, version: profile.version, side: profile.side, state: profile.state });
    return reply.code(204).send();
  });
}

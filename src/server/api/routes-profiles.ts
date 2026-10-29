import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { API_PREFIX } from '../../shared/constants.js';
import { ImportBodySchema, NewProfileSchema } from '../../shared/schemas/profile.js';
import { audit } from '../db/audit.js';
import { knownPack, readPackNames } from '../settings/packs.js';
import type { AppDeps } from './app.js';
import { importModSet } from '../mods/import-modset.js';
import { isProcessRunningFrom } from '../profiles/process-check.js';
import {
  DuplicateProfileError,
  LaunchArtifactsError,
  ProcessRunningError,
  createProfile,
  detectLaunchArtifacts,
  getProfile,
  listMatrix,
} from '../profiles/profile-service.js';

export function sendBadRequest(reply: FastifyReply, error: z.ZodError) {
  return reply.code(400).send({ error: error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
}

const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

export function registerProfileRoutes(api: FastifyInstance, deps: AppDeps): void {
  const { db, jobs } = deps;

  jobs.register('import-modset', async (ctx) => {
    const params = z.object({ profileId: z.number(), source: ImportBodySchema.shape.source }).parse(ctx.params);
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
      const profile = createProfile(db, body.data, { isProcessRunning: (location) => body.data.locationKind === 'folder' && isProcessRunningFrom(location) });
      audit(db, 'profile.create', String(profile.id), body.data);
      return reply.code(201).send(profile);
    } catch (err) {
      if (err instanceof LaunchArtifactsError) return reply.code(422).send({ error: err.message, artifacts: err.artifacts });
      if (err instanceof DuplicateProfileError || err instanceof ProcessRunningError) return reply.code(409).send({ error: err.message });
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
    const alreadyImported = (db.sqlite.prepare('SELECT count(*) AS n FROM jar_mod WHERE profile_id = ?').get(profile.id) as { n: number }).n > 0;
    if (profile.immutable && alreadyImported) return reply.code(409).send({ error: 'this profile is immutable and already imported' });
    if (profile.state === 'clean' && expectedKind === 'folder') {
      const artifacts = detectLaunchArtifacts(profile.location);
      if (artifacts.length) return reply.code(422).send({ error: `launch artifacts found, this is not a clean profile: ${artifacts.join(', ')}`, artifacts });
    }

    const jobId = jobs.enqueue('import-modset', { profileId: profile.id, source: body.data.source }, { lockKey: `import:${profile.id}` });
    return reply.code(202).send({ jobId });
  });
}

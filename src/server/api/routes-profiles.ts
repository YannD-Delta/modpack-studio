import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { API_PREFIX } from '../../shared/constants.js';
import { ImportBodySchema, NewProfileSchema } from '../../shared/schemas/profile.js';
import { audit } from '../db/audit.js';
import type { AppDeps } from './app.js';
import { importModSet } from '../mods/import-modset.js';
import {
  DuplicateProfileError,
  LaunchArtifactsError,
  ProcessRunningError,
  createProfile,
  getProfile,
  listMatrix,
} from '../profiles/profile-service.js';

export function sendBadRequest(reply: FastifyReply, error: z.ZodError) {
  return reply.code(400).send({ error: error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
}

export function registerProfileRoutes(api: FastifyInstance, deps: AppDeps): void {
  const { db, jobs } = deps;

  jobs.register('import-modset', async (ctx) => {
    const params = z.object({ profileId: z.number(), source: ImportBodySchema.shape.source }).parse(ctx.params);
    const result = await importModSet(db, params.source, params.profileId, ctx);
    audit(db, 'profile.import', String(params.profileId), { imported: result.imported, skipped: result.skipped.length, duplicates: result.duplicateIds.length });
    ctx.progress(100, `imported ${result.imported}, skipped ${result.skipped.length}, duplicate ids ${result.duplicateIds.length}`);
  });

  api.post(`${API_PREFIX}/profiles`, async (req, reply) => {
    const body = NewProfileSchema.safeParse(req.body);
    if (!body.success) return sendBadRequest(reply, body.error);
    try {
      const profile = createProfile(db, body.data);
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
    try {
      getProfile(db, id.data);
    } catch {
      return reply.code(404).send({ error: 'profile not found' });
    }
    const jobId = jobs.enqueue('import-modset', { profileId: id.data, source: body.data.source }, { lockKey: `import:${id.data}` });
    return reply.code(202).send({ jobId });
  });
}

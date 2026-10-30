import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { API_PREFIX } from '../../shared/constants.js';
import { buildClientRunPrompt } from '../assistant/prompts.js';
import { audit } from '../db/audit.js';
import { buildServerPack, ServerPackError } from '../mods/server-pack.js';
import { getProfile, type Profile } from '../profiles/profile-service.js';
import { readPackNames } from '../settings/packs.js';
import { ClientLogsError, readClientLogs } from '../testbench/client-logs.js';
import type { AppDeps } from './app.js';
import { sendBadRequest } from './routes-profiles.js';

const PackBody = z.object({ profile: z.number().int().positive(), includeUnknown: z.boolean().optional() });
const LogsQuery = z.object({ profile: z.coerce.number().int().positive() });
const PromptBody = z.object({ profile: z.number().int().positive(), mode: z.enum(['chat', 'api']).default('chat') });

const PACK_STATUS: Record<ServerPackError['code'], number> = { not_a_server: 400, not_a_folder: 400, inside_source: 400, not_imported: 409, sides_undecided: 409, folder_missing: 409 };
const LOGS_STATUS: Record<ClientLogsError['code'], number> = { not_a_client: 400, wrong_state: 400, not_a_folder: 400, folder_missing: 409 };

/** Server pack zip, and the summary of the logs of a client run by hand. Both only read the profile folder. */
export function registerBuildRoutes(api: FastifyInstance, deps: AppDeps): void {
  const { db } = deps;
  const dataDir = deps.dataDir ?? path.resolve('data');

  const profileOr404 = (id: number, reply: FastifyReply): Profile | null => {
    try {
      return getProfile(db, id);
    } catch {
      void reply.code(404).send({ error: `profile ${id} not found`, code: 'profile_not_found' });
      return null;
    }
  };

  api.post(`${API_PREFIX}/build/server-pack`, async (req, reply) => {
    const body = PackBody.safeParse(req.body);
    if (!body.success) return sendBadRequest(reply, body.error);
    const profile = profileOr404(body.data.profile, reply);
    if (!profile) return reply;
    try {
      const r = await buildServerPack({ db, profile, exportsDir: path.join(dataDir, 'exports'), includeUnknown: body.data.includeUnknown });
      audit(db, 'build.server-pack', String(profile.id), { name: r.name, mods: r.mods, leftOut: r.leftOut.length });
      return { name: r.name, folder: r.folder, zip: r.zipPath, zipBytes: r.zipBytes, mods: r.mods, files: r.files, leftOut: r.leftOut, unlisted: r.unlisted, undecided: r.undecided };
    } catch (err) {
      if (err instanceof ServerPackError) return reply.code(PACK_STATUS[err.code]).send({ error: err.message, code: err.code, ...(err.code === 'sides_undecided' ? { undecided: err.undecided } : {}) });
      throw err;
    }
  });

  const logsOf = (id: number, reply: FastifyReply) => {
    const profile = profileOr404(id, reply);
    if (!profile) return null;
    try {
      return readClientLogs(db, profile);
    } catch (err) {
      if (err instanceof ClientLogsError) {
        void reply.code(LOGS_STATUS[err.code]).send({ error: err.message, code: err.code });
        return null;
      }
      throw err;
    }
  };

  api.get(`${API_PREFIX}/testbench/client-logs`, async (req, reply) => {
    const q = LogsQuery.safeParse(req.query);
    if (!q.success) return sendBadRequest(reply, q.error);
    return logsOf(q.data.profile, reply) ?? reply;
  });

  /** Prompt of the "analyze-client-run" action, built from the same summary (to copy into claude.ai). */
  api.post(`${API_PREFIX}/testbench/client-logs/prompt`, async (req, reply) => {
    const body = PromptBody.safeParse(req.body);
    if (!body.success) return sendBadRequest(reply, body.error);
    const logs = logsOf(body.data.profile, reply);
    if (!logs) return reply;
    return buildClientRunPrompt({ logs, mode: body.data.mode, names: readPackNames(dataDir) });
  });
}

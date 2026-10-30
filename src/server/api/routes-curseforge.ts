import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { API_PREFIX } from '../../shared/constants.js';
import { detectLoaderForProfile } from '../loader/detect-loader.js';
import { CurseForgeClient, CurseForgeError, LOADER_TYPE, newestFile, type CurseForgeFile } from '../mods/curseforge-api.js';
import { getSources, type CfSource } from '../mods/curseforge-sources.js';
import { mapLimited } from '../mods/import-modset.js';
import { getProfile } from '../profiles/profile-service.js';
import { getNumberLimit } from '../settings/limits.js';
import { getSecret } from '../settings/secrets-store.js';
import type { AppDeps } from './app.js';
import { sendBadRequest } from './routes-profiles.js';

const UpdatesQuery = z.object({
  profile: z.coerce.number().int().positive(),
  gameVersion: z.string().trim().min(1).max(40).optional(),
  preRelease: z.enum(['0', '1']).optional(),
});

export type CurseForgeUpdate = {
  projectId: number;
  name: string;
  url: string;
  installed: { fileId: number; fileName: string };
  latest: { id: number; displayName: string; fileName: string; fileDate: string; releaseType: number };
};

/**
 * CurseForge links and newer files for the mods of a CurseForge instance profile: the instance file already says which project and file each jar is,
 * so no fingerprint is needed. The key is read from the settings and never leaves the server.
 */
export function registerCurseForgeRoutes(api: FastifyInstance, deps: AppDeps): void {
  const { db } = deps;
  const dataDir = deps.dataDir ?? path.resolve('data');

  /** Every jar of the profile that is known to CurseForge, for showing a link next to the file name. */
  api.get(`${API_PREFIX}/curseforge/sources`, async (req, reply) => {
    const q = z.object({ profile: z.coerce.number().int().positive() }).safeParse(req.query);
    if (!q.success) return sendBadRequest(reply, q.error);
    const sources = [...getSources(db, q.data.profile).values()];
    return { sources };
  });

  api.get(`${API_PREFIX}/curseforge/updates`, async (req, reply) => {
    const q = UpdatesQuery.safeParse(req.query);
    if (!q.success) return sendBadRequest(reply, q.error);
    let profile;
    try {
      profile = getProfile(db, q.data.profile);
    } catch (err) {
      if (err instanceof Error && /not found$/.test(err.message)) return reply.code(404).send({ error: `profile ${q.data.profile} not found`, code: 'profile_not_found' });
      throw err;
    }
    const key = getSecret(dataDir, 'curseforge');
    if (!key) return reply.code(409).send({ error: 'no CurseForge key saved: add it in Settings', code: 'no_key' });

    const sources = [...getSources(db, profile.id).values()];
    if (sources.length === 0) return { gameVersion: null, loader: null, checked: 0, upToDate: 0, updates: [], failed: [], noSources: true };

    const info = await detectLoaderForProfile(profile).catch(() => null);
    const gameVersion = q.data.gameVersion ?? info?.mcVersion ?? null;
    const loaderType = info ? LOADER_TYPE[info.loader] : null;
    const client = new CurseForgeClient(key, { fetchImpl: deps.fetchImpl });
    const byProject = new Map<number, CfSource[]>();
    for (const s of sources) byProject.set(s.projectId, [...(byProject.get(s.projectId) ?? []), s]);

    const updates: CurseForgeUpdate[] = [];
    const failed: { projectId: number; name: string; code: string }[] = [];
    let upToDate = 0;
    try {
      await mapLimited([...byProject.entries()], getNumberLimit('curseforge.concurrency'), async ([projectId, installed]) => {
        let latest: CurseForgeFile | null;
        try {
          latest = newestFile(await client.files(projectId, { gameVersion, loaderType }), { allowPreRelease: q.data.preRelease === '1' });
        } catch (err) {
          if (err instanceof CurseForgeError && (err.code === 'rejected' || err.code === 'rate_limited')) throw err; // the same for every project: stop
          failed.push({ projectId, name: installed[0]!.name, code: err instanceof CurseForgeError ? err.code : 'unexpected' });
          return;
        }
        for (const s of installed) {
          if (latest && latest.id > s.fileId) {
            updates.push({
              projectId,
              name: s.name,
              url: s.url,
              installed: { fileId: s.fileId, fileName: s.fileName },
              latest: { id: latest.id, displayName: latest.displayName, fileName: latest.fileName, fileDate: latest.fileDate, releaseType: latest.releaseType },
            });
          } else upToDate++;
        }
      });
    } catch (err) {
      if (err instanceof CurseForgeError) return reply.code(err.code === 'rate_limited' ? 429 : 502).send({ error: err.message, code: err.code });
      throw err;
    }
    updates.sort((a, b) => a.name.localeCompare(b.name));
    return { gameVersion, loader: info?.loader ?? null, checked: sources.length, upToDate, updates, failed, noSources: false };
  });
}

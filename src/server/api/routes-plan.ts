import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { API_PREFIX } from '../../shared/constants.js';
import { DiffQuerySchema } from '../../shared/schemas/mods.js';
import { compareVersions, explainCompare } from '../../shared/versions.js';
import { audit } from '../db/audit.js';
import type { Db } from '../db/open.js';
import { effectiveBlacklist, getPins } from '../mods/blacklist-service.js';
import { comparePairProblem, diffModSets } from '../mods/diff.js';
import { readPackNames } from '../settings/packs.js';
import { findDuplicateIds, loadModSet } from '../mods/modset-store.js';
import { EXPORT_NAME, buildUpdatePack, listExports, openSource, profileTitle, readExportResult, sha256Hex } from '../mods/update-pack.js';
import { actionableMods, isSafePlanFileKey, MAX_FILE_KEY_LENGTH } from '../plan/plan-keys.js';
import { clearPlan, getPlanItems, setPlanItems } from '../plan/plan-store.js';
import { getProfile, type Profile } from '../profiles/profile-service.js';
import type { AppDeps } from './app.js';
import { sendBadRequest } from './routes-profiles.js';

const JOB_TYPE = 'export-update-pack';
export const MAX_PLAN_KEYS = 5000;

const id = z.coerce.number().int().positive();
const PlanQuerySchema = z.object({ base: id, other: id, kind: z.enum(['mod', 'file']).optional() });
const PlanPutSchema = z.object({
  base: id,
  other: id,
  kind: z.enum(['mod', 'file']),
  keys: z.array(z.string().min(1).max(MAX_FILE_KEY_LENGTH)).min(1).max(MAX_PLAN_KEYS),
  selected: z.boolean(),
});
const ExportBodySchema = z.object({ base: id, other: id });

class PlanHttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly code?: string) {
    super(message);
  }
}

/** A client against a server pack is not a meaningful update plan (same rule as GET /mods/diff, sides only: imports are checked separately). */
function assertSameSide(db: Db, base: Profile, other: Profile): void {
  const problem = comparePairProblem(base, other, loadModSet(db, base.id), loadModSet(db, other.id));
  if (problem?.code === 'sides_differ') throw new PlanHttpError(400, problem.message, problem.code);
}

function profileOr404(db: Db, profileId: number): Profile {
  try {
    return getProfile(db, profileId);
  } catch {
    throw new PlanHttpError(404, `profile ${profileId} not found`);
  }
}

function send(reply: FastifyReply, err: unknown) {
  if (err instanceof PlanHttpError) return reply.code(err.status).send({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  throw err;
}

type DecisionRow = { mod_id: string; kind: 'side' | 'pin' | 'ignore'; side: string | null; reason: string; created_at: string };

function decisionsSummary(db: Db) {
  const rows = db.sqlite.prepare('SELECT mod_id, kind, side FROM mod_decision ORDER BY mod_id').all() as Pick<DecisionRow, 'mod_id' | 'kind' | 'side'>[];
  return {
    pins: rows.filter((r) => r.kind === 'pin').map((r) => r.mod_id),
    ignored: rows.filter((r) => r.kind === 'ignore').map((r) => r.mod_id),
    clientOnly: rows.filter((r) => r.kind === 'side' && r.side === 'client').map((r) => r.mod_id),
  };
}

const profileInfo = (p: Profile) => ({ id: p.id, label: profileTitle(p), pack: p.pack, version: p.version, side: p.side, state: p.state, locationKind: p.locationKind, location: p.location });

export function registerPlanRoutes(api: FastifyInstance, deps: AppDeps): void {
  const { db, jobs } = deps;
  const exportsDir = path.join(deps.dataDir ?? path.resolve('data'), 'exports');

  // The last progress message of a successful export is `export <name>: ...` (buildUpdatePack), kept in the job row.
  jobs.register(JOB_TYPE, async (ctx) => {
    const params = ExportBodySchema.parse(ctx.params);
    const result = await buildUpdatePack({ db, base: getProfile(db, params.base), other: getProfile(db, params.other), exportsDir, signal: ctx.signal, progress: ctx.progress });
    audit(db, 'plan.export', result.name, { base: params.base, other: params.other, counts: result.counts });
    return result;
  });

  api.get(`${API_PREFIX}/plan`, async (req, reply) => {
    const q = PlanQuerySchema.safeParse(req.query);
    if (!q.success) return sendBadRequest(reply, q.error);
    try {
      profileOr404(db, q.data.base);
      profileOr404(db, q.data.other);
    } catch (err) {
      return send(reply, err);
    }
    return { items: getPlanItems(db, q.data.base, q.data.other, q.data.kind), decisions: decisionsSummary(db) };
  });

  api.put(`${API_PREFIX}/plan`, async (req, reply) => {
    const body = PlanPutSchema.safeParse(req.body);
    if (!body.success) return sendBadRequest(reply, body.error);
    const { base, other, kind, keys, selected } = body.data;
    try {
      assertSameSide(db, profileOr404(db, base), profileOr404(db, other));
    } catch (err) {
      return send(reply, err);
    }
    if (kind === 'file') {
      const unsafe = keys.filter((k) => !isSafePlanFileKey(k));
      if (unsafe.length) return reply.code(400).send({ error: `unsafe file keys (relative path with forward slashes, no .., drive or colon): ${unsafe.slice(0, 20).join(', ')}` });
    } else if (selected) {
      // Only what the current comparison says can take the reference jar; unselecting stays possible for stale keys.
      const actionable = actionableMods(diffModSets(loadModSet(db, base), loadModSet(db, other), { pins: getPins(db) }));
      const rejected = keys.filter((k) => !actionable.has(k));
      if (rejected.length) return reply.code(400).send({ error: `not updatable in this comparison (only older, different, rebuilt or missing mods): ${rejected.slice(0, 50).join(', ')}`, rejected });
    }
    setPlanItems(db, base, other, kind, [...new Set(keys)], selected);
    return { ok: true, items: getPlanItems(db, base, other) };
  });

  api.delete(`${API_PREFIX}/plan`, async (req, reply) => {
    const q = PlanQuerySchema.safeParse(req.query);
    if (!q.success) return sendBadRequest(reply, q.error);
    try {
      profileOr404(db, q.data.base);
      profileOr404(db, q.data.other);
    } catch (err) {
      return send(reply, err);
    }
    clearPlan(db, q.data.base, q.data.other, q.data.kind);
    return { ok: true };
  });

  api.post(`${API_PREFIX}/plan/export`, async (req, reply) => {
    const body = ExportBodySchema.safeParse(req.body);
    if (!body.success) return sendBadRequest(reply, body.error);
    const { base, other } = body.data;
    try {
      const baseProfile = profileOr404(db, base);
      assertSameSide(db, baseProfile, profileOr404(db, other));
      // A plan made only of config files (what the player changed) does not need the jars imported.
      if (getPlanItems(db, base, other, 'mod').length > 0 && (loadModSet(db, base).size === 0 || loadModSet(db, other).size === 0)) throw new PlanHttpError(409, 'both profiles must be imported first');
      if (getPlanItems(db, base, other).length === 0) throw new PlanHttpError(409, 'the plan is empty: select mods or files to update first');
      try {
        fs.accessSync(baseProfile.location, fs.constants.R_OK);
      } catch {
        throw new PlanHttpError(409, `the reference location cannot be read: ${baseProfile.location}`);
      }
    } catch (err) {
      return send(reply, err);
    }
    const jobId = jobs.enqueue(JOB_TYPE, { base, other }, { lockKey: `export:${base}:${other}` });
    return reply.code(202).send({ jobId });
  });

  api.get(`${API_PREFIX}/plan/jobs/:jobId`, async (req, reply) => {
    const jobId = String((req.params as { jobId: string }).jobId);
    const row = db.sqlite.prepare('SELECT status, progress, message FROM job WHERE id = ? AND type = ?').get(jobId, JOB_TYPE) as { status: string; progress: number | null; message: string | null } | undefined;
    if (!row) return reply.code(404).send({ error: 'export job not found' });
    const name = row.status === 'done' ? (/^export ([A-Za-z0-9._-]+):/.exec(row.message ?? '')?.[1] ?? null) : null;
    return { id: jobId, status: row.status, progress: row.progress, message: row.message, name };
  });

  api.get(`${API_PREFIX}/plan/exports`, async () =>
    listExports(exportsDir).map((r) => ({ name: r.name, createdAt: r.createdAt, counts: r.counts, zipBytes: r.zipBytes, base: r.base, other: r.other })),
  );

  api.get(`${API_PREFIX}/plan/exports/:name`, async (req, reply) => {
    const name = String((req.params as { name: string }).name);
    const result = readExportResult(exportsDir, name);
    if (!result) return reply.code(404).send({ error: 'export not found' });
    return { result, folder: path.join(exportsDir, name) };
  });

  api.get(`${API_PREFIX}/plan/exports/:name/download`, async (req, reply) => {
    const name = String((req.params as { name: string }).name);
    if (!EXPORT_NAME.test(name) || !readExportResult(exportsDir, name)) return reply.code(404).send({ error: 'export not found' });
    const zipPath = path.join(exportsDir, `${name}.zip`);
    if (path.dirname(zipPath) !== exportsDir || !fs.existsSync(zipPath)) return reply.code(404).send({ error: 'export zip not found' });
    return reply
      .type('application/zip')
      .header('content-disposition', `attachment; filename="${name}.zip"`)
      .header('content-length', fs.statSync(zipPath).size)
      .send(fs.createReadStream(zipPath));
  });

  api.get(`${API_PREFIX}/mods/:modId/debug`, async (req, reply) => {
    const modId = z.string().min(1).max(256).safeParse((req.params as { modId: string }).modId);
    const q = DiffQuerySchema.safeParse(req.query);
    if (!modId.success) return sendBadRequest(reply, modId.error);
    if (!q.success) return sendBadRequest(reply, q.error);
    let base: Profile;
    let other: Profile;
    try {
      base = profileOr404(db, q.data.base);
      other = profileOr404(db, q.data.other);
    } catch (err) {
      return send(reply, err);
    }
    const doc = await modDebug(db, modId.data, base, other, readPackNames(deps.dataDir ?? path.resolve('data')).upstream);
    if (!doc) return reply.code(404).send({ error: `mod ${modId.data} is in neither profile` });
    return doc;
  });
}

/** Everything Studio knows about one mod of a comparison, for troubleshooting a row of the Mods page. */
async function modDebug(db: Db, modId: string, base: Profile, other: Profile, upstream: string) {
  const baseSet = loadModSet(db, base.id);
  const otherSet = loadModSet(db, other.id);
  const ref = baseSet.get(modId) ?? null;
  const cur = otherSet.get(modId) ?? null;
  if (!ref && !cur) return null;

  let status: string;
  if (ref && cur) {
    const order = compareVersions(cur.version, ref.version);
    status = order === 'equal' || cur.version === ref.version ? (cur.sha256 === ref.sha256 ? 'unchanged' : 'rebuilt') : order === 'incomparable' ? 'different' : order;
  } else status = ref ? 'removed' : 'added';

  const decisionRows = db.sqlite.prepare('SELECT mod_id, kind, side, reason, created_at FROM mod_decision WHERE mod_id = ?').all(modId) as DecisionRow[];
  const decision = (kind: DecisionRow['kind']) => {
    const r = decisionRows.find((d) => d.kind === kind);
    return r ? { side: r.side, reason: r.reason, createdAt: r.created_at } : null;
  };
  const atmVersion = base.pack === upstream ? base.version : other.pack === upstream ? other.version : base.version;
  const bl = effectiveBlacklist(db, atmVersion).find((e) => e.modId === modId) ?? null;

  const actionable = actionableMods(diffModSets(baseSet, otherSet, { pins: getPins(db) }));
  const planned = getPlanItems(db, base.id, other.id, 'mod').some((i) => i.key === modId);
  const dup = (profileId: number) => findDuplicateIds(db, profileId).find((d) => d.modId === modId)?.files ?? null;

  let sourceJar = null;
  if (ref) {
    const source = await openSource(base);
    try {
      const read = await source.jar(ref.file);
      const actual = read.ok ? sha256Hex(read.data) : null;
      sourceJar = {
        side: 'base' as const,
        locationKind: base.locationKind,
        path: read.where,
        exists: read.ok,
        size: read.ok ? read.data.length : null,
        sha256Recorded: ref.sha256,
        sha256Actual: actual,
        matches: actual === ref.sha256,
        error: read.ok ? null : read.reason,
      };
    } finally {
      await source.close();
    }
  }

  return {
    modId,
    generatedAt: new Date().toISOString(),
    status,
    base: { profile: profileInfo(base), entry: ref },
    other: { profile: profileInfo(other), entry: cur },
    comparison: ref && cur ? { comparedAs: 'other version (a) relative to the reference version (b)', ...explainCompare(cur.version, ref.version) } : null,
    decisions: { pin: decision('pin'), ignore: decision('ignore'), side: decision('side'), blacklisted: bl ? { origin: bl.origin, stale: bl.stale, atmVersion } : null },
    plan: { planned, actionable: actionable.has(modId), action: actionable.get(modId) ?? null },
    duplicates: { base: dup(base.id), other: dup(other.id) },
    sourceJar,
  };
}

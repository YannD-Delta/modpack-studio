import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { API_PREFIX } from '../../shared/constants.js';
import { compareProfiles, inventoryOrThrow, NotScannedError, pairLoader, sourceOf } from '../configs/compare.js';
import { diffInventories, PLANNABLE, type FileStatus } from '../configs/diff.js';
import { needsScan, readInventoryCache, writeInventoryCache } from '../configs/inventory-cache.js';
import { rootOf, scanInstanceTree, TRACKED_ROOTS } from '../configs/inventory.js';
import { buildHunks, diffLines, splitLines } from '../configs/line-diff.js';
import { decodeText, NORMALIZE_MAX_BYTES } from '../configs/normalize.js';
import { findInInventory, InvalidRelPathError, validateRelPath } from '../configs/profile-files.js';
import { audit } from '../db/audit.js';
import type { Db } from '../db/open.js';
import { PathEscapeError } from '../fs-safe/safe-path.js';
import { getPlanItems, setPlanItems } from '../plan/plan-store.js';
import { getProfile, type Profile } from '../profiles/profile-service.js';
import type { AppDeps } from './app.js';
import { sendBadRequest } from './routes-profiles.js';

/** Text files above this are shown truncated and not line-diffed. */
const MAX_VIEW_BYTES = 1024 * 1024;
/** Line cap per side for the structured diff. */
const MAX_DIFF_LINES = 5000;
const MAX_ISSUES_SHOWN = 200;

class ConfigsHttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly extra: object = {}) {
    super(message);
  }
}

const Id = z.coerce.number().int().positive();
const RelPath = z.string().min(1).max(1024);
const ProfileQuery = z.object({ profile: Id, full: z.enum(['0', '1']).optional() });
const PairQuery = z.object({ base: Id, other: Id });
const FileQuery = z.object({ profile: Id, path: RelPath });
const FileDiffQuery = PairQuery.extend({ path: RelPath });
const ScanBody = z.object({ profile: z.number().int().positive(), force: z.boolean().optional() });
const PlanBody = z.object({ base: z.number().int().positive(), other: z.number().int().positive(), paths: z.array(RelPath).max(20000), selected: z.boolean() });
const JobParams = z.object({ jobId: z.uuid() });

function profileOr404(db: Db, id: number): Profile {
  try {
    return getProfile(db, id);
  } catch {
    throw new ConfigsHttpError(404, `profile ${id} not found`);
  }
}

function relOr400(rel: string): string {
  try {
    return validateRelPath(rel);
  } catch (err) {
    throw new ConfigsHttpError(400, err instanceof Error ? err.message : String(err));
  }
}

const profileInfo = (p: Profile, scannedAt: string | null) => ({ id: p.id, pack: p.pack, version: p.version, side: p.side, state: p.state, immutable: p.immutable, scannedAt });

type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/** Maps the errors of this area to `{error}` replies; anything else goes to Fastify. */
const guarded = (fn: Handler): Handler => async (req, reply) => {
  try {
    return await fn(req, reply);
  } catch (err) {
    if (err instanceof ConfigsHttpError) return reply.code(err.status).send({ error: err.message, ...err.extra });
    if (err instanceof NotScannedError) return reply.code(409).send({ error: err.message, notScanned: err.profileId });
    if (err instanceof InvalidRelPathError || err instanceof PathEscapeError) return reply.code(400).send({ error: err.message });
    throw err;
  }
};

export function registerConfigsRoutes(api: FastifyInstance, deps: AppDeps): void {
  const { db, jobs } = deps;
  const dataDir = deps.dataDir ?? path.resolve('data');

  jobs.register('scan-configs', async (ctx) => {
    const params = z.object({ profileId: z.number(), force: z.boolean().optional() }).parse(ctx.params);
    const profile = getProfile(db, params.profileId);
    const source = sourceOf(profile);
    if (!source) throw new Error(`a ${profile.locationKind} profile cannot be scanned yet`);
    // Another scan may have finished while this one was queued behind the lock.
    if (!needsScan(profile, readInventoryCache(dataDir, profile.id), params.force ?? false)) {
      ctx.progress(100, 'already scanned');
      return;
    }
    const inv = await scanInstanceTree(source, { signal: ctx.signal, onProgress: (pct, msg) => ctx.progress(pct, msg) });
    const unreadable = inv.issues.find((i) => i.path === '.');
    if (inv.files.size === 0 && unreadable) throw new Error(unreadable.reason);
    writeInventoryCache(dataDir, profile.id, profile.location, inv);
    audit(db, 'configs.scan', String(profile.id), { files: inv.files.size, issues: inv.issues.length });
    ctx.progress(100, `scanned ${inv.files.size} files, ${inv.issues.length} issues`);
  });

  api.post(`${API_PREFIX}/configs/scan`, guarded(async (req, reply) => {
    const body = ScanBody.safeParse(req.body);
    if (!body.success) return sendBadRequest(reply, body.error);
    const profile = profileOr404(db, body.data.profile);
    if (!sourceOf(profile)) throw new ConfigsHttpError(409, `a ${profile.locationKind} profile cannot be scanned yet`);
    const cached = readInventoryCache(dataDir, profile.id);
    if (!needsScan(profile, cached, body.data.force ?? false)) return { jobId: null, cached: true, scannedAt: cached!.scannedAt };
    const jobId = jobs.enqueue('scan-configs', { profileId: profile.id, force: body.data.force ?? false }, { lockKey: `configs:${profile.id}` });
    return reply.code(202).send({ jobId });
  }));

  api.get(`${API_PREFIX}/configs/scan/:jobId`, guarded(async (req, reply) => {
    const p = JobParams.safeParse(req.params);
    if (!p.success) return sendBadRequest(reply, p.error);
    const row = db.sqlite.prepare("SELECT status, progress, message FROM job WHERE id = ? AND type = 'scan-configs'").get(p.data.jobId) as
      | { status: string; progress: number | null; message: string | null }
      | undefined;
    if (!row) throw new ConfigsHttpError(404, 'job not found');
    return row;
  }));

  api.get(`${API_PREFIX}/configs/inventory`, guarded(async (req, reply) => {
    const q = ProfileQuery.safeParse(req.query);
    if (!q.success) return sendBadRequest(reply, q.error);
    const profile = profileOr404(db, q.data.profile);
    const inv = inventoryOrThrow(dataDir, profile);
    const perRoot: Record<string, { files: number; bytes: number }> = Object.fromEntries(TRACKED_ROOTS.map((r) => [r, { files: 0, bytes: 0 }]));
    let bytes = 0;
    for (const [p, e] of Object.entries(inv.files)) {
      const r = perRoot[rootOf(p) ?? p.split('/')[0]!] ??= { files: 0, bytes: 0 };
      r.files++;
      r.bytes += e.size;
      bytes += e.size;
    }
    return {
      profile: profileInfo(profile, inv.scannedAt),
      scannedAt: inv.scannedAt,
      total: Object.keys(inv.files).length,
      bytes,
      perRoot,
      issueCount: inv.issues.length,
      issues: inv.issues.slice(0, MAX_ISSUES_SHOWN),
      ...(q.data.full === '1' ? { files: inv.files } : {}),
    };
  }));

  api.get(`${API_PREFIX}/configs/diff`, guarded(async (req, reply) => {
    const q = PairQuery.safeParse(req.query);
    if (!q.success) return sendBadRequest(reply, q.error);
    const base = profileOr404(db, q.data.base);
    const other = profileOr404(db, q.data.other);
    const { diff, baseInv, otherInv } = await compareProfiles(dataDir, base, other);
    return { base: profileInfo(base, baseInv.scannedAt), other: profileInfo(other, otherInv.scannedAt), ...diff };
  }));

  api.get(`${API_PREFIX}/configs/file`, guarded(async (req, reply) => {
    const q = FileQuery.safeParse(req.query);
    if (!q.success) return sendBadRequest(reply, q.error);
    const rel = relOr400(q.data.path);
    const profile = profileOr404(db, q.data.profile);
    const inv = inventoryOrThrow(dataDir, profile);
    const found = findInInventory(inv.files, rel);
    if (!found) throw new ConfigsHttpError(404, `${rel} is not in the scanned files of profile ${profile.id}`);
    const { path: p, entry } = found;
    if (entry.kind === 'binary') return reply.code(415).send({ error: `${p} is a binary or too large file`, path: p, kind: entry.kind, size: entry.size, tooLarge: !!entry.tooLarge });
    const loader = pairLoader({ profile, inv }, { profile, inv });
    try {
      const { buf, stale } = await loader.readRaw('base', p, MAX_VIEW_BYTES);
      return { path: p, kind: entry.kind, size: entry.size, truncated: entry.size > MAX_VIEW_BYTES, stale, content: decodeText(buf) };
    } catch (err) {
      if (err instanceof PathEscapeError) throw err;
      throw new ConfigsHttpError(404, `cannot read ${p}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await loader.close();
    }
  }));

  api.get(`${API_PREFIX}/configs/filediff`, guarded(async (req, reply) => {
    const q = FileDiffQuery.safeParse(req.query);
    if (!q.success) return sendBadRequest(reply, q.error);
    const rel = relOr400(q.data.path);
    const base = profileOr404(db, q.data.base);
    const other = profileOr404(db, q.data.other);
    const baseInv = inventoryOrThrow(dataDir, base);
    const otherInv = inventoryOrThrow(dataDir, other);
    const a = findInInventory(baseInv.files, rel);
    const b = findInInventory(otherInv.files, rel);
    if (!a && !b) throw new ConfigsHttpError(404, `${rel} is in neither profile`);

    const loader = pairLoader({ profile: base, inv: baseInv }, { profile: other, inv: otherInv });
    try {
      const one = await diffInventories(a ? { [a.path]: a.entry } : {}, b ? { [b.path]: b.entry } : {}, { load: (side, p) => loader.load(side, p) });
      const f = one.files[0]!;
      const head = { path: a?.path ?? b!.path, status: f.status as FileStatus, kind: f.kind, baseSize: a?.entry.size ?? null, otherSize: b?.entry.size ?? null };
      const empty = { truncated: false, coarse: false, stale: false, added: 0, removed: 0, lines: [], hunks: [] };
      if (f.kind === 'binary') return { ...head, ...empty, binary: true, tooLarge: f.status === 'tooLarge' || !!a?.entry.tooLarge || !!b?.entry.tooLarge };
      if ((a?.entry.size ?? 0) > NORMALIZE_MAX_BYTES || (b?.entry.size ?? 0) > NORMALIZE_MAX_BYTES) return { ...head, ...empty, binary: false, tooLarge: true };

      const read = async (side: 'base' | 'other', hit: typeof a) => (hit ? await loader.readRaw(side, hit.path, NORMALIZE_MAX_BYTES) : { buf: Buffer.alloc(0), stale: false });
      const [ra, rb] = await Promise.all([read('base', a), read('other', b)]);
      const la = splitLines(decodeText(ra.buf));
      const lb = splitLines(decodeText(rb.buf));
      const truncated = la.length > MAX_DIFF_LINES || lb.length > MAX_DIFF_LINES;
      const { ops, coarse } = diffLines(la.slice(0, MAX_DIFF_LINES), lb.slice(0, MAX_DIFF_LINES));
      return {
        ...head,
        binary: false,
        tooLarge: false,
        truncated,
        coarse,
        stale: ra.stale || rb.stale,
        added: ops.filter((o) => o.type === 'add').length,
        removed: ops.filter((o) => o.type === 'del').length,
        lines: ops,
        hunks: buildHunks(ops, 3),
      };
    } catch (err) {
      if (err instanceof ConfigsHttpError || err instanceof PathEscapeError || err instanceof InvalidRelPathError) throw err;
      throw new ConfigsHttpError(404, `cannot read ${rel}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await loader.close();
    }
  }));

  api.get(`${API_PREFIX}/configs/plan`, guarded(async (req, reply) => {
    const q = PairQuery.safeParse(req.query);
    if (!q.success) return sendBadRequest(reply, q.error);
    profileOr404(db, q.data.base);
    profileOr404(db, q.data.other);
    return { paths: getPlanItems(db, q.data.base, q.data.other, 'file').map((i) => i.key) };
  }));

  api.put(`${API_PREFIX}/configs/plan`, guarded(async (req, reply) => {
    const body = PlanBody.safeParse(req.body);
    if (!body.success) return sendBadRequest(reply, body.error);
    const { base: baseId, other: otherId, paths, selected } = body.data;
    const base = profileOr404(db, baseId);
    const other = profileOr404(db, otherId);
    let keys = paths;
    if (selected) {
      // Only what can actually be taken from the reference is accepted: a real change, or a file the other side lacks.
      const { diff } = await compareProfiles(dataDir, base, other, { maxFiles: Number.MAX_SAFE_INTEGER });
      const byKey = new Map(diff.files.map((f) => [f.path.toLowerCase(), f]));
      const rejected: { path: string; status: FileStatus | 'unknown' }[] = [];
      keys = [];
      for (const p of paths) {
        const f = byKey.get(p.toLowerCase());
        if (f && PLANNABLE.has(f.status)) keys.push(f.path);
        else rejected.push({ path: p, status: f?.status ?? 'unknown' });
      }
      if (rejected.length > 0) {
        throw new ConfigsHttpError(400, `only modified files and files missing from the compared profile can be planned: ${rejected.map((r) => `${r.path} (${r.status})`).join(', ')}`, { rejected });
      }
    }
    setPlanItems(db, baseId, otherId, 'file', keys, selected);
    audit(db, 'configs.plan', `${baseId}->${otherId}`, { selected, count: keys.length });
    return { ok: true, paths: getPlanItems(db, baseId, otherId, 'file').map((i) => i.key) };
  }));
}

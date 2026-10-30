import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { API_PREFIX } from '../../shared/constants.js';
import { analyzeCustomizations, INCLUDE_STATUSES } from '../configs/customizations.js';
import { compareProfiles, inventoryOrThrow, NotScannedError, pairLoader, sourceOf } from '../configs/compare.js';
import { diffInventories, PLANNABLE, type FileStatus } from '../configs/diff.js';
import { needsScan, readInventoryCache, writeInventoryCache } from '../configs/inventory-cache.js';
import { rootOf, scanInstanceTree, trackedRoots } from '../configs/inventory.js';
import { buildHunks, diffLines, splitLines } from '../configs/line-diff.js';
import { decodeText, normalizeMaxBytes } from '../configs/normalize.js';
import { findInInventory, InvalidRelPathError, validateRelPath } from '../configs/profile-files.js';
import { audit } from '../db/audit.js';
import type { Db } from '../db/open.js';
import { PathEscapeError } from '../fs-safe/safe-path.js';
import { getPlanItems, setPlanItems } from '../plan/plan-store.js';
import { getProfile, type Profile } from '../profiles/profile-service.js';
import type { AppDeps } from './app.js';
import { sendBadRequest } from './routes-profiles.js';
import { defineLimit, getNumberLimit } from '../settings/limits.js';

/** Text files above this are shown truncated and not line-diffed. */
defineLimit({ key: 'configs.maxViewKb', kind: 'number', default: 1024, min: 64, max: 65536, unit: 'kilobytes', group: 'configs', label: 'Largest config file shown in the viewer' });
const maxViewBytes = (): number => getNumberLimit('configs.maxViewKb') * 1024;
/** Line cap per side for the structured diff. */
defineLimit({ key: 'configs.maxDiffLines', kind: 'number', default: 5000, min: 100, max: 100000, unit: 'lines', group: 'configs', label: 'Most lines compared in a file diff' });
const maxDiffLines = (): number => getNumberLimit('configs.maxDiffLines');
const MAX_ISSUES_SHOWN = 200;

/** Machine-readable `code` of the errors of this area (the web client reads `error` and `code`). */
const CODE = { notScanned: 'not_scanned', triadState: 'triad_state', triadMismatch: 'triad_mismatch', triadDistinct: 'triad_distinct' } as const;

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
const ScanBody = z.object({ profile: z.number().int().positive(), force: z.boolean().optional(), deep: z.boolean().optional() });
const PlanBody = z.object({ base: z.number().int().positive(), other: z.number().int().positive(), paths: z.array(RelPath).max(20000), selected: z.boolean() });
const JobParams = z.object({ jobId: z.uuid() });
const TriadQuery = z.object({ clean: Id, launched: Id, played: Id, untouched: z.enum(['0', '1']).optional() });
const TriadPlanBody = z.object({
  clean: z.number().int().positive(),
  launched: z.number().int().positive(),
  played: z.number().int().positive(),
  paths: z.array(RelPath).max(20000),
  selected: z.boolean(),
});

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

/**
 * The three copies of a three-copy analysis must really be a clean, a launched and a played copy of the same pack, version and side:
 * otherwise the answer would be confident but meaningless.
 */
function assertTriad(p: { clean: Profile; launched: Profile; played: Profile }): void {
  if (new Set([p.clean.id, p.launched.id, p.played.id]).size !== 3) throw new ConfigsHttpError(400, 'pick three different profiles', { code: CODE.triadDistinct });
  const roles = [['clean', p.clean, 'clean'], ['launched', p.launched, 'launched'], ['played', p.played, 'run']] as const;
  for (const [role, profile, state] of roles) {
    if (profile.state !== state) throw new ConfigsHttpError(400, `the ${role} copy must be a profile in state ${state}, not ${profile.state}`, { code: CODE.triadState, role, profileId: profile.id });
  }
  const same = (f: (x: Profile) => string) => new Set([p.clean, p.launched, p.played].map(f)).size === 1;
  if (!same((x) => x.pack) || !same((x) => x.version) || !same((x) => x.side)) {
    throw new ConfigsHttpError(400, 'the clean, launched and played copies must be the same pack, version and side', { code: CODE.triadMismatch });
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
    if (err instanceof NotScannedError) return reply.code(409).send({ error: err.message, code: CODE.notScanned, notScanned: err.profileId });
    if (err instanceof InvalidRelPathError || err instanceof PathEscapeError) return reply.code(400).send({ error: err.message });
    throw err;
  }
};

export function registerConfigsRoutes(api: FastifyInstance, deps: AppDeps): void {
  const { db, jobs } = deps;
  const dataDir = deps.dataDir ?? path.resolve('data');

  jobs.register('scan-configs', async (ctx) => {
    const params = z.object({ profileId: z.number(), force: z.boolean().optional(), deep: z.boolean().optional() }).parse(ctx.params);
    const profile = getProfile(db, params.profileId);
    const source = sourceOf(profile);
    if (!source) throw new Error(`a ${profile.locationKind} profile cannot be scanned yet`);
    // Another scan may have finished while this one was queued behind the lock.
    if (!needsScan(profile, readInventoryCache(dataDir, profile.id), params.force ?? false, params.deep ?? false)) {
      ctx.progress(100, 'already scanned');
      return;
    }
    const inv = await scanInstanceTree(source, { deepBinary: params.deep ?? false, signal: ctx.signal, onProgress: (pct, msg) => ctx.progress(pct, msg) });
    const unreadable = inv.issues.find((i) => i.path === '.');
    if (inv.files.size === 0 && unreadable) throw new Error(unreadable.reason);
    writeInventoryCache(dataDir, profile.id, profile.location, inv, new Date(), params.deep ?? false);
    audit(db, 'configs.scan', String(profile.id), { files: inv.files.size, issues: inv.issues.length });
    ctx.progress(100, `scanned ${inv.files.size} files, ${inv.issues.length} issues`);
  });

  api.post(`${API_PREFIX}/configs/scan`, guarded(async (req, reply) => {
    const body = ScanBody.safeParse(req.body);
    if (!body.success) return sendBadRequest(reply, body.error);
    const profile = profileOr404(db, body.data.profile);
    if (!sourceOf(profile)) throw new ConfigsHttpError(409, `a ${profile.locationKind} profile cannot be scanned yet`);
    const cached = readInventoryCache(dataDir, profile.id);
    if (!needsScan(profile, cached, body.data.force ?? false, body.data.deep ?? false)) return { jobId: null, cached: true, scannedAt: cached!.scannedAt };
    const jobId = jobs.enqueue('scan-configs', { profileId: profile.id, force: body.data.force ?? false, deep: body.data.deep ?? false }, { lockKey: `configs:${profile.id}` });
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
    const perRoot: Record<string, { files: number; bytes: number }> = Object.fromEntries(trackedRoots().map((r) => [r, { files: 0, bytes: 0 }]));
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
      /** Known binaries (textures...) that were only compared by size (quick scan): their content was never read. */
      sizeOnlyFiles: Object.values(inv.files).filter((e) => e.sizeOnly).length,
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
      const { buf, stale } = await loader.readRaw('base', p, maxViewBytes());
      return { path: p, kind: entry.kind, size: entry.size, truncated: entry.size > maxViewBytes(), stale, content: decodeText(buf) };
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
      if ((a?.entry.size ?? 0) > normalizeMaxBytes() || (b?.entry.size ?? 0) > normalizeMaxBytes()) return { ...head, ...empty, binary: false, tooLarge: true };

      const read = async (side: 'base' | 'other', hit: typeof a) => (hit ? await loader.readRaw(side, hit.path, normalizeMaxBytes()) : { buf: Buffer.alloc(0), stale: false });
      const [ra, rb] = await Promise.all([read('base', a), read('other', b)]);
      const la = splitLines(decodeText(ra.buf));
      const lb = splitLines(decodeText(rb.buf));
      const truncated = la.length > maxDiffLines() || lb.length > maxDiffLines();
      const { ops, coarse } = diffLines(la.slice(0, maxDiffLines()), lb.slice(0, maxDiffLines()));
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

  /** What the player changed: the played instance against the launched one, told apart from files the clean pack ships. */
  api.get(`${API_PREFIX}/configs/customizations`, guarded(async (req, reply) => {
    const q = TriadQuery.safeParse(req.query);
    if (!q.success) return sendBadRequest(reply, q.error);
    if (new Set([q.data.clean, q.data.launched, q.data.played]).size !== 3) throw new ConfigsHttpError(400, 'pick three different profiles', { code: CODE.triadDistinct });
    const profiles = { clean: profileOr404(db, q.data.clean), launched: profileOr404(db, q.data.launched), played: profileOr404(db, q.data.played) };
    assertTriad(profiles);
    const result = await analyzeCustomizations(dataDir, profiles, { includeUntouched: q.data.untouched === '1' });
    // The analysis uses the last scan of each copy (a played copy is not rescanned by the analysis): say when that was.
    const at = (p: Profile) => readInventoryCache(dataDir, p.id)?.scannedAt ?? null;
    return { ...result, scannedAt: { clean: at(profiles.clean), launched: at(profiles.launched), played: at(profiles.played) } };
  }));

  /** Files to keep in the pack are stored as a plan from the played instance (the source) against the launched one. */
  api.put(`${API_PREFIX}/configs/customizations/plan`, guarded(async (req, reply) => {
    const body = TriadPlanBody.safeParse(req.body);
    if (!body.success) return sendBadRequest(reply, body.error);
    const { clean, launched, played, paths, selected } = body.data;
    if (new Set([clean, launched, played]).size !== 3) throw new ConfigsHttpError(400, 'pick three different profiles', { code: CODE.triadDistinct });
    const profiles = { clean: profileOr404(db, clean), launched: profileOr404(db, launched), played: profileOr404(db, played) };
    assertTriad(profiles);
    let keys = paths;
    if (selected) {
      const found = await analyzeCustomizations(dataDir, profiles);
      const byKey = new Map(found.files.map((f) => [f.path.toLowerCase(), f]));
      const rejected: { path: string; status: string }[] = [];
      keys = [];
      for (const p of paths) {
        const f = byKey.get(p.toLowerCase());
        if (f && INCLUDE_STATUSES.has(f.status)) keys.push(f.path);
        else rejected.push({ path: p, status: f?.status ?? 'untouched' });
      }
      if (rejected.length > 0) throw new ConfigsHttpError(400, `only changed or added files can go into the pack: ${rejected.map((r) => `${r.path} (${r.status})`).join(', ')}`, { rejected });
    }
    setPlanItems(db, played, launched, 'file', keys, selected);
    audit(db, 'configs.customizations.plan', `${played}->${launched}`, { selected, count: keys.length });
    return { ok: true, paths: getPlanItems(db, played, launched, 'file').map((i) => i.key) };
  }));
}

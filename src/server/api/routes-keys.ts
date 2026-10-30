import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import { z } from 'zod';
import { API_PREFIX } from '../../shared/constants.js';
import { inventoryOrThrow, NotScannedError, pairLoader } from '../configs/compare.js';
import { formatOf, keyDiff, parseKeys, type KeyDiffResult, type KeyFormat, type KeyMap } from '../configs/keys.js';
import { decodeText, normalizeMaxBytes } from '../configs/normalize.js';
import { findInInventory, InvalidRelPathError, validateRelPath } from '../configs/profile-files.js';
import { PathEscapeError } from '../fs-safe/safe-path.js';
import { getProfile } from '../profiles/profile-service.js';
import type { AppDeps } from './app.js';
import { sendBadRequest } from './routes-profiles.js';

const Query = z.object({ base: z.coerce.number().int().positive(), other: z.coerce.number().int().positive(), path: z.string().min(1).max(1024) });

export type KeyDiffReply = {
  path: string;
  format: KeyFormat | null;
  /** False: the web falls back to the line diff, `reason` says why. */
  parsable: boolean;
  reason?: 'unsupported' | 'tooLarge' | 'unparsable';
  detail?: string;
  baseSize: number | null;
  otherSize: number | null;
  stale: boolean;
  diff: KeyDiffResult;
  counts: { added: number; removed: number; changed: number; moved: number };
};

const EMPTY: KeyDiffResult = { added: [], removed: [], changed: [], moved: [] };
const countsOf = (d: KeyDiffResult) => ({ added: d.added.length, removed: d.removed.length, changed: d.changed.length, moved: d.moved.length });

export function registerKeysRoutes(api: FastifyInstance, deps: AppDeps): void {
  const { db } = deps;
  const dataDir = deps.dataDir ?? path.resolve('data');

  api.get(`${API_PREFIX}/configs/keydiff`, async (req, reply) => {
    const q = Query.safeParse(req.query);
    if (!q.success) return sendBadRequest(reply, q.error);
    let rel: string;
    try {
      rel = validateRelPath(q.data.path);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
    let base, other;
    try {
      base = getProfile(db, q.data.base);
    } catch {
      return reply.code(404).send({ error: `profile ${q.data.base} not found` });
    }
    try {
      other = getProfile(db, q.data.other);
    } catch {
      return reply.code(404).send({ error: `profile ${q.data.other} not found` });
    }
    try {
      const baseInv = inventoryOrThrow(dataDir, base);
      const otherInv = inventoryOrThrow(dataDir, other);
      const a = findInInventory(baseInv.files, rel);
      const b = findInInventory(otherInv.files, rel);
      if (!a && !b) return reply.code(404).send({ error: `${rel} is in neither profile` });
      const filePath = a?.path ?? b!.path;
      const head = { path: filePath, baseSize: a?.entry.size ?? null, otherSize: b?.entry.size ?? null, stale: false };
      const fallback = (reason: NonNullable<KeyDiffReply['reason']>, format: KeyFormat | null, detail?: string): KeyDiffReply => ({
        ...head,
        format,
        parsable: false,
        reason,
        ...(detail ? { detail } : {}),
        diff: EMPTY,
        counts: countsOf(EMPTY),
      });

      const format = formatOf(filePath);
      if (!format) return fallback('unsupported', null);
      if ((a?.entry.size ?? 0) > normalizeMaxBytes() || (b?.entry.size ?? 0) > normalizeMaxBytes() || a?.entry.tooLarge || b?.entry.tooLarge) return fallback('tooLarge', format);

      const loader = pairLoader({ profile: base, inv: baseInv }, { profile: other, inv: otherInv });
      try {
        const read = async (side: 'base' | 'other', hit: typeof a) => (hit ? await loader.readRaw(side, hit.path, normalizeMaxBytes()) : { buf: Buffer.alloc(0), stale: false });
        const [ra, rb] = await Promise.all([read('base', a), read('other', b)]);
        const keysOf = (hit: typeof a, buf: Buffer): KeyMap | string => {
          if (!hit) return new Map();
          const p = parseKeys(decodeText(buf), format);
          return p.ok ? p.keys : p.reason;
        };
        const ka = keysOf(a, ra.buf);
        const kb = keysOf(b, rb.buf);
        const stale = ra.stale || rb.stale;
        if (typeof ka === 'string' || typeof kb === 'string') return { ...fallback('unparsable', format, (typeof ka === 'string' ? ka : kb) as string), stale };
        const diff = keyDiff(ka, kb);
        const reply2: KeyDiffReply = { ...head, stale, format, parsable: true, diff, counts: countsOf(diff) };
        return reply2;
      } finally {
        await loader.close();
      }
    } catch (err) {
      if (err instanceof NotScannedError) return reply.code(409).send({ error: err.message, code: 'not_scanned', notScanned: err.profileId });
      if (err instanceof InvalidRelPathError || err instanceof PathEscapeError) return reply.code(400).send({ error: err.message });
      return reply.code(404).send({ error: `cannot read ${rel}: ${err instanceof Error ? err.message : String(err)}` });
    }
  });
}

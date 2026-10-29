import { extOf, rootOf, type FileKind, type InventoryEntry } from './inventory.js';
import { NORMALIZE_MAX_BYTES, normalizeForCompare } from './normalize.js';

export type FileStatus = 'onlyInBase' | 'modified' | 'binaryDiffers' | 'tooLarge' | 'onlyInOther' | 'cosmetic' | 'identical';

/** Most serious first: drives the sort of the file list and the order of the UI chips. */
export const STATUS_ORDER: FileStatus[] = ['onlyInBase', 'modified', 'binaryDiffers', 'tooLarge', 'onlyInOther', 'cosmetic', 'identical'];

/** Statuses for which "take the reference's version" means something (and that the update plan accepts). */
export const PLANNABLE: ReadonlySet<FileStatus> = new Set<FileStatus>(['modified', 'onlyInBase']);

export type InventoryFiles = Record<string, InventoryEntry>;
export type DiffFile = { path: string; root: string; ext: string; kind: FileKind; status: FileStatus; baseSize: number | null; otherSize: number | null };
export type ConfigDiff = {
  summary: { perStatus: Record<FileStatus, number>; perRoot: Record<string, Record<FileStatus, number>> };
  files: DiffFile[];
  total: number;
  truncated: boolean;
};
export type ContentLoader = (side: 'base' | 'other', path: string) => Promise<Buffer>;
export type DiffOptions = { load?: ContentLoader; concurrency?: number; maxFiles?: number };

export const MAX_DIFF_FILES = 20000;

// Normalised equality only depends on the two contents (and the format): remember it across requests.
const equalityCache = new Map<string, boolean>();
const EQUALITY_CACHE_MAX = 100000;

const emptyCounts = (): Record<FileStatus, number> => Object.fromEntries(STATUS_ORDER.map((s) => [s, 0])) as Record<FileStatus, number>;

async function formOnly(path: string, otherPath: string, a: InventoryEntry, b: InventoryEntry, load: ContentLoader): Promise<boolean> {
  const ext = extOf(path);
  const key = `${ext}|${a.sha256}|${b.sha256}`;
  const hit = equalityCache.get(key);
  if (hit !== undefined) return hit;
  let equal = false;
  try {
    const [bufA, bufB] = await Promise.all([load('base', path), load('other', otherPath)]);
    equal = normalizeForCompare(path, bufA) === normalizeForCompare(path, bufB);
  } catch {
    return false; // unreadable now: report it as modified, and do not cache a transient failure
  }
  if (equalityCache.size >= EQUALITY_CACHE_MAX) equalityCache.clear();
  equalityCache.set(key, equal);
  return equal;
}

/**
 * Compares two inventories path by path (case-insensitive, like Windows). Contents are read lazily, only for text files
 * whose hashes differ and that are small enough, to tell a real change from a formatting-only one.
 */
export async function diffInventories(base: InventoryFiles, other: InventoryFiles, opts: DiffOptions = {}): Promise<ConfigDiff> {
  const otherByKey = new Map(Object.keys(other).map((p) => [p.toLowerCase(), p]));
  const seen = new Set<string>();
  const files: DiffFile[] = [];
  const pending: { file: DiffFile; otherPath: string; a: InventoryEntry; b: InventoryEntry }[] = [];

  const mk = (path: string, entry: InventoryEntry, status: FileStatus, baseSize: number | null, otherSize: number | null): DiffFile => ({
    path, root: rootOf(path) ?? path.split('/')[0]!, ext: extOf(path), kind: entry.kind, status, baseSize, otherSize,
  });

  for (const [path, a] of Object.entries(base)) {
    const key = path.toLowerCase();
    seen.add(key);
    const otherPath = otherByKey.get(key);
    const b = otherPath === undefined ? undefined : other[otherPath];
    if (!b || otherPath === undefined) {
      files.push(mk(path, a, 'onlyInBase', a.size, null));
      continue;
    }
    const kind: FileKind = a.kind === 'binary' || b.kind === 'binary' ? 'binary' : 'text';
    if (a.sha256 === b.sha256) {
      files.push({ ...mk(path, a, 'identical', a.size, b.size), kind });
    } else if (a.tooLarge || b.tooLarge) {
      files.push({ ...mk(path, a, 'tooLarge', a.size, b.size), kind: 'binary' });
    } else if (kind === 'binary') {
      files.push({ ...mk(path, a, 'binaryDiffers', a.size, b.size), kind });
    } else {
      const file = { ...mk(path, a, 'modified', a.size, b.size), kind };
      files.push(file);
      if (opts.load && a.size <= NORMALIZE_MAX_BYTES && b.size <= NORMALIZE_MAX_BYTES) pending.push({ file, otherPath, a, b });
    }
  }
  for (const [path, b] of Object.entries(other)) {
    if (!seen.has(path.toLowerCase())) files.push(mk(path, b, 'onlyInOther', null, b.size));
  }

  if (opts.load) {
    const load = opts.load;
    let next = 0;
    const worker = async () => {
      while (next < pending.length) {
        const p = pending[next++]!;
        if (await formOnly(p.file.path, p.otherPath, p.a, p.b, load)) p.file.status = 'cosmetic';
      }
    };
    await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 8, pending.length) }, worker));
  }

  const perStatus = emptyCounts();
  const perRoot: Record<string, Record<FileStatus, number>> = {};
  for (const f of files) {
    perStatus[f.status]++;
    (perRoot[f.root] ??= emptyCounts())[f.status]++;
  }
  files.sort((x, y) => STATUS_ORDER.indexOf(x.status) - STATUS_ORDER.indexOf(y.status) || (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  const max = opts.maxFiles ?? MAX_DIFF_FILES;
  return { summary: { perStatus, perRoot }, files: files.slice(0, max), total: files.length, truncated: files.length > max };
}

/** Clears the in-memory equality cache (tests). */
export function clearEqualityCache(): void {
  equalityCache.clear();
}

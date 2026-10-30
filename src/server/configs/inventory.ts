import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { READ_ONLY_ZIP_LIMITS, openZip } from '../zip/zip-reader.js';
import { defineLimit, getListLimit, getNumberLimit } from '../settings/limits.js';
import { isIgnoredByUser } from './ignore.js';

/** Folders of an instance or server pack whose files are compared. Everything else (mods, saves, logs, options.txt) is ignored. */
export const TRACKED_ROOTS = ['config', 'defaultconfigs', 'kubejs', 'scripts', 'datapacks', 'global_packs'] as const;
export type TrackedRoot = string;
defineLimit({ key: 'configs.trackedRoots', kind: 'list', default: TRACKED_ROOTS, maxItems: 30, group: 'configs', label: 'Tracked config folders (next scan)' });
export const trackedRoots = (): string[] => getListLimit('configs.trackedRoots');

/** Above this size a file is only hashed (streamed), never read as text. */
export const MAX_TEXT_BYTES = 5 * 1024 * 1024;
defineLimit({ key: 'configs.maxTextMb', kind: 'number', default: MAX_TEXT_BYTES / (1024 * 1024), min: 1, max: 256, unit: 'megabytes', group: 'configs', label: 'Largest config file read as text' });

export type FileKind = 'text' | 'binary';
/** `sizeOnly`: a known binary file (texture, nbt...) whose content was not read; its `sha256` is `size:<bytes>`, so equal sizes count as equal. */
export type InventoryEntry = { size: number; sha256: string; kind: FileKind; tooLarge?: true; sizeOnly?: true };
export type ScanIssue = { path: string; reason: string };
export type Inventory = { files: Map<string, InventoryEntry>; issues: ScanIssue[] };
export type ScanSource = { kind: 'folder' | 'zip'; path: string };
export type ScanOptions = {
  maxTextBytes?: number;
  /** Files hashed at once (also the number of folders listed at once). Network drives like many parallel requests. */
  concurrency?: number;
  /** Also read and hash known binary files (textures...). Off by default: over a cloud drive that means downloading hundreds of MB. */
  deepBinary?: boolean;
  signal?: AbortSignal;
  onProgress?: (pct: number, msg?: string) => void;
  /** Test seam: runs just before a file is hashed. */
  hooks?: { beforeHash?: (rel: string) => void };
};

// NeoForge keeps `.bak` copies of every config it rewrites; temp and log files are noise as well.
const EXCLUDED_FILE = /\.(bak|tmp|log)$/i;
const EXCLUDED_NAMES = new Set(['thumbs.db', '.ds_store', 'desktop.ini']);
const EXCLUDED_DIRS = new Set(['logs', '.cache', 'cache']);
const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'ogg', 'wav', 'mp3', 'nbt', 'dat', 'dat_old', 'mca',
  'zip', 'jar', 'gz', 'class', 'ttf', 'otf', 'bin', 'db', 'sqlite', 'exe', 'dll',
]);
const SNIFF_BYTES = 8192;

let trackedMemo: { key: string; set: Set<string> } | null = null;
function trackedSet(): Set<string> {
  const list = trackedRoots();
  const key = list.join('\n');
  if (trackedMemo?.key !== key) trackedMemo = { key, set: new Set(list) };
  return trackedMemo.set;
}

/** An entry name that is a directory (trailing slash or backslash), which is never a file. */
export const isDirectoryEntry = (name: string): boolean => name.endsWith('/') || name.endsWith('\\');

/** Reason of the `.` issue raised when none of the tracked folders exists: a mistyped location must fail, not scan as an empty pack. */
const noRootReason = (where: string): string => `none of ${trackedRoots().join(', ')} found in ${where}`;

/** Canonical (lowercase) tracked root of a relative path, or null. */
export function rootOf(rel: string): TrackedRoot | null {
  const first = rel.split('/')[0]!.toLowerCase();
  return trackedSet().has(first) ? (first as TrackedRoot) : null;
}

export function extOf(rel: string): string {
  const name = rel.slice(rel.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function isExcludedFileName(name: string): boolean {
  return EXCLUDED_FILE.test(name) || EXCLUDED_NAMES.has(name.toLowerCase());
}

/** True for paths (`root/dir/.../file`) that a scan must skip: backups, temp files, OS junk, any logs/ or cache/ folder below the root. */
export function isExcludedPath(rel: string): boolean {
  const segs = rel.split('/');
  if (segs.slice(1, -1).some((s) => EXCLUDED_DIRS.has(s.toLowerCase()))) return true;
  return isExcludedFileName(segs.at(-1)!);
}

function classify(rel: string, size: number, head: Buffer, maxText: number): Pick<InventoryEntry, 'kind' | 'tooLarge'> {
  if (size > maxText) return { kind: 'binary', tooLarge: true };
  if (BINARY_EXT.has(extOf(rel))) return { kind: 'binary' };
  return { kind: head.includes(0) ? 'binary' : 'text' };
}

/** `where`: a missing path is a missing location when it is the folder or zip itself, and a vanished file otherwise. */
function describe(err: unknown, where: 'file' | 'location' = 'file'): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT') return where === 'location' ? 'location not found' : 'file disappeared during the scan';
  if (code === 'ENAMETOOLONG') return 'path too long';
  if (code === 'EACCES' || code === 'EPERM') return 'access denied';
  if (code === 'EBUSY') return 'file locked by another program';
  return err instanceof Error ? err.message : String(err);
}

async function hashFile(abs: string): Promise<{ sha256: string; size: number; head: Buffer }> {
  const hash = crypto.createHash('sha256');
  let size = 0;
  const heads: Buffer[] = [];
  let headLen = 0;
  for await (const chunk of fs.createReadStream(abs) as AsyncIterable<Buffer>) {
    hash.update(chunk);
    size += chunk.length;
    if (headLen < SNIFF_BYTES) {
      heads.push(chunk.subarray(0, SNIFF_BYTES - headLen));
      headLen += Math.min(chunk.length, SNIFF_BYTES - headLen);
    }
  }
  return { sha256: hash.digest('hex'), size, head: Buffer.concat(heads) };
}

/** Lists the tracked files of a folder without following symlinks or junctions (no loops, no escape). */
async function listFolder(
  base: string,
  issues: ScanIssue[],
  opts: { concurrency: number; signal?: AbortSignal; onFound?: (count: number) => void; onRoot?: () => void },
): Promise<{ rel: string; abs: string }[]> {
  const out: { rel: string; abs: string }[] = [];
  let top: fs.Dirent[];
  try {
    top = await fsp.readdir(base, { withFileTypes: true });
  } catch (err) {
    issues.push({ path: '.', reason: `cannot read the location: ${describe(err, 'location')}` });
    return out;
  }

  let level: { abs: string; rel: string }[] = [];
  for (const e of top) {
    const root = e.name.toLowerCase();
    if (!trackedSet().has(root)) continue;
    opts.onRoot?.();
    if (e.isSymbolicLink()) issues.push({ path: root, reason: 'symbolic link or junction, not followed' });
    else if (e.isDirectory()) level.push({ abs: path.join(base, e.name), rel: root });
  }

  // Level by level, several folders at once: the first listing of a cloud-synced folder can take seconds, so overlap them.
  while (level.length > 0) {
    const next: { abs: string; rel: string }[] = [];
    await runLimited(level, opts.concurrency, async ({ abs: absDir, rel: relDir }) => {
      if (opts.signal?.aborted) throw new Error('aborted');
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(absDir, { withFileTypes: true });
      } catch (err) {
        issues.push({ path: relDir, reason: describe(err) });
        return;
      }
      for (const e of entries) {
        const rel = `${relDir}/${e.name}`;
        if (e.isSymbolicLink()) {
          issues.push({ path: rel, reason: 'symbolic link or junction, not followed' });
        } else if (e.isDirectory()) {
          if (!EXCLUDED_DIRS.has(e.name.toLowerCase()) && !isIgnoredByUser(rel)) next.push({ abs: path.join(absDir, e.name), rel });
        } else if (e.isFile() && !isExcludedFileName(e.name) && !isIgnoredByUser(rel)) {
          out.push({ rel, abs: path.join(absDir, e.name) });
        }
      }
      opts.onFound?.(out.length);
    });
    level = next;
  }
  return out;
}

/** The wrapper folder of a zip (`Server-Files-8.3/`) when every entry sits under one folder that is not itself a tracked root. */
export function detectZipPrefix(names: string[]): string {
  if (names.length === 0) return '';
  const first = names[0]!.split('/')[0]!;
  if (trackedSet().has(first.toLowerCase())) return '';
  return names.every((n) => n.includes('/') && n.split('/')[0] === first) ? `${first}/` : '';
}

function progressReporter(total: number, onProgress?: ScanOptions['onProgress']) {
  let last = -1;
  let done = 0;
  return (msg?: string) => {
    done++;
    const pct = total === 0 ? 100 : Math.floor((done / total) * 100);
    if (pct !== last) {
      last = pct;
      onProgress?.(pct, msg);
    }
  };
}

async function runLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * Inventory (size, sha256, text/binary) of the tracked roots of a CurseForge instance folder or a server-pack zip.
 * Never throws for one bad file: unreadable entries go to `issues` and the scan continues.
 */
export async function scanInstanceTree(source: ScanSource, opts: ScanOptions = {}): Promise<Inventory> {
  const maxText = opts.maxTextBytes ?? getNumberLimit('configs.maxTextMb') * 1024 * 1024;
  const files = new Map<string, InventoryEntry>();
  const issues: ScanIssue[] = [];
  const checkAbort = () => {
    if (opts.signal?.aborted) throw new Error('aborted');
  };

  if (source.kind === 'folder') {
    const concurrency = opts.concurrency ?? 16;
    opts.onProgress?.(0, 'listing files: 0 found');
    let lastReported = 0;
    let sawRoot = false;
    const list = await listFolder(source.path, issues, {
      concurrency,
      signal: opts.signal,
      onRoot: () => {
        sawRoot = true;
      },
      onFound: (n) => {
        if (n - lastReported >= 50) {
          lastReported = n;
          opts.onProgress?.(0, `listing files: ${n} found`);
        }
      },
    });
    if (!sawRoot && issues.length === 0) issues.push({ path: '.', reason: noRootReason('the location') });
    opts.onProgress?.(0, `listing files: ${list.length} found`);
    const tick = progressReporter(list.length, opts.onProgress);
    // Many files at once: the instances sit on a slow cloud-synced drive, where latency (not CPU) is the cost.
    await runLimited(list, concurrency, async ({ rel, abs }) => {
      checkAbort();
      try {
        if (!opts.deepBinary && BINARY_EXT.has(extOf(rel))) {
          // Textures and the like are the bulk of kubejs/ (hundreds of MB): compare them by size, do not download them.
          const { size } = await fsp.stat(abs);
          files.set(rel, { size, sha256: `size:${size}`, kind: 'binary', ...(size > maxText ? { tooLarge: true as const } : {}), sizeOnly: true });
        } else {
          opts.hooks?.beforeHash?.(rel);
          const { sha256, size, head } = await hashFile(abs);
          files.set(rel, { size, sha256, ...classify(rel, size, head, maxText) });
        }
      } catch (err) {
        issues.push({ path: rel, reason: describe(err) });
      }
      tick(rel);
    });
    if (list.length === 0) opts.onProgress?.(100);
  } else {
    let zip;
    try {
      // Read-only, never extracted: case collisions are harmless, and big server packs exceed the default entry count.
      zip = await openZip(source.path, { ...READ_ONLY_ZIP_LIMITS });
    } catch (err) {
      issues.push({ path: '.', reason: `cannot open the zip: ${describe(err, 'location')}` });
      opts.onProgress?.(100);
      return { files, issues };
    }
    try {
      const entries = zip.entries();
      const prefix = detectZipPrefix(entries.map((e) => e.name.replace(/\\/g, '/')));
      const wanted: { rel: string; name: string }[] = [];
      let sawRoot = false;
      for (const e of entries) {
        const rel0 = e.name.replace(/\\/g, '/').slice(prefix.length);
        const root = rootOf(rel0);
        if (!root) continue;
        sawRoot = true;
        if (isDirectoryEntry(rel0)) continue; // the reader only drops forward-slash directory entries: this is not a zero-byte file
        const rel = `${root}${rel0.slice(root.length)}`;
        if (rel.split('/').length < 2 || isExcludedPath(rel) || isIgnoredByUser(rel)) continue;
        wanted.push({ rel, name: e.name });
      }
      if (!sawRoot) issues.push({ path: '.', reason: noRootReason('the zip (expected at its root or inside a single top-level folder)') });
      const tick = progressReporter(wanted.length, opts.onProgress);
      for (const { rel, name } of wanted) {
        checkAbort();
        try {
          opts.hooks?.beforeHash?.(rel);
          const buf = await zip.read(name);
          const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
          files.set(rel, { size: buf.length, sha256, ...classify(rel, buf.length, buf.subarray(0, SNIFF_BYTES), maxText) });
        } catch (err) {
          issues.push({ path: rel, reason: describe(err) });
        }
        tick(rel);
      }
      if (wanted.length === 0) opts.onProgress?.(100);
    } finally {
      await zip.close();
    }
  }
  issues.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)); // the parallel listing finds them in any order
  return { files: new Map([...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))), issues };
}

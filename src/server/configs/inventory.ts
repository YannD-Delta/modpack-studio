import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { openZip } from '../zip/zip-reader.js';

/** Folders of an instance or server pack whose files are compared. Everything else (mods, saves, logs, options.txt) is ignored. */
export const TRACKED_ROOTS = ['config', 'defaultconfigs', 'kubejs', 'scripts', 'datapacks', 'global_packs'] as const;
export type TrackedRoot = (typeof TRACKED_ROOTS)[number];

/** Above this size a file is only hashed (streamed), never read as text. */
export const MAX_TEXT_BYTES = 5 * 1024 * 1024;

export type FileKind = 'text' | 'binary';
export type InventoryEntry = { size: number; sha256: string; kind: FileKind; tooLarge?: true };
export type ScanIssue = { path: string; reason: string };
export type Inventory = { files: Map<string, InventoryEntry>; issues: ScanIssue[] };
export type ScanSource = { kind: 'folder' | 'zip'; path: string };
export type ScanOptions = {
  maxTextBytes?: number;
  concurrency?: number;
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

const TRACKED = new Set<string>(TRACKED_ROOTS);

/** Canonical (lowercase) tracked root of a relative path, or null. */
export function rootOf(rel: string): TrackedRoot | null {
  const first = rel.split('/')[0]!.toLowerCase();
  return TRACKED.has(first) ? (first as TrackedRoot) : null;
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

function describe(err: unknown): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT') return 'file disappeared during the scan';
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
async function listFolder(base: string, issues: ScanIssue[], signal?: AbortSignal): Promise<{ rel: string; abs: string }[]> {
  const out: { rel: string; abs: string }[] = [];
  let top: fs.Dirent[];
  try {
    top = await fsp.readdir(base, { withFileTypes: true });
  } catch (err) {
    issues.push({ path: '.', reason: `cannot read the location: ${describe(err)}` });
    return out;
  }

  const walk = async (absDir: string, relDir: string): Promise<void> => {
    if (signal?.aborted) throw new Error('aborted');
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(absDir, { withFileTypes: true });
    } catch (err) {
      issues.push({ path: relDir, reason: describe(err) });
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const rel = `${relDir}/${e.name}`;
      if (e.isSymbolicLink()) {
        issues.push({ path: rel, reason: 'symbolic link or junction, not followed' });
      } else if (e.isDirectory()) {
        if (!EXCLUDED_DIRS.has(e.name.toLowerCase())) await walk(path.join(absDir, e.name), rel);
      } else if (e.isFile() && !isExcludedFileName(e.name)) {
        out.push({ rel, abs: path.join(absDir, e.name) });
      }
    }
  };

  for (const e of top) {
    const root = e.name.toLowerCase();
    if (!TRACKED.has(root)) continue;
    if (e.isSymbolicLink()) {
      issues.push({ path: root, reason: 'symbolic link or junction, not followed' });
      continue;
    }
    if (e.isDirectory()) await walk(path.join(base, e.name), root);
  }
  return out;
}

/** The wrapper folder of a zip (`Server-Files-8.3/`) when every entry sits under one folder that is not itself a tracked root. */
export function detectZipPrefix(names: string[]): string {
  if (names.length === 0) return '';
  const first = names[0]!.split('/')[0]!;
  if (TRACKED.has(first.toLowerCase())) return '';
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
  const maxText = opts.maxTextBytes ?? MAX_TEXT_BYTES;
  const files = new Map<string, InventoryEntry>();
  const issues: ScanIssue[] = [];
  const checkAbort = () => {
    if (opts.signal?.aborted) throw new Error('aborted');
  };

  if (source.kind === 'folder') {
    opts.onProgress?.(0, 'listing files');
    const list = await listFolder(source.path, issues, opts.signal);
    const tick = progressReporter(list.length, opts.onProgress);
    // A few files at a time: the instances sit on a slow cloud-synced drive, so overlap the reads a little.
    await runLimited(list, opts.concurrency ?? 4, async ({ rel, abs }) => {
      checkAbort();
      try {
        opts.hooks?.beforeHash?.(rel);
        const { sha256, size, head } = await hashFile(abs);
        files.set(rel, { size, sha256, ...classify(rel, size, head, maxText) });
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
      zip = await openZip(source.path, { caseCollision: 'allow', maxEntries: 500000, maxRatio: 1000 });
    } catch (err) {
      issues.push({ path: '.', reason: `cannot open the zip: ${describe(err)}` });
      opts.onProgress?.(100);
      return { files, issues };
    }
    try {
      const entries = zip.entries();
      const prefix = detectZipPrefix(entries.map((e) => e.name.replace(/\\/g, '/')));
      const wanted: { rel: string; name: string }[] = [];
      for (const e of entries) {
        const rel0 = e.name.replace(/\\/g, '/').slice(prefix.length);
        const root = rootOf(rel0);
        if (!root) continue;
        const rel = `${root}${rel0.slice(root.length)}`;
        if (rel.split('/').length < 2 || isExcludedPath(rel)) continue;
        wanted.push({ rel, name: e.name });
      }
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
  return { files: new Map([...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))), issues };
}

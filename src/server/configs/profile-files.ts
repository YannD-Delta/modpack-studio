import fsp from 'node:fs/promises';
import { safeResolve } from '../fs-safe/safe-path.js';
import { READ_ONLY_ZIP_LIMITS, openZip, type ZipHandle } from '../zip/zip-reader.js';
import { detectZipPrefix, isDirectoryEntry, rootOf, type InventoryEntry, type ScanSource } from './inventory.js';

export class InvalidRelPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRelPathError';
  }
}

/**
 * Checks a relative path coming from a client before it gets anywhere near the filesystem: forward slashes only,
 * no absolute/drive/UNC form, no `.`/`..`/empty segment, no alternate data stream, and under a tracked root.
 */
export function validateRelPath(rel: string): string {
  if (rel.length === 0 || rel.length > 1024) throw new InvalidRelPathError('empty or too long path');
  if (rel.includes('\0')) throw new InvalidRelPathError('NUL byte in path');
  if (rel.includes('\\')) throw new InvalidRelPathError('backslashes are not allowed, use forward slashes');
  if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) throw new InvalidRelPathError('absolute paths are not allowed');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') throw new InvalidRelPathError('empty, "." or ".." segment');
    if (seg.includes(':')) throw new InvalidRelPathError('":" is not allowed in a path segment');
  }
  if (!rootOf(rel) || rel.split('/').length < 2) throw new InvalidRelPathError('path must be inside a tracked folder (config, kubejs, ...)');
  return rel;
}

/** Inventory lookup that matches paths case-insensitively, like Windows does. Returns the inventory's own spelling. */
export function findInInventory(files: Record<string, InventoryEntry>, rel: string): { path: string; entry: InventoryEntry } | null {
  if (files[rel]) return { path: rel, entry: files[rel] };
  const key = rel.toLowerCase();
  for (const [p, entry] of Object.entries(files)) if (p.toLowerCase() === key) return { path: p, entry };
  return null;
}

export interface ProfileFileReader {
  /** Reads at most `maxBytes` of a tracked file (path as found in the inventory). */
  read(rel: string, maxBytes: number): Promise<Buffer>;
  close(): Promise<void>;
}

async function readHead(abs: string, maxBytes: number): Promise<Buffer> {
  const fh = await fsp.open(abs, 'r');
  try {
    const size = (await fh.stat()).size;
    const buf = Buffer.alloc(Math.min(size, maxBytes));
    let off = 0;
    while (off < buf.length) {
      const { bytesRead } = await fh.read(buf, off, buf.length - off, off);
      if (bytesRead === 0) break;
      off += bytesRead;
    }
    return buf.subarray(0, off);
  } finally {
    await fh.close();
  }
}

/** Opens the profile location on first use only (a server zip's directory is not parsed unless a file is needed). */
export function openProfileReader(source: ScanSource): ProfileFileReader {
  if (source.kind === 'folder') {
    return {
      read: async (rel, maxBytes) => readHead(safeResolve(source.path, validateRelPath(rel)), maxBytes),
      close: async () => undefined,
    };
  }
  let zipP: Promise<{ zip: ZipHandle; byKey: Map<string, string> }> | null = null;
  const open = () =>
    (zipP ??= (async () => {
      const zip = await openZip(source.path, { ...READ_ONLY_ZIP_LIMITS });
      const names = zip.entries().map((e) => e.name);
      const prefix = detectZipPrefix(names.map((n) => n.replace(/\\/g, '/')));
      const byKey = new Map<string, string>();
      for (const n of names) if (!isDirectoryEntry(n)) byKey.set(n.replace(/\\/g, '/').slice(prefix.length).toLowerCase(), n);
      return { zip, byKey };
    })());
  return {
    async read(rel, maxBytes) {
      const { zip, byKey } = await open();
      const name = byKey.get(validateRelPath(rel).toLowerCase());
      if (!name) throw new Error(`entry not found: ${rel}`);
      const buf = await zip.read(name);
      return buf.length > maxBytes ? buf.subarray(0, maxBytes) : buf;
    },
    async close() {
      if (zipP) await (await zipP.catch(() => null))?.zip.close();
      zipP = null;
    },
  };
}

import crypto from 'node:crypto';
import type { Profile } from '../profiles/profile-service.js';
import { diffInventories, MAX_DIFF_FILES, type ConfigDiff } from './diff.js';
import { readInventoryCache, type CachedInventory } from './inventory-cache.js';
import type { ScanSource } from './inventory.js';
import { NORMALIZE_MAX_BYTES } from './normalize.js';
import { openProfileReader, type ProfileFileReader } from './profile-files.js';

export class NotScannedError extends Error {
  constructor(public readonly profileId: number) {
    super(`the configs of profile ${profileId} were never scanned: run a scan first`);
    this.name = 'NotScannedError';
  }
}

/** Where the files of a profile can be read; agent profiles are not readable from here yet. */
export function sourceOf(profile: Pick<Profile, 'locationKind' | 'location'>): ScanSource | null {
  if (profile.locationKind === 'zip') return { kind: 'zip', path: profile.location };
  if (profile.locationKind === 'folder' || profile.locationKind === 'smb') return { kind: 'folder', path: profile.location };
  return null;
}

export function inventoryOrThrow(dataDir: string, profile: Profile): CachedInventory {
  const inv = readInventoryCache(dataDir, profile.id);
  if (!inv) throw new NotScannedError(profile.id);
  return inv;
}

export const sha256 = (buf: Buffer) => crypto.createHash('sha256').update(buf).digest('hex');

/** Content loader for both sides that refuses a file changed since the scan (its hash would poison the equality cache). */
export function pairLoader(base: { profile: Profile; inv: CachedInventory }, other: { profile: Profile; inv: CachedInventory }) {
  const readers: Partial<Record<'base' | 'other', ProfileFileReader>> = {};
  const sides = { base, other };
  const readRaw = async (side: 'base' | 'other', path: string, maxBytes: number): Promise<{ buf: Buffer; stale: boolean }> => {
    const s = sides[side];
    const src = sourceOf(s.profile);
    if (!src) throw new Error('profile location is not readable');
    const reader = (readers[side] ??= openProfileReader(src));
    const buf = await reader.read(path, maxBytes);
    const entry = s.inv.files[path];
    const stale = !!entry && entry.size <= maxBytes && (buf.length !== entry.size || sha256(buf) !== entry.sha256);
    return { buf, stale };
  };
  const load = async (side: 'base' | 'other', path: string, maxBytes = NORMALIZE_MAX_BYTES): Promise<Buffer> => {
    const { buf, stale } = await readRaw(side, path, maxBytes);
    if (stale) throw new Error(`${path} changed since the scan`);
    return buf;
  };
  const close = async () => {
    await Promise.all(Object.values(readers).map((r) => r.close()));
  };
  return { load, readRaw, close };
}

export async function compareProfiles(dataDir: string, base: Profile, other: Profile, opts: { maxFiles?: number } = {}): Promise<{ diff: ConfigDiff; baseInv: CachedInventory; otherInv: CachedInventory }> {
  const baseInv = inventoryOrThrow(dataDir, base);
  const otherInv = inventoryOrThrow(dataDir, other);
  const loader = pairLoader({ profile: base, inv: baseInv }, { profile: other, inv: otherInv });
  try {
    const diff = await diffInventories(baseInv.files, otherInv.files, { load: (side, p) => loader.load(side, p), maxFiles: opts.maxFiles ?? MAX_DIFF_FILES });
    return { diff, baseInv, otherInv };
  } finally {
    await loader.close();
  }
}

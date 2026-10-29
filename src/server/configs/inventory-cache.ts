import fs from 'node:fs';
import path from 'node:path';
import type { Inventory, InventoryEntry, ScanIssue } from './inventory.js';

export type CachedInventory = {
  version: 2;
  /** True when known binary files (textures...) were hashed too, not just compared by size. */
  deep?: boolean;
  profileId: number;
  location: string;
  scannedAt: string;
  files: Record<string, InventoryEntry>;
  issues: ScanIssue[];
};

export function inventoryCachePath(dataDir: string, profileId: number): string {
  return path.join(dataDir, 'cache', `configs-${profileId}.json`);
}

/** The last scan of a profile, or null when it was never scanned (or the cache file is unreadable). */
export function readInventoryCache(dataDir: string, profileId: number): CachedInventory | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(inventoryCachePath(dataDir, profileId), 'utf8')) as CachedInventory;
    return parsed?.version === 2 && parsed.files && typeof parsed.scannedAt === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/** Writes atomically (temp file + rename) so a crash mid-write never leaves a truncated cache. */
export function writeInventoryCache(dataDir: string, profileId: number, location: string, inv: Inventory, now = new Date(), deep = false): CachedInventory {
  const data: CachedInventory = { version: 2, deep, profileId, location, scannedAt: now.toISOString(), files: Object.fromEntries(inv.files), issues: inv.issues };
  const target = inventoryCachePath(dataDir, profileId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.part`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, target);
  return data;
}

/** Immutable snapshots (clean, launched) keep their scan forever; a `run` profile changes under us and is always rescanned. */
export function needsScan(profile: { immutable: boolean; location: string }, cached: CachedInventory | null, force: boolean, deep = false): boolean {
  return force || (deep && !cached?.deep) || !cached || !profile.immutable || cached.location !== profile.location;
}

/** Content identity of a config file: its sha256, or only its size when it was never hashed (known binaries in a quick scan). */
export type Fingerprint = { sha256: string; size: number; sizeOnly?: boolean };

export type ReplayStatus = 'safe' | 'already' | 'conflict' | 'warning';
export type ReplayReason = 'base-unchanged' | 'same-as-mine' | 'base-changed' | 'base-removed' | 'base-now-ships-it' | 'new-file' | 'new-mod' | 'base-updated' | 'already-gone';
export type Verdict = { status: ReplayStatus; reason: ReplayReason };

/** A size-only fingerprint is never compared with a real hash: only the sizes are. */
export function sameFile(a: Fingerprint, b: Fingerprint): boolean {
  if (a.sizeOnly || b.sizeOnly) return a.size === b.size;
  return a.sha256 === b.sha256;
}

/**
 * Three-way decision for one config file you changed, when a new version of the base comes out.
 * `base` is the file as the base shipped it when you validated (null = you added the file), `newBase` is the new base's file (null = absent).
 */
export function classifyFileChange(change: { mine: Fingerprint; base: Fingerprint | null }, newBase: Fingerprint | null): Verdict {
  const { mine, base } = change;
  if (base === null) {
    if (newBase === null) return { status: 'safe', reason: 'new-file' };
    return sameFile(newBase, mine) ? { status: 'already', reason: 'same-as-mine' } : { status: 'conflict', reason: 'base-now-ships-it' };
  }
  if (newBase === null) return { status: 'warning', reason: 'base-removed' };
  if (sameFile(newBase, base)) return { status: 'safe', reason: 'base-unchanged' };
  if (sameFile(newBase, mine)) return { status: 'already', reason: 'same-as-mine' };
  return { status: 'conflict', reason: 'base-changed' };
}

/** Same decision for one mod: `mineVersion` is your version (null for a removal), `baseVersion` the base version when you validated (null for an addition). */
export function classifyModChange(
  change: { action: 'add' | 'update' | 'remove'; mineVersion: string | null; baseVersion: string | null },
  newBase: { version: string } | null,
): Verdict {
  if (change.action === 'add') {
    if (newBase === null) return { status: 'safe', reason: 'new-mod' };
    return newBase.version === change.mineVersion ? { status: 'already', reason: 'same-as-mine' } : { status: 'conflict', reason: 'base-now-ships-it' };
  }
  if (change.action === 'update') {
    if (newBase === null) return { status: 'warning', reason: 'base-removed' };
    if (newBase.version === change.baseVersion) return { status: 'safe', reason: 'base-unchanged' };
    return newBase.version === change.mineVersion ? { status: 'already', reason: 'same-as-mine' } : { status: 'conflict', reason: 'base-updated' };
  }
  return newBase === null ? { status: 'already', reason: 'already-gone' } : { status: 'safe', reason: 'base-unchanged' };
}

import type { Db } from '../db/open.js';
import { readPrefsFile, writePrefsFile } from './secrets-store.js';

/**
 * The two packs Studio works with are roles, not names: the `upstream` pack is the one you follow (default Base),
 * the `own` pack is yours (default Own). Both names are settings and are stored as the `pack` of every profile.
 */
export type PackNames = { upstream: string; own: string };
export const DEFAULT_PACKS: PackNames = { upstream: 'Base', own: 'Own' };

const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,39}$/;

export class PackNamesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackNamesError';
  }
}

export function validatePackNames(names: PackNames): PackNames {
  const upstream = names.upstream.trim();
  const own = names.own.trim();
  if (!NAME.test(upstream) || !NAME.test(own)) throw new PackNamesError('a pack name is 1 to 40 letters, digits, spaces, dots, dashes, underscores or plus signs, and starts with a letter or digit');
  if (upstream.toLowerCase() === own.toLowerCase()) throw new PackNamesError('the two packs need different names');
  return { upstream, own };
}

export function readPackNames(dataDir: string): PackNames {
  const p = readPrefsFile(dataDir).packs as Partial<PackNames> | undefined;
  try {
    return validatePackNames({ upstream: p?.upstream ?? DEFAULT_PACKS.upstream, own: p?.own ?? DEFAULT_PACKS.own });
  } catch {
    return DEFAULT_PACKS; // a damaged preferences file falls back to the defaults rather than breaking every page
  }
}

/**
 * Saves the names and renames the packs already stored, in one step, so existing profiles follow.
 * The two names may swap or reuse each other's old name: rows move through a temporary value.
 */
export function writePackNames(db: Db, dataDir: string, next: PackNames): PackNames {
  const names = validatePackNames(next);
  const current = readPackNames(dataDir);
  db.sqlite.transaction(() => {
    const move = (from: string, to: string) => db.sqlite.prepare('UPDATE pack_version SET pack = ? WHERE pack = ?').run(to, from);
    if (current.upstream !== names.upstream || current.own !== names.own) {
      move(current.upstream, '\u0000upstream');
      move(current.own, '\u0000own');
      move('\u0000upstream', names.upstream);
      move('\u0000own', names.own);
    }
  })();
  writePrefsFile(dataDir, { ...readPrefsFile(dataDir), packs: names });
  return names;
}

export const isOwn = (names: PackNames, pack: string) => pack === names.own;
export const isUpstream = (names: PackNames, pack: string) => pack === names.upstream;
export const knownPack = (names: PackNames, pack: string) => isOwn(names, pack) || isUpstream(names, pack);

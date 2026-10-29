import type { Db } from '../db/open.js';
import type { ModEntry, ModSet } from './diff.js';

/** Top-level mods of an imported profile (library jars and jar-in-jar rows excluded); on a duplicate id the first jar wins. */
export function loadModSet(db: Db, profileId: number): ModSet {
  const rows = db.sqlite
    .prepare(
      `SELECT m.mod_id, m.version, m.jar_sha256, j.filename
       FROM jar_mod m JOIN jar j ON j.sha256 = m.jar_sha256
       WHERE m.profile_id = ? AND m.is_jij = 0 AND m.library_key IS NULL
       ORDER BY j.filename`,
    )
    .all(profileId) as { mod_id: string; version: string; jar_sha256: string; filename: string }[];
  const set: ModSet = new Map();
  for (const r of rows) {
    if (!set.has(r.mod_id)) set.set(r.mod_id, { modId: r.mod_id, version: r.version, sha256: r.jar_sha256, file: r.filename } satisfies ModEntry);
  }
  return set;
}

/** Top-level mod ids declared by more than one jar of the profile. */
export function findDuplicateIds(db: Db, profileId: number): { modId: string; files: string[] }[] {
  const rows = db.sqlite
    .prepare(
      `SELECT m.mod_id, j.filename
       FROM jar_mod m JOIN jar j ON j.sha256 = m.jar_sha256
       WHERE m.profile_id = ? AND m.is_jij = 0 AND m.library_key IS NULL
       ORDER BY m.mod_id, j.filename`,
    )
    .all(profileId) as { mod_id: string; filename: string }[];
  const byId = new Map<string, string[]>();
  for (const r of rows) byId.set(r.mod_id, [...(byId.get(r.mod_id) ?? []), r.filename]);
  return [...byId.entries()].filter(([, files]) => files.length > 1).map(([modId, files]) => ({ modId, files }));
}

export function resolvedAnomalies(db: Db): Set<string> {
  const rows = db.sqlite.prepare("SELECT mod_id FROM mod_decision WHERE kind = 'ignore'").all() as { mod_id: string }[];
  return new Set(rows.map((r) => r.mod_id));
}

import { audit } from '../db/audit.js';
import type { Db } from '../db/open.js';
import type { Side } from './side-classifier.js';

export type BlacklistEntry = { modId: string; origin: 'atm_derived' | 'user'; stale: boolean };
export type Decision = { modId: string; kind: 'side' | 'pin' | 'ignore'; side?: Side; reason: string };

/** Replaces every base-derived row with the client-only set of this base version; the user's own entries are never touched. */
export function recomputeAtmDerived(db: Db, atmVersion: string, clientOnlyIds: string[]): void {
  db.sqlite.transaction(() => {
    db.sqlite.prepare("DELETE FROM blacklist WHERE origin = 'atm_derived'").run();
    const insert = db.sqlite.prepare("INSERT INTO blacklist (mod_id, origin, valid_for, reason) VALUES (?, 'atm_derived', ?, 'client-only in the followed pack (client minus server pack)')");
    for (const id of clientOnlyIds) insert.run(id, atmVersion);
    audit(db, 'blacklist.recompute_atm_derived', atmVersion, { count: clientOnlyIds.length });
  })();
}

export function addToBlacklist(db: Db, modId: string, reason: string): void {
  db.sqlite
    .prepare("INSERT INTO blacklist (mod_id, origin, valid_for, reason) VALUES (?, 'user', NULL, ?) ON CONFLICT(mod_id, origin) DO UPDATE SET reason = excluded.reason")
    .run(modId, reason);
  audit(db, 'blacklist.add', modId, { reason });
}

export type RemoveBlacklistResult = 'removed' | 'absent' | 'atm_derived';

/** Removes the user's own entry; an base-derived row is computed from the packs and is never removed here. */
export function removeFromBlacklist(db: Db, modId: string): RemoveBlacklistResult {
  return db.sqlite.transaction((): RemoveBlacklistResult => {
    const rows = db.sqlite.prepare('SELECT origin, reason FROM blacklist WHERE mod_id = ?').all(modId) as { origin: string; reason: string }[];
    const mine = rows.find((r) => r.origin === 'user');
    if (!mine) return rows.length > 0 ? 'atm_derived' : 'absent';
    db.sqlite.prepare("DELETE FROM blacklist WHERE mod_id = ? AND origin = 'user'").run(modId);
    audit(db, 'blacklist.remove', modId, { reason: mine.reason });
    return 'removed';
  })();
}

/** Edits the reason of the user's own entry (same outcomes as removeFromBlacklist, without removing anything). */
export function setBlacklistReason(db: Db, modId: string, reason: string): RemoveBlacklistResult | 'updated' {
  return db.sqlite.transaction((): RemoveBlacklistResult | 'updated' => {
    const rows = db.sqlite.prepare('SELECT origin, reason FROM blacklist WHERE mod_id = ?').all(modId) as { origin: string; reason: string }[];
    const mine = rows.find((r) => r.origin === 'user');
    if (!mine) return rows.length > 0 ? 'atm_derived' : 'absent';
    db.sqlite.prepare("UPDATE blacklist SET reason = ? WHERE mod_id = ? AND origin = 'user'").run(reason, modId);
    audit(db, 'blacklist.reason', modId, { from: mine.reason, to: reason });
    return 'updated';
  })();
}

export function setDecision(db: Db, d: Decision): void {
  db.sqlite
    .prepare(
      'INSERT INTO mod_decision (mod_id, kind, side, reason, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(mod_id, kind) DO UPDATE SET side = excluded.side, reason = excluded.reason, created_at = excluded.created_at',
    )
    .run(d.modId, d.kind, d.side ?? null, d.reason, new Date().toISOString());
  audit(db, 'decision.set', d.modId, d);
}

export function getPins(db: Db): Set<string> {
  const rows = db.sqlite.prepare("SELECT mod_id FROM mod_decision WHERE kind = 'pin'").all() as { mod_id: string }[];
  return new Set(rows.map((r) => r.mod_id));
}

/** The server blacklist: base-derived and the user's rows, then side decisions applied on top ('client' adds, 'server'/'both' removes). */
export function effectiveBlacklist(db: Db, atmVersion: string): BlacklistEntry[] {
  const rows = db.sqlite.prepare('SELECT mod_id, origin, valid_for FROM blacklist').all() as { mod_id: string; origin: 'atm_derived' | 'user'; valid_for: string | null }[];
  const entries = new Map<string, BlacklistEntry>();
  for (const r of rows) {
    if (entries.get(r.mod_id)?.origin === 'user') continue; // the user's own row wins over a derived one, whatever the row order
    entries.set(r.mod_id, { modId: r.mod_id, origin: r.origin, stale: r.origin === 'atm_derived' && r.valid_for !== atmVersion });
  }

  const decisions = db.sqlite.prepare("SELECT mod_id, side FROM mod_decision WHERE kind = 'side'").all() as { mod_id: string; side: Side }[];
  for (const d of decisions) {
    if (d.side === 'client') entries.set(d.mod_id, { modId: d.mod_id, origin: 'user', stale: false });
    else entries.delete(d.mod_id);
  }
  return [...entries.values()].sort((a, b) => a.modId.localeCompare(b.modId));
}

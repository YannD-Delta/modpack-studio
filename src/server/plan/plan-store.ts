import type { Db } from '../db/open.js';

export type PlanKind = 'mod' | 'file';
export type PlanItem = { kind: PlanKind; key: string; action: 'take_ref' };

/** Selects or unselects `keys` of one kind in the plan of a comparison (base profile -> other profile). Idempotent. */
export function setPlanItems(db: Db, base: number, other: number, kind: PlanKind, keys: string[], selected: boolean): void {
  const insert = db.sqlite.prepare(
    "INSERT INTO update_plan_item (base_profile_id, other_profile_id, kind, key, action, created_at) VALUES (?, ?, ?, ?, 'take_ref', ?) ON CONFLICT(base_profile_id, other_profile_id, kind, key) DO NOTHING",
  );
  const remove = db.sqlite.prepare('DELETE FROM update_plan_item WHERE base_profile_id = ? AND other_profile_id = ? AND kind = ? AND key = ?');
  const now = new Date().toISOString();
  db.sqlite.transaction(() => {
    for (const key of keys) {
      if (selected) insert.run(base, other, kind, key, now);
      else remove.run(base, other, kind, key);
    }
  })();
}

export function getPlanItems(db: Db, base: number, other: number, kind?: PlanKind): PlanItem[] {
  const sql = `SELECT kind, key, action FROM update_plan_item WHERE base_profile_id = ? AND other_profile_id = ?${kind ? ' AND kind = ?' : ''} ORDER BY kind, key`;
  return db.sqlite.prepare(sql).all(...(kind ? [base, other, kind] : [base, other])) as PlanItem[];
}

export function clearPlan(db: Db, base: number, other: number, kind?: PlanKind): void {
  const sql = `DELETE FROM update_plan_item WHERE base_profile_id = ? AND other_profile_id = ?${kind ? ' AND kind = ?' : ''}`;
  db.sqlite.prepare(sql).run(...(kind ? [base, other, kind] : [base, other]));
}

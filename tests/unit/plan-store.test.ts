import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/server/db/open.js';
import { clearPlan, getPlanItems, setPlanItems } from '../../src/server/plan/plan-store.js';
import { createProfile } from '../../src/server/profiles/profile-service.js';

function setup() {
  const db = openDb(':memory:');
  const mk = (pack: 'Base' | 'Own', version: string) => createProfile(db, { pack, version, side: 'client', state: 'launched', locationKind: 'folder', location: `/x/${pack}${version}` });
  return { db, base: mk('Base', '8.3').id, other: mk('Own', 'test').id };
}

describe('plan store', () => {
  it('selects, lists and unselects items per kind, idempotently', () => {
    const { db, base, other } = setup();
    setPlanItems(db, base, other, 'mod', ['b', 'a'], true);
    setPlanItems(db, base, other, 'mod', ['a'], true);
    setPlanItems(db, base, other, 'file', ['config/x.toml'], true);
    expect(getPlanItems(db, base, other, 'mod').map((i) => i.key)).toEqual(['a', 'b']);
    expect(getPlanItems(db, base, other).length).toBe(3);
    setPlanItems(db, base, other, 'mod', ['a'], false);
    expect(getPlanItems(db, base, other, 'mod').map((i) => i.key)).toEqual(['b']);
  });

  it('keeps comparisons apart and clears one kind at a time', () => {
    const { db, base, other } = setup();
    setPlanItems(db, base, other, 'mod', ['a'], true);
    setPlanItems(db, base, other, 'file', ['kubejs/x.js'], true);
    expect(getPlanItems(db, other, base).length).toBe(0);
    clearPlan(db, base, other, 'file');
    expect(getPlanItems(db, base, other).map((i) => i.kind)).toEqual(['mod']);
    clearPlan(db, base, other);
    expect(getPlanItems(db, base, other)).toEqual([]);
  });
});

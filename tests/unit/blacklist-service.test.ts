import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/server/db/open.js';
import { addToBlacklist, effectiveBlacklist, getPins, recomputeAtmDerived, setDecision } from '../../src/server/mods/blacklist-service.js';

let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
});
const audits = () => (db.sqlite.prepare('SELECT count(*) AS n FROM audit_log').get() as { n: number }).n;

describe('blacklist service', () => {
  it('replaces the previous ATM-derived rows but keeps user entries', () => {
    recomputeAtmDerived(db, '8.2', ['old1', 'old2']);
    addToBlacklist(db, 'mine', 'useless on server');
    recomputeAtmDerived(db, '8.3', ['new1']);
    const list = effectiveBlacklist(db, '8.3');
    expect(list.map((e) => [e.modId, e.origin]).sort()).toEqual([['mine', 'user'], ['new1', 'atm_derived']]);
  });

  it('flags ATM-derived rows computed for another ATM version as stale', () => {
    recomputeAtmDerived(db, '8.2', ['a']);
    expect(effectiveBlacklist(db, '8.2')[0]!.stale).toBe(false);
    expect(effectiveBlacklist(db, '8.3')[0]!.stale).toBe(true);
  });

  it('keeps a pin across a recompute', () => {
    setDecision(db, { modId: 'pinned', kind: 'pin', reason: 'intentional downgrade' });
    recomputeAtmDerived(db, '8.3', ['x']);
    expect(getPins(db)).toEqual(new Set(['pinned']));
  });

  it('applies a side decision on top of the ATM-derived list', () => {
    recomputeAtmDerived(db, '8.3', ['keepMe', 'dropMe']);
    setDecision(db, { modId: 'keepMe', kind: 'side', side: 'both', reason: 'needed on server' });
    setDecision(db, { modId: 'extra', kind: 'side', side: 'client', reason: 'client only' });
    const ids = effectiveBlacklist(db, '8.3').map((e) => e.modId).sort();
    expect(ids).toEqual(['dropMe', 'extra']);
  });

  it('writes an audit_log row for every write', () => {
    const before = audits();
    recomputeAtmDerived(db, '8.3', ['a']);
    addToBlacklist(db, 'b', 'r');
    setDecision(db, { modId: 'c', kind: 'pin', reason: 'r' });
    expect(audits()).toBe(before + 3);
  });
});

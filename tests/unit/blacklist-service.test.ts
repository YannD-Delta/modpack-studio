import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/server/db/open.js';
import { addToBlacklist, effectiveBlacklist, getPins, recomputeUpstreamDerived, setDecision } from '../../src/server/mods/blacklist-service.js';

let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
});
const audits = () => (db.sqlite.prepare('SELECT count(*) AS n FROM audit_log').get() as { n: number }).n;

describe('blacklist service', () => {
  it('replaces the previous base-derived rows but keeps user entries', () => {
    recomputeUpstreamDerived(db, '8.2', ['old1', 'old2']);
    addToBlacklist(db, 'mine', 'useless on server');
    recomputeUpstreamDerived(db, '8.3', ['new1']);
    const list = effectiveBlacklist(db, '8.3');
    expect(list.map((e) => [e.modId, e.origin]).sort()).toEqual([['mine', 'user'], ['new1', 'upstream_derived']]);
  });

  it.each([['user first', true], ['derived first', false]])('keeps the user origin when the same mod is also derived (%s)', (_label, userFirst) => {
    if (userFirst) addToBlacklist(db, 'both', 'mine');
    recomputeUpstreamDerived(db, '8.2', ['both']);
    if (!userFirst) addToBlacklist(db, 'both', 'mine');
    for (const version of ['8.2', '8.3']) {
      expect(effectiveBlacklist(db, version)).toEqual([{ modId: 'both', origin: 'user', stale: false }]);
    }
  });

  it('flags base-derived rows computed for another base version as stale', () => {
    recomputeUpstreamDerived(db, '8.2', ['a']);
    expect(effectiveBlacklist(db, '8.2')[0]!.stale).toBe(false);
    expect(effectiveBlacklist(db, '8.3')[0]!.stale).toBe(true);
  });

  it('keeps a pin across a recompute', () => {
    setDecision(db, { modId: 'pinned', kind: 'pin', reason: 'intentional downgrade' });
    recomputeUpstreamDerived(db, '8.3', ['x']);
    expect(getPins(db)).toEqual(new Set(['pinned']));
  });

  it('applies a side decision on top of the base-derived list', () => {
    recomputeUpstreamDerived(db, '8.3', ['keepMe', 'dropMe']);
    setDecision(db, { modId: 'keepMe', kind: 'side', side: 'both', reason: 'needed on server' });
    setDecision(db, { modId: 'extra', kind: 'side', side: 'client', reason: 'client only' });
    const ids = effectiveBlacklist(db, '8.3').map((e) => e.modId).sort();
    expect(ids).toEqual(['dropMe', 'extra']);
  });

  it('writes an audit_log row for every write', () => {
    const before = audits();
    recomputeUpstreamDerived(db, '8.3', ['a']);
    addToBlacklist(db, 'b', 'r');
    setDecision(db, { modId: 'c', kind: 'pin', reason: 'r' });
    expect(audits()).toBe(before + 3);
  });
});

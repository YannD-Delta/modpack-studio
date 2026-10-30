import { describe, expect, it } from 'vitest';
import { AtmVersionMismatchError, anomalies, buildBlockers, deriveAtmSides, diffModSets, ownLayer, type ModSet } from '../../src/server/mods/diff.js';

const set = (rows: [id: string, version: string, sha: string, file?: string][]): ModSet =>
  new Map(rows.map(([modId, version, sha256, file]) => [modId, { modId, version, sha256, file: file ?? `${modId}-${version}.jar` }]));

describe('diffModSets', () => {
  it('reports the same id under a new file name as updated, not removed plus added', () => {
    const d = diffModSets(set([['a', '1.0', 'h1']]), set([['a', '1.1', 'h2']]));
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.updated).toHaveLength(1);
    expect(d.updated[0]).toMatchObject({ modId: 'a', direction: 'newer' });
  });

  it('reports same id and version with a different hash as rebuilt', () => {
    const d = diffModSets(set([['a', '1.0', 'h1']]), set([['a', '1.0', 'h2']]));
    expect(d.rebuilt.map((e) => e.modId)).toEqual(['a']);
    expect(d.updated).toEqual([]);
  });

  it('flags a lower version as older', () => {
    expect(diffModSets(set([['a', '2.0', 'h1']]), set([['a', '1.0', 'h2']])).updated[0]!.direction).toBe('older');
  });

  it('reports unorderable versions as different', () => {
    expect(diffModSets(set([['a', 'ABC', 'h1']]), set([['a', 'DEF', 'h2']])).updated[0]!.direction).toBe('different');
  });

  it('reports a pre-release word against a release as different, in both directions, and a pin does not silence it', () => {
    expect(diffModSets(set([['a', '2.0.0', 'h1']]), set([['a', '2.0.0-dev', 'h2']])).updated[0]!.direction).toBe('different');
    expect(diffModSets(set([['a', '2.0.0-dev', 'h1']]), set([['a', '2.0.0', 'h2']])).updated[0]!.direction).toBe('different');
    expect(diffModSets(set([['a', '2.0.0', 'h1']]), set([['a', '2.0.0-dev', 'h2']]), { pins: new Set(['a']) }).updated).toHaveLength(1);
  });

  it('does not report a pinned id', () => {
    const d = diffModSets(set([['a', '2.0', 'h1']]), set([['a', '1.0', 'h2']]), { pins: new Set(['a']) });
    expect(d.updated).toEqual([]);
    expect(d.unchanged).toBe(1);
  });

  it('a pin only silences an intentional downgrade: newer, added and removed ids are still reported', () => {
    const pins = new Set(['up', 'new', 'gone']);
    const d = diffModSets(set([['up', '1.0', 'h1'], ['gone', '1', 'g']]), set([['up', '2.0', 'h2'], ['new', '1', 'n']]), { pins });
    expect(d.updated.map((u) => u.modId)).toEqual(['up']);
    expect(d.added.map((e) => e.modId)).toEqual(['new']);
    expect(d.removed.map((e) => e.modId)).toEqual(['gone']);
  });

  it('lists added and removed ids and counts unchanged ones', () => {
    const d = diffModSets(set([['keep', '1', 'k'], ['gone', '1', 'g']]), set([['keep', '1', 'k'], ['new', '1', 'n']]));
    expect(d.added.map((e) => e.modId)).toEqual(['new']);
    expect(d.removed.map((e) => e.modId)).toEqual(['gone']);
    expect(d.unchanged).toBe(1);
  });
});

describe('deriveAtmSides', () => {
  const atmS = set([['both1', '1', 's1'], ['srv', '1', 's2']]);
  const atmC = set([['both1', '1', 's1'], ['cli', '1', 's3']]);

  it('derives client-only, server-only and both from base own client and server sets', () => {
    expect(deriveAtmSides(atmS, atmC, { server: '8.3', client: '8.3' })).toEqual({ clientOnly: ['cli'], serverOnly: ['srv'], both: ['both1'] });
  });

  it('refuses when the base client and server versions differ', () => {
    expect(() => deriveAtmSides(atmS, atmC, { server: '8.2', client: '8.3' })).toThrow(AtmVersionMismatchError);
  });
});

describe('ownLayer, anomalies and blockers', () => {
  const atmC = set([['a', '1', 'x'], ['b', '1', 'y'], ['c', '1', 'z']]);
  const lmpC = set([['a', '2', 'x2'], ['c', '1', 'z'], ['mine', '1', 'm']]);

  it("computes the user's layer client against client", () => {
    const layer = ownLayer(lmpC, atmC);
    expect(layer.updated.map((u) => u.modId)).toEqual(['a']);
    expect(layer.added.map((e) => e.modId)).toEqual(['mine']);
  });

  it('lists base client mods missing from Own as anomalies, minus resolved ones', () => {
    expect(anomalies(atmC, lmpC).map((e) => e.modId)).toEqual(['b']);
    expect(anomalies(atmC, lmpC, new Set(['b']))).toEqual([]);
  });

  it('returns one blocker per unresolved anomaly and per duplicate id', () => {
    const blockers = buildBlockers({ anomalies: anomalies(atmC, lmpC), duplicateIds: [{ modId: 'dup', files: ['d1.jar', 'd2.jar'] }] });
    expect(blockers).toEqual([{ code: 'ANOMALY', modId: 'b' }, { code: 'DUPLICATE_ID', modId: 'dup' }]);
  });
});

import { describe, expect, it } from 'vitest';
import { compareVersions, explainCompare } from '../../src/shared/versions.js';

const PAIRS: [string, string][] = [
  ['1.2.10', '1.2.9'],
  ['1.2.9', '1.2.10'],
  ['1.0-beta', '1.0'],
  ['1.0-rc1', '1.0-beta2'],
  ['1.0-SNAPSHOT', '1.0'],
  ['1.0-sp1', '1.0'],
  ['21.1.259', '21.1.251'],
  ['1.0', '1.0.0'],
  ['1.2.3', '1.2.3'],
  ['1.0-abc123f', '1.0-def456a'],
  ['1.0-foo', '1.0-bar'],
  ['1.0-foo', '1.0-foo'],
  ['ABC', 'DEF'],
  ['', '1.0'],
  ['${file.jarVersion}', '1.0'],
];

describe('explainCompare', () => {
  it.each(PAIRS)('%s vs %s gives the same result as compareVersions', (a, b) => {
    expect(explainCompare(a, b).result).toBe(compareVersions(a, b));
  });

  it('names the deciding token', () => {
    const e = explainCompare('1.2.10', '1.2.9');
    expect(e.result).toBe('newer');
    expect(e.a.tokens).toEqual(['1', '2', '10']);
    expect(e.deciding).toEqual({ index: 2, tokenA: '10', tokenB: '9' });
    expect(e.note).toMatch(/10.*9/);
  });

  it('shows a missing token as null when one version is shorter', () => {
    const e = explainCompare('1.0-beta', '1.0');
    expect(e.result).toBe('older');
    expect(e.deciding).toEqual({ index: 2, tokenA: 'beta', tokenB: null });
  });

  it('flags commit hashes and unparsable strings', () => {
    const h = explainCompare('1.0-abc123f', '1.0');
    expect(h.a.hashLike).toBe(true);
    expect(h.a.unparsable).toBe(true);
    expect(h.deciding).toBeNull();
    expect(h.note).toMatch(/hash/i);
    const p = explainCompare('${file.jarVersion}', '1.0');
    expect(p.a.unparsable).toBe(true);
    expect(p.a.hashLike).toBe(false);
  });

  it('explains equal versions and unknown qualifiers', () => {
    expect(explainCompare('1.0', '1.0.0')).toMatchObject({ result: 'equal', deciding: null });
    const q = explainCompare('1.0-foo', '1.0-bar');
    expect(q.result).toBe('incomparable');
    expect(q.deciding).toEqual({ index: 2, tokenA: 'foo', tokenB: 'bar' });
    expect(q.note).toMatch(/qualifier/i);
  });
});

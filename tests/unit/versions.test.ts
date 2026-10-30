import { describe, expect, it } from 'vitest';
import { compareVersions, explainCompare, type VersionOrder } from '../../src/shared/versions.js';

describe('compareVersions (a relative to b)', () => {
  it.each([
    ['1.2.10', '1.2.9', 'newer'],
    ['1.2.9', '1.2.10', 'older'],
    ['1.0-beta', '1.0', 'older'],
    ['1.0-rc1', '1.0-beta2', 'newer'],
    ['1.0-SNAPSHOT', '1.0', 'older'],
    ['1.0-sp1', '1.0', 'newer'],
    ['21.1.259', '21.1.251', 'newer'],
    ['2.1.9-1.19.2-43.1.1', '2.1.8-1.19.2-43.1.1', 'newer'],
    ['1.0', '1.0.0', 'equal'],
    ['1.0.0', '1.0', 'equal'],
    ['1.2.3', '1.2.3', 'equal'],
  ] as const)('%s vs %s is %s', (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
  });

  it.each([
    ['1.0-abc123f', '1.0-def456a'],
    ['1.0-foo', '1.0-bar'],
    ['2.1.0+a1b2c3d4', '2.1.0+e5f6a7b8'],
  ])('%s vs %s is incomparable (unknown qualifiers or commit hashes are not an order)', (a, b) => {
    expect(compareVersions(a, b)).toBe('incomparable');
  });

  // A lone trailing letter is a patch letter (create-enchantment-industry 2.5.4b, advancedperipherals 0.8.2a), not Maven's alpha/beta:
  // the alpha/beta/milestone aliases only apply when the letter is glued to a number (1.0b1).
  it.each([
    ['2.5.4b', '2.5.4', 'newer'],
    ['2.5.4', '2.5.4b', 'older'],
    ['1.21.1-0.8.2a', '1.21.1-0.8.2', 'newer'],
    ['1.0b', '1.0a', 'newer'],
    ['1.0a', '1.0b', 'older'],
    ['1.0b', '1.0-beta', 'newer'],
    ['2.5.4c', '2.5.4b', 'newer'],
    ['2.5.5', '2.5.4b', 'newer'],
    ['1.0b1', '1.0', 'older'],
    ['1.0a1', '1.0b1', 'older'],
    ['1.0m2', '1.0', 'older'],
  ] as const)('patch letters: %s vs %s is %s', (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
  });

  it('still equals itself with an unknown qualifier', () => {
    expect(compareVersions('1.0-foo', '1.0-foo')).toBe('equal');
  });

  it.each([
    ['ABC', 'DEF'],
    ['', '1.0'],
    ['1.0', ''],
    ['${file.jarVersion}', '1.0'],
    ['1.0', '${file.jarVersion}'],
  ])('%s vs %s is incomparable', (a, b) => {
    expect(compareVersions(a, b)).toBe('incomparable');
  });
});

describe('zero segments are inert next to a qualifier', () => {
  it.each([
    ['1.0-beta1', '1.0.0-beta1', 'equal'],
    ['1.0-final', '1.0.0', 'equal'],
    ['2.5.4b', '2.5.4.0', 'newer'],
    ['1.0-sp1', '1.0.0', 'newer'],
    ['1.0a', '1.0.0', 'newer'],
    ['1.0.0', '1.0-beta', 'newer'],
    ['1.0.1', '1.0-sp1', 'newer'],
  ] as const)('%s vs %s is %s', (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
  });
});

describe('unknown qualifiers have no order against a release or a known qualifier', () => {
  it.each([
    ['1.2.3-pre1', '1.2.3'],
    ['2.0.0-dev', '2.0.0'],
    ['1.2.3-dev', '1.2.3-rc1'],
    ['1.0.0-nightly', '1.0.0'],
    ['1.0.0+mc1.21', '1.0.0'],
  ])('%s vs %s is incomparable in both directions', (a, b) => {
    expect(compareVersions(a, b)).toBe('incomparable');
    expect(compareVersions(b, a)).toBe('incomparable');
  });

  it.each([
    ['1.0-dev2', '1.0-dev1', 'newer'],
    ['1.0-forge-1.3', '1.0-forge-1.2', 'newer'],
    ['1.0.0-dev', '1.0.1', 'older'],
    ['1.0.0-dev', '1.0.0-dev', 'equal'],
  ] as const)('%s vs %s stays %s', (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
  });
});

describe('a leading v before a digit is a prefix, not a qualifier', () => {
  it.each([
    ['v1.2.4', '1.2.3', 'newer'],
    ['1.2.3', 'v1.2.4', 'older'],
    ['v1.2.3', '1.2.3', 'equal'],
    ['V1.0', 'v1.0', 'equal'],
    ['v1.2.3', 'v1.2.4', 'older'],
    ['v1.0-beta', '1.0', 'older'],
    ['v2.0', '1.9', 'newer'],
  ] as const)('%s vs %s is %s', (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
  });

  it('keeps a v that is not followed by a digit as a qualifier', () => {
    expect(compareVersions('ver1', '1')).toBe('older');
    expect(explainCompare('ver1', '1').a.tokens).toEqual(['ver', '1']);
  });
});

describe('git describe hashes', () => {
  it.each([
    ['1.2.3+g1a2b3c4', '1.2.3+g9a2b3c4'],
    ['1.2.3-4-g1a2b3c4', '1.2.3-4-g5d6e7f8'],
  ])('%s vs %s is incomparable', (a, b) => {
    expect(compareVersions(a, b)).toBe('incomparable');
  });

  it('keeps ordering a g-prefixed plain number', () => {
    expect(compareVersions('1.0-g1234567', '1.0-g1234568')).toBe('older');
  });
});

describe('huge numeric segments and prototype keys', () => {
  it.each([
    ['1.9007199254740993', '1.9007199254740992', 'newer'],
    ['1.20240101123456788', '1.20240101123456789', 'older'],
    ['99999999999999999999', '99999999999999999998', 'newer'],
    ['1.0000000000000000000002', '1.2', 'equal'],
  ] as const)('%s vs %s is %s', (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
  });

  it('compares 400 digit segments exactly and equals itself', () => {
    expect(compareVersions('1.1' + '0'.repeat(400), '1.9' + '0'.repeat(399))).toBe('newer');
    expect(compareVersions('1.1' + '0'.repeat(399), '1.9' + '0'.repeat(399))).toBe('older');
    const v = '1.' + '9'.repeat(400);
    expect(compareVersions(v, v)).toBe('equal');
  });

  it.each(['constructor', 'toString', 'hasOwnProperty', 'valueOf'])('the qualifier %s is a plain unknown word', (word) => {
    const e = explainCompare(`1.0-${word}`, '1.0');
    expect(e.a.tokens).toEqual(['1', '0', word.toLowerCase()]);
    expect(e.result).toBe('incomparable');
    expect(compareVersions(`1.0-${word}`, `1.0-${word}`)).toBe('equal');
  });
});

describe('aliases', () => {
  it.each([
    ['1.0-final', '1.0', 'equal'],
    ['1.0-ga', '1.0', 'equal'],
    ['1.0-release', '1.0', 'equal'],
    ['1.0-cr1', '1.0-rc1', 'equal'],
  ] as const)('%s vs %s is %s', (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
  });
});

// Property check: wherever two versions are comparable the order is antisymmetric and transitive, and versions that
// compare equal are interchangeable. Pool = hand-picked tricky strings + a seeded random generator.
const FIXED_POOL = [
  '1', '1.0', '1.0.0', '1.0.0.0', '1.0.1', '1.1', '2', '2.5.4', '2.5.4.0', '2.5.4b', '2.5.4a', '2.5.5', '1.0a', '1.0b', '1.0a1', '1.0b1', '1.0m2',
  '1.0-alpha', '1.0-beta', '1.0-beta1', '1.0.0-beta1', '1.0-rc1', '1.0-cr1', '1.0-SNAPSHOT', '1.0-final', '1.0-ga', '1.0.0-final', '1.0-sp1', '1.0.0-sp1',
  '1.0-dev', '1.0.0-dev', '1.0-dev1', '1.0-dev2', '1.0-foo', '1.0-bar', '1.0+mc1.21', 'v1.0', 'V1.0.0', 'v1.0-beta', 'v2', '1.0-forge-1.2', '1.0-forge-1.3',
  '1.0.0.1', '1.0.0.0-rc1', '1.0-0-rc1', '1.0.sp', '1.0.final.1', '1.0-final-sp1', '0', '0.0', '0-rc1', '1.9007199254740993', '1.9007199254740992', '1.0-abc123f', '${x}', 'abc',
];

function seededPool(count: number): string[] {
  let s = 0x2f6e2b1;
  const rnd = (n: number) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s >>> 8) % n;
  };
  const nums = ['0', '0', '0', '1', '2', '10', '007'];
  const quals = ['alpha', 'beta', 'rc', 'cr', 'snapshot', 'final', 'ga', 'sp', 'a', 'b', 'c', 'm', 'dev', 'pre', 'x'];
  const seps = ['.', '.', '-', '_', '+'];
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    let v = rnd(6) === 0 ? 'v' : '';
    const segs = 1 + rnd(4);
    for (let k = 0; k < segs; k++) {
      if (k > 0) v += seps[rnd(seps.length)]!;
      v += rnd(3) === 0 && k > 0 ? quals[rnd(quals.length)]! + (rnd(2) ? nums[rnd(nums.length)]! : '') : nums[rnd(nums.length)]!;
    }
    out.push(v);
  }
  return out;
}

describe('version order is a consistent partial order', () => {
  const pool = [...new Set([...FIXED_POOL, ...seededPool(80)])];
  const cmp = new Map<string, VersionOrder>();
  for (const a of pool) for (const b of pool) cmp.set(`${a}\u0000${b}`, compareVersions(a, b));
  const get = (a: string, b: string) => cmp.get(`${a}\u0000${b}`)!;
  const flip = { newer: 'older', older: 'newer', equal: 'equal', incomparable: 'incomparable' } as const;

  it('is antisymmetric', () => {
    const bad = pool.flatMap((a) => pool.filter((b) => get(a, b) !== flip[get(b, a)]).map((b) => `${a} | ${b}`));
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it('never calls a version newer or older than itself', () => {
    expect(pool.filter((a) => get(a, a) === 'older' || get(a, a) === 'newer')).toEqual([]);
  });

  it('is transitive: a <= b and b <= c never gives a > c, and equal versions are interchangeable', () => {
    const bad: string[] = [];
    for (const a of pool)
      for (const b of pool) {
        const ab = get(a, b);
        if (ab === 'incomparable') continue;
        for (const c of pool) {
          const bc = get(b, c);
          const ac = get(a, c);
          if (ab === 'equal' && ac !== bc) bad.push(`${a} = ${b}, but vs ${c}: ${ac} / ${bc}`);
          else if (bc === 'equal' && ac !== ab) bad.push(`${a} ${ab} ${b} = ${c}, but ${a} vs ${c} is ${ac}`);
          else if (ab === bc && ab !== 'equal' && ac !== ab && ac !== 'incomparable') bad.push(`${a} ${ab} ${b} ${bc} ${c}, but ${a} vs ${c} is ${ac}`);
        }
      }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it('explainCompare agrees with compareVersions on every pair', () => {
    const bad = pool.flatMap((a) => pool.filter((b) => explainCompare(a, b).result !== get(a, b)).map((b) => `${a} | ${b}`));
    expect(bad.slice(0, 5)).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { compareVersions } from '../../src/shared/versions.js';

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

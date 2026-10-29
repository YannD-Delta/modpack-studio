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
    ['ABC', 'DEF'],
    ['', '1.0'],
    ['1.0', ''],
    ['${file.jarVersion}', '1.0'],
    ['1.0', '${file.jarVersion}'],
  ])('%s vs %s is incomparable', (a, b) => {
    expect(compareVersions(a, b)).toBe('incomparable');
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { configureLimits, defineLimit, getLimit, listLimits, setLimits, LimitError } from '../../src/server/settings/limits.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-limits-'));
  configureLimits(dir);
});

const prefs = () => JSON.parse(fs.readFileSync(path.join(dir, 'preferences.json'), 'utf8')) as Record<string, unknown>;

defineLimit({ key: 'test.count', kind: 'number', default: 5, min: 1, max: 10, unit: 'count', group: 'test', label: 'Test count' });
defineLimit({ key: 'test.names', kind: 'list', default: ['a', 'b'], maxItems: 3, group: 'test', label: 'Test names' });
defineLimit({ key: 'test.pattern', kind: 'pattern', default: 'foo|bar', group: 'test', label: 'Test pattern' });

describe('limits', () => {
  it('returns the default until something is saved', () => {
    expect(getLimit('test.count')).toBe(5);
    expect(getLimit('test.names')).toEqual(['a', 'b']);
    expect(getLimit('test.pattern')).toBe('foo|bar');
  });

  it('saves a value, keeps the other preference sections, and reads it back after a restart', () => {
    fs.writeFileSync(path.join(dir, 'preferences.json'), JSON.stringify({ packs: { upstream: 'X', own: 'Y' } }));
    setLimits(dir, { 'test.count': 7, 'test.names': ['z'] });
    expect(getLimit('test.count')).toBe(7);
    expect(prefs().packs).toEqual({ upstream: 'X', own: 'Y' });
    configureLimits(dir);
    expect(getLimit('test.count')).toBe(7);
    expect(getLimit('test.names')).toEqual(['z']);
  });

  it('null resets one limit to its default', () => {
    setLimits(dir, { 'test.count': 7 });
    setLimits(dir, { 'test.count': null });
    expect(getLimit('test.count')).toBe(5);
    expect(listLimits().find((l) => l.key === 'test.count')?.overridden).toBe(false);
  });

  it('refuses out-of-range numbers, unknown keys, bad lists and invalid patterns without writing anything', () => {
    expect(() => setLimits(dir, { 'test.count': 99 })).toThrow(LimitError);
    expect(() => setLimits(dir, { 'test.count': 1.5 })).toThrow(LimitError);
    expect(() => setLimits(dir, { 'nope': 1 })).toThrow(LimitError);
    expect(() => setLimits(dir, { 'test.names': ['a', 'b', 'c', 'd'] })).toThrow(LimitError);
    expect(() => setLimits(dir, { 'test.pattern': '(' })).toThrow(LimitError);
    expect(fs.existsSync(path.join(dir, 'preferences.json'))).toBe(false);
  });

  it('ignores damaged values in the file and falls back to the default', () => {
    fs.writeFileSync(path.join(dir, 'preferences.json'), JSON.stringify({ limits: { 'test.count': 'lots', 'test.names': [1], 'test.pattern': '(' } }));
    configureLimits(dir);
    expect(getLimit('test.count')).toBe(5);
    expect(getLimit('test.names')).toEqual(['a', 'b']);
    expect(getLimit('test.pattern')).toBe('foo|bar');
  });
});

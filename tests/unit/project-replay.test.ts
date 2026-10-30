import { describe, expect, it } from 'vitest';
import { classifyFileChange, classifyModChange, sameFile, type Fingerprint } from '../../src/server/projects/replay.js';

const fp = (sha: string, size = 10, sizeOnly = false): Fingerprint => ({ sha256: sha, size, ...(sizeOnly ? { sizeOnly: true } : {}) });

describe('sameFile', () => {
  it('compares hashes, and sizes only when one side was never hashed', () => {
    expect(sameFile(fp('a'), fp('a'))).toBe(true);
    expect(sameFile(fp('a'), fp('b'))).toBe(false);
    expect(sameFile(fp('size:7', 7, true), fp('deadbeef', 7))).toBe(true);
    expect(sameFile(fp('size:7', 7, true), fp('deadbeef', 8))).toBe(false);
  });
});

describe('classifyFileChange (three-way: the base you started from, the base now, your version)', () => {
  const mine = fp('mine');
  const base = fp('base');
  it('replays your edit when the new base did not touch the file', () => {
    expect(classifyFileChange({ mine, base }, fp('base'))).toMatchObject({ status: 'safe', reason: 'base-unchanged' });
  });
  it('has nothing to do when the new base now holds exactly your version', () => {
    expect(classifyFileChange({ mine, base }, fp('mine'))).toMatchObject({ status: 'already', reason: 'same-as-mine' });
  });
  it('flags a conflict when the base changed the file you had edited', () => {
    expect(classifyFileChange({ mine, base }, fp('other'))).toMatchObject({ status: 'conflict', reason: 'base-changed' });
  });
  it('warns when the new base dropped a file you had edited', () => {
    expect(classifyFileChange({ mine, base }, null)).toMatchObject({ status: 'warning', reason: 'base-removed' });
  });
  it('adds a file of yours freely, unless the new base now ships a different file at the same path', () => {
    expect(classifyFileChange({ mine, base: null }, null)).toMatchObject({ status: 'safe', reason: 'new-file' });
    expect(classifyFileChange({ mine, base: null }, fp('mine'))).toMatchObject({ status: 'already' });
    expect(classifyFileChange({ mine, base: null }, fp('theirs'))).toMatchObject({ status: 'conflict', reason: 'base-now-ships-it' });
  });
});

describe('classifyModChange', () => {
  it('add: free unless the new base ships the mod too', () => {
    expect(classifyModChange({ action: 'add', mineVersion: '2.0', baseVersion: null }, null)).toMatchObject({ status: 'safe', reason: 'new-mod' });
    expect(classifyModChange({ action: 'add', mineVersion: '2.0', baseVersion: null }, { version: '2.0' })).toMatchObject({ status: 'already' });
    expect(classifyModChange({ action: 'add', mineVersion: '2.0', baseVersion: null }, { version: '3.0' })).toMatchObject({ status: 'conflict', reason: 'base-now-ships-it' });
  });
  it('update: replays when the base kept its version, conflicts when it moved, warns when it dropped the mod', () => {
    const c = { action: 'update' as const, mineVersion: '2.0', baseVersion: '1.0' };
    expect(classifyModChange(c, { version: '1.0' })).toMatchObject({ status: 'safe', reason: 'base-unchanged' });
    expect(classifyModChange(c, { version: '2.0' })).toMatchObject({ status: 'already' });
    expect(classifyModChange(c, { version: '1.5' })).toMatchObject({ status: 'conflict', reason: 'base-updated' });
    expect(classifyModChange(c, null)).toMatchObject({ status: 'warning', reason: 'base-removed' });
  });
  it('remove: applies while the base still ships the mod, nothing to do once it is gone', () => {
    const c = { action: 'remove' as const, mineVersion: null, baseVersion: '1.0' };
    expect(classifyModChange(c, { version: '1.1' })).toMatchObject({ status: 'safe' });
    expect(classifyModChange(c, null)).toMatchObject({ status: 'already', reason: 'already-gone' });
  });
});

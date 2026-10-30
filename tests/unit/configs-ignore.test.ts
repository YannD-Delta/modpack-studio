import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isIgnoredByUser, matchesPattern } from '../../src/server/configs/ignore.js';
import { scanInstanceTree } from '../../src/server/configs/inventory.js';
import { configureLimits, setLimits } from '../../src/server/settings/limits.js';

describe('matchesPattern', () => {
  it('a plain pattern matches the folder itself and everything below it, at segment boundaries only', () => {
    expect(matchesPattern('kubejs/exported', 'kubejs/exported')).toBe(true);
    expect(matchesPattern('kubejs/exported', 'kubejs/exported/a/b.json')).toBe(true);
    expect(matchesPattern('kubejs/exported', 'kubejs/exported-old/a.json')).toBe(false);
    expect(matchesPattern('kubejs/exported', 'kubejs/server_scripts/a.js')).toBe(false);
  });

  it('* stays inside one folder name, ** crosses folders, and case and slashes do not matter', () => {
    expect(matchesPattern('config/*/cache', 'config/mod/cache/x.dat')).toBe(true);
    expect(matchesPattern('config/*/cache', 'config/a/b/cache/x.dat')).toBe(false);
    expect(matchesPattern('**/cache', 'config/a/b/cache/x.dat')).toBe(true);
    expect(matchesPattern('Config\\Mod\\', 'config/mod/a.toml')).toBe(true);
    expect(matchesPattern('config/*.old', 'config/a.old')).toBe(true);
    expect(matchesPattern('config/*.old', 'config/sub/a.old')).toBe(false);
  });

  it('treats regex characters in a pattern as plain text', () => {
    expect(matchesPattern('config/a+b(1)', 'config/a+b(1)/x')).toBe(true);
    expect(matchesPattern('config/a.b', 'config/axb')).toBe(false);
  });
});

describe('scan with ignored paths', () => {
  let dir: string;
  let data: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ign-inst-'));
    data = fs.mkdtempSync(path.join(os.tmpdir(), 'ign-data-'));
    for (const f of ['config/a.toml', 'kubejs/exported/big.json', 'kubejs/exported/deep/x.json', 'kubejs/server_scripts/s.js']) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), '{}');
    }
    configureLimits(data);
  });
  afterEach(() => {
    configureLimits(fs.mkdtempSync(path.join(os.tmpdir(), 'ign-reset-')));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  });

  it('skips the folders the user banned, and scans everything again once the list is emptied', async () => {
    expect(isIgnoredByUser('kubejs/exported/big.json')).toBe(false);
    setLimits(data, { 'configs.ignoredPaths': ['kubejs/exported'] });
    const inv = await scanInstanceTree({ kind: 'folder', path: dir });
    expect([...inv.files.keys()].sort()).toEqual(['config/a.toml', 'kubejs/server_scripts/s.js']);
    setLimits(data, { 'configs.ignoredPaths': null });
    expect([...(await scanInstanceTree({ kind: 'folder', path: dir })).files.keys()]).toHaveLength(4);
  });
});

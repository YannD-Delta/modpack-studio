import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PathEscapeError, safeResolve } from '../../src/server/fs-safe/safe-path.js';

let tmp: string;
let root: string;
let outside: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-path-'));
  root = path.join(tmp, 'pack root');
  outside = path.join(tmp, 'outside');
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
  fs.symlinkSync(outside, path.join(root, 'link'), 'junction');
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('safeResolve rejects', () => {
  const bad: Record<string, string> = {
    'parent traversal': '..\\x',
    'nested traversal': 'a\\..\\..\\x',
    'drive path': 'C:\\Windows',
    'UNC path': '\\\\host\\share\\f',
    'alternate data stream': 'file.txt:stream',
    'device name': 'CON',
    'device name with extension': 'nul.txt',
    'trailing dot or space': 'name. ',
    'junction escape': 'link\\secret.txt',
  };
  for (const [label, rel] of Object.entries(bad)) {
    it(label, () => {
      expect(() => safeResolve(root, rel)).toThrow(PathEscapeError);
    });
  }
});

describe('safeResolve accepts', () => {
  it('accented names and spaces inside the root', () => {
    const p = safeResolve(root, 'config\\mod é.toml');
    expect(p.toLowerCase().startsWith(path.resolve(root).toLowerCase())).toBe(true);
  });

  it('compares the root case-insensitively', () => {
    const p = safeResolve(root.toUpperCase(), 'config');
    expect(p.toLowerCase()).toBe(path.join(root, 'config').toLowerCase());
  });

  const unc = '\\\\localhost\\C$\\Windows';
  const uncOk = (() => { try { return fs.existsSync(unc); } catch { return false; } })();
  it.skipIf(!uncOk)('children of a UNC root', () => {
    expect(safeResolve(unc, 'System32').toLowerCase()).toBe((unc + '\\System32').toLowerCase());
  });
});

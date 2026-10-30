import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

  // Hermetic: a synthetic UNC root with the two fs calls safeResolve makes stubbed, so nothing reaches SMB, DNS or a real system folder.
  describe('a UNC root (stubbed file system)', () => {
    const unc = '\\\\srv\\share\\pack';
    beforeEach(() => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs.realpathSync, 'native').mockImplementation((p) => String(p));
    });
    afterEach(() => vi.restoreAllMocks());

    it('resolves children below the root, root compared case-insensitively', () => {
      expect(safeResolve(unc, 'config\\mod.toml').toLowerCase()).toBe((unc + '\\config\\mod.toml').toLowerCase());
      expect(safeResolve(unc.toUpperCase(), 'config').toLowerCase()).toBe((unc + '\\config').toLowerCase());
    });

    it('rejects a link whose real path leaves the root', () => {
      vi.mocked(fs.realpathSync.native).mockImplementation((p) => (String(p).endsWith('link') ? '\\\\srv\\share\\other' : String(p)));
      expect(() => safeResolve(unc, 'link')).toThrow(PathEscapeError);
    });
  });

  // Opt-in only: the real admin share is never probed unless the flag is set (the flag is read before any fs call).
  const realUnc = '\\\\localhost\\C$\\Windows';
  const realUncOk = process.env.STUDIO_TEST_REAL_UNC === '1' && (() => { try { return fs.existsSync(realUnc); } catch { return false; } })();
  it.skipIf(!realUncOk)('children of a real UNC root (opt-in)', () => {
    expect(safeResolve(realUnc, 'System32').toLowerCase()).toBe((realUnc + '\\System32').toLowerCase());
  });
});

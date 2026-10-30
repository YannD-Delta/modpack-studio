import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertDemoDir, DEMO_MARKER, DEFAULT_DEMO_DIR } from '../../scripts/seed-demo-guard.js';

const repo = path.resolve(import.meta.dirname, '..', '..');
let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-guard-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('seed-demo guard', () => {
  it('accepts a folder that does not exist yet', () => {
    expect(() => assertDemoDir(path.join(tmp, 'demo'), { repoRoot: repo })).not.toThrow();
  });

  it('accepts a non-empty folder only when it holds the marker written by a previous seed', () => {
    const dir = path.join(tmp, 'demo');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'precious.txt'), 'x');
    expect(() => assertDemoDir(dir, { repoRoot: repo })).toThrow(/marker|demo folder/i);
    fs.writeFileSync(path.join(dir, DEMO_MARKER), '');
    expect(() => assertDemoDir(dir, { repoRoot: repo })).not.toThrow();
  });

  it('refuses an empty argument', () => {
    expect(() => assertDemoDir('', { repoRoot: repo })).toThrow();
  });

  it('refuses a drive root, the home folder, the repo, a parent of the repo and the working directory', () => {
    const root = path.parse(repo).root;
    for (const bad of [root, os.homedir(), repo, path.dirname(repo), process.cwd()]) {
      // even with a marker present, these are never acceptable
      expect(() => assertDemoDir(bad, { repoRoot: repo, homeDir: os.homedir() }), bad).toThrow();
    }
  });

  it('refuses a folder inside the repo sources and tolerates a trailing separator', () => {
    expect(() => assertDemoDir(path.join(repo, 'src'), { repoRoot: repo })).toThrow();
    expect(() => assertDemoDir(path.join(tmp, 'fresh') + path.sep, { repoRoot: repo })).not.toThrow();
  });

  it('defaults to a folder in the OS temp directory', () => {
    expect(DEFAULT_DEMO_DIR.startsWith(os.tmpdir())).toBe(true);
  });
});

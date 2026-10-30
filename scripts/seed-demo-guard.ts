import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Marker file written by seed-demo into the folder it filled; its presence is the only way to re-seed a non-empty folder. */
export const DEMO_MARKER = '.studio-demo';

/** Default output folder of seed-demo: a throwaway place in the OS temp directory, never inside the repo. */
export const DEFAULT_DEMO_DIR = path.join(os.tmpdir(), 'studio-demo');

const norm = (p: string) => path.resolve(p).replace(/[\/]+$/, '').toLowerCase();

/**
 * seed-demo wipes the folder it is given, so it only accepts one that is clearly a demo folder:
 * a folder that does not exist yet, or one holding DEMO_MARKER. A drive root, the home folder, the repo,
 * any parent of the repo, any parent of the working directory and anything inside the repo are always refused.
 * Throws with a readable message; returns the resolved folder otherwise.
 */
export function assertDemoDir(dir: string, opts: { repoRoot: string; homeDir?: string; cwd?: string }): string {
  if (!dir || !dir.trim()) throw new Error('seed-demo: an output folder is required');
  const target = path.resolve(dir);
  const t = norm(target);
  const repo = norm(opts.repoRoot);
  const home = norm(opts.homeDir ?? os.homedir());
  const cwd = norm(opts.cwd ?? process.cwd());
  const isAncestorOrSame = (a: string, b: string) => b === a || b.startsWith(a + path.sep);
  if (t === norm(path.parse(target).root)) throw new Error(`seed-demo: refusing a drive root (${target})`);
  if (t === home) throw new Error(`seed-demo: refusing the home folder (${target})`);
  if (isAncestorOrSame(t, repo)) throw new Error(`seed-demo: refusing the repo or a parent of it (${target})`);
  if (isAncestorOrSame(t, cwd)) throw new Error(`seed-demo: refusing the working directory or a parent of it (${target})`);
  if (isAncestorOrSame(repo, t)) throw new Error(`seed-demo: refusing a folder inside the repo (${target})`);
  if (fs.existsSync(target) && !fs.existsSync(path.join(target, DEMO_MARKER))) {
    throw new Error(`seed-demo: ${target} exists and is not a demo folder (no ${DEMO_MARKER} marker). Pick a new folder name.`);
  }
  return target;
}

import fs from 'node:fs';
import path from 'node:path';
import { DeployError, resolveInside } from './backups.js';

/**
 * NeoForge keeps one folder per installed version under libraries/net/neoforged/neoforge/<version>/ (the server jar and the
 * unix_args.txt / win_args.txt files live inside it). After a NeoForge upgrade the old folder is dead weight: this module
 * names it so the caller can pass it to applyPack as `extraRemovals` (the engine moves it to the backup, it never deletes).
 */

const VERSION_PATTERN = /^[0-9A-Za-z.+_-]{1,40}$/;
export const NEOFORGE_LIBRARY_DIR = 'libraries/net/neoforged/neoforge';
const LAUNCH_FILES = ['run.bat', 'run.sh', 'user_jvm_args.txt'];
const MAX_LAUNCH_FILE_BYTES = 256 * 1024;

/** A version is a plain token that starts with a letter or digit, so it can never be `.` or `..` or name another folder. */
export const isValidNeoForgeVersion = (v: unknown): v is string => typeof v === 'string' && VERSION_PATTERN.test(v) && /^[0-9A-Za-z]/.test(v);

function assertVersion(v: string, what: string): void {
  if (!isValidNeoForgeVersion(v)) throw new DeployError('unsafe_path', `${what} is not a valid NeoForge version: ${JSON.stringify(v)}`);
}

const isDir = (p: string) => {
  try {
    return fs.lstatSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** `@libraries/net/neoforged/neoforge/21.1.1/win_args.txt` inside run.bat, run.sh or user_jvm_args.txt. */
const ARGS_REFERENCE = /libraries[\\/]+net[\\/]+neoforged[\\/]+neoforge[\\/]+([0-9A-Za-z][0-9A-Za-z.+_-]{0,39})[\\/]/gi;

/**
 * The NeoForge version installed in a server folder, or null. First choice: the version the launch files point at
 * (run.bat, run.sh, user_jvm_args.txt), when that version folder exists. Otherwise the only version folder under
 * libraries/net/neoforged/neoforge/. Several folders and no usable launch file means null: the engine never guesses.
 */
export function detectInstalledNeoForge(targetDir: string): string | null {
  const libs = path.join(targetDir, ...NEOFORGE_LIBRARY_DIR.split('/'));
  for (const name of LAUNCH_FILES) {
    const file = path.join(targetDir, name);
    let text: string;
    try {
      if (fs.statSync(file).size > MAX_LAUNCH_FILE_BYTES) continue;
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(ARGS_REFERENCE)) {
      const version = m[1]!;
      if (isValidNeoForgeVersion(version) && isDir(path.join(libs, version))) return version;
    }
  }
  let folders: string[];
  try {
    folders = fs
      .readdirSync(libs, { withFileTypes: true })
      .filter((e) => e.isDirectory() && isValidNeoForgeVersion(e.name))
      .map((e) => e.name);
  } catch {
    return null;
  }
  return folders.length === 1 ? folders[0]! : null;
}

/**
 * Relative paths (forward slashes, from targetDir) to clean after a NeoForge upgrade: the old version folder, and only when
 * the versions differ and that folder really exists. Equal versions or an absent old folder give []. Both versions are
 * validated before any path is built; an invalid one throws unsafe_path. World data, config and mods are never named here.
 */
export function planNeoForgeCleanup(targetDir: string, oldVersion: string, newVersion: string): string[] {
  assertVersion(oldVersion, 'the old version');
  assertVersion(newVersion, 'the new version');
  if (oldVersion === newVersion || !isDir(targetDir)) return [];
  const rel = `${NEOFORGE_LIBRARY_DIR}/${oldVersion}`;
  const abs = resolveInside(targetDir, rel);
  return isDir(abs) ? [rel] : [];
}

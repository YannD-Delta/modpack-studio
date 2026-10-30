import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { safeResolve } from '../fs-safe/safe-path.js';
import { isProcessRunningFrom } from '../profiles/process-check.js';

/**
 * Shared building blocks of the apply engine (apply-engine.ts): the error type, the injectable file layer, the path rules,
 * and the backup folders (list, prune, restore). Nothing here deletes anything except old backup folders (pruneBackups)
 * and the temporary copies the engine itself created.
 */

export type DeployErrorCode =
  | 'pack_invalid' // changes.json missing or unreadable
  | 'pack_corrupt' // a pack file is missing, unlisted or does not match its sha256
  | 'target_not_recognised'
  | 'game_running'
  | 'process_check_failed'
  | 'unsafe_path'
  | 'path_conflict'
  | 'backup_invalid'
  | 'backup_not_found';

export class DeployError extends Error {
  constructor(
    public readonly code: DeployErrorCode,
    message: string,
    public readonly details: string[] = [],
  ) {
    super(message);
    this.name = 'DeployError';
  }
}

export const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ---------- the file layer (injectable so a test can make the Nth write fail) ----------

export interface DeployFs {
  mkdir(dir: string): Promise<void>;
  copyFile(src: string, dest: string): Promise<void>;
  /** Recursive copy of a file or a folder. */
  cp(src: string, dest: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Recursive, no error when absent. */
  rm(target: string): Promise<void>;
  writeFile(file: string, text: string): Promise<void>;
}

export const realFs: DeployFs = {
  mkdir: async (dir) => void (await fsp.mkdir(dir, { recursive: true })),
  copyFile: (src, dest) => fsp.copyFile(src, dest),
  cp: (src, dest) => fsp.cp(src, dest, { recursive: true, force: true, errorOnExist: false }),
  rename: (from, to) => fsp.rename(from, to),
  rm: (target) => fsp.rm(target, { recursive: true, force: true }),
  writeFile: (file, text) => fsp.writeFile(file, text, 'utf8'),
};

// ---------- paths ----------

/** Name of the temporary copy written next to its destination, then renamed over it. */
export const TEMP_SUFFIX = '.studio-tmp';
/** Backup folder entries that are not target files. */
const RESERVED_FIRST_SEGMENTS = new Set(['manifest.json', '_set-aside']);

/** A relative path with forward slashes only: no drive, colon, backslash, NUL, empty, '.' or '..' segment. */
export function isDeployRelative(rel: unknown): rel is string {
  if (typeof rel !== 'string' || !rel || rel.length > 1024) return false;
  if (/[\\:\0]/.test(rel) || rel.startsWith('/')) return false;
  return rel.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

export const isReservedBackupPath = (rel: string) => RESERVED_FIRST_SEGMENTS.has(rel.split('/')[0]!.toLowerCase());

/** Validates `rel` (shape, then containment, symlinks and junctions included) and returns the absolute path inside `root`. */
export function resolveInside(root: string, rel: string): string {
  if (!isDeployRelative(rel)) throw new DeployError('unsafe_path', `unsafe relative path: ${JSON.stringify(rel)}`);
  try {
    return safeResolve(root, rel);
  } catch (err) {
    throw new DeployError('unsafe_path', `${rel}: ${errText(err)}`);
  }
}

export const isInside = (parent: string, child: string) => {
  const rel = path.relative(path.resolve(parent).toLowerCase(), path.resolve(child).toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

export async function lstatOrNull(p: string): Promise<fs.Stats | null> {
  try {
    return await fsp.lstat(p);
  } catch {
    return null;
  }
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/** What a server or instance folder holds: at least one of these must exist before anything is applied or restored. */
export const RECOGNISED_MARKERS = ['mods', 'config', 'libraries', 'run.bat', 'run.sh', 'server.properties', 'user_jvm_args.txt'] as const;

/** Returns the resolved folder, or throws target_not_recognised (not absolute, a drive or share root, not a folder, no marker). */
export function assertRecognisedTarget(targetDir: string): string {
  if (typeof targetDir !== 'string' || !targetDir.trim() || !path.isAbsolute(targetDir)) {
    throw new DeployError('target_not_recognised', 'the target folder must be an absolute path');
  }
  const resolved = path.resolve(targetDir);
  if (path.parse(resolved).root === resolved) throw new DeployError('target_not_recognised', 'the target folder is a drive or share root');
  let st: fs.Stats;
  try {
    st = fs.statSync(resolved);
  } catch {
    throw new DeployError('target_not_recognised', 'the target folder does not exist');
  }
  if (!st.isDirectory()) throw new DeployError('target_not_recognised', 'the target is not a folder');
  if (!RECOGNISED_MARKERS.some((m) => fs.existsSync(path.join(resolved, m)))) {
    throw new DeployError('target_not_recognised', `the target folder holds none of ${RECOGNISED_MARKERS.join(', ')}: this does not look like a server or instance, nothing was changed`);
  }
  return resolved;
}

// ---------- stamps and manifest ----------

const pad = (n: number) => String(n).padStart(2, '0');
/** UTC stamp used as the backup folder name: `YYYYMMDD-HHMMSS`, plus `-N` when two backups share a second. */
export const utcStamp = (d: Date) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
export const STAMP_RE = /^\d{8}-\d{6}(-\d{1,3})?$/;

function stampCompare(a: string, b: string): number {
  const parse = (s: string) => /^(\d{8}-\d{6})(?:-(\d{1,3}))?$/.exec(s)!;
  const [, aBase, aN] = parse(a);
  const [, bBase, bN] = parse(b);
  if (aBase !== bBase) return aBase! < bBase! ? -1 : 1;
  return Number(aN ?? 0) - Number(bN ?? 0);
}

export type BackupStatus = 'in_progress' | 'applied' | 'rolled_back' | 'restored';
export interface BackupManifest {
  format: 1;
  stamp: string;
  createdAt: string;
  packName: string | null;
  status: BackupStatus;
  /** Target files overwritten by the apply (the old content is in the backup). */
  replaced: string[];
  /** Target files or folders moved out (their content is in the backup). */
  removed: string[];
  /** Target files the apply created (nothing to back up; a restore sets them aside). */
  added: string[];
}

const STATUSES: BackupStatus[] = ['in_progress', 'applied', 'rolled_back', 'restored'];
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => isDeployRelative(s));

export function readManifest(backupDir: string): BackupManifest | null {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(backupDir, 'manifest.json'), 'utf8')) as Partial<BackupManifest>;
    if (m.format !== 1 || typeof m.stamp !== 'string' || !STATUSES.includes(m.status as BackupStatus)) return null;
    if (!isStringList(m.replaced) || !isStringList(m.removed) || !isStringList(m.added)) return null;
    return { format: 1, stamp: m.stamp, createdAt: String(m.createdAt ?? ''), packName: typeof m.packName === 'string' ? m.packName : null, status: m.status as BackupStatus, replaced: m.replaced, removed: m.removed, added: m.added };
  } catch {
    return null;
  }
}

export async function writeManifest(fsl: DeployFs, backupDir: string, manifest: BackupManifest): Promise<void> {
  await fsl.writeFile(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

// ---------- undo (shared by a failed apply and restoreBackup) ----------

async function sameFile(a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([lstatOrNull(a), lstatOrNull(b)]);
  if (!sa?.isFile() || !sb?.isFile() || sa.size !== sb.size) return false;
  return (await sha256File(a)) === (await sha256File(b));
}

/** Moves `from` out of the way to `to` (rename, or copy then remove across volumes). `to` is inside a backup folder. */
async function moveAside(fsl: DeployFs, from: string, to: string): Promise<void> {
  await fsl.mkdir(path.dirname(to));
  await fsl.rm(to);
  try {
    await fsl.rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await fsl.cp(from, to);
    await fsl.rm(from);
  }
}

async function copyBack(fsl: DeployFs, src: string, dest: string): Promise<void> {
  await fsl.mkdir(path.dirname(dest));
  if ((await lstatOrNull(src))?.isDirectory()) {
    await fsl.cp(src, dest);
    return;
  }
  const tmp = dest + TEMP_SUFFIX;
  try {
    await fsl.copyFile(src, tmp);
    await fsl.rename(tmp, dest);
  } catch (err) {
    await fsl.rm(tmp).catch(() => undefined);
    throw err;
  }
}

export interface UndoInput {
  fs: DeployFs;
  backupDir: string;
  targetDir: string;
  added: string[];
  replaced: string[];
  removed: string[];
}
export interface UndoReport {
  /** Target paths put back from the backup. */
  restored: string[];
  /** Target paths that were in the way (added or replaced by the apply) and now sit in `<backup>/_set-aside/`. */
  setAside: string[];
  errors: string[];
}

/**
 * Puts the target back as the backup recorded it. Files the apply added or replaced are SET ASIDE inside the backup
 * folder (not deleted), then the old content is copied back; the backup stays complete, so it can be restored again.
 * Every path is checked again (the manifest is read from disk). A failure on one path is reported and does not stop the others.
 */
export async function undoChanges(input: UndoInput): Promise<UndoReport> {
  const { fs: fsl, backupDir, targetDir } = input;
  const report: UndoReport = { restored: [], setAside: [], errors: [] };
  const step = async (rel: string, work: () => Promise<void>) => {
    try {
      await work();
    } catch (err) {
      report.errors.push(`${rel}: ${errText(err)}`);
    }
  };
  const aside = async (rel: string, dest: string) => {
    await moveAside(fsl, dest, resolveInside(backupDir, `_set-aside/${rel}`));
    report.setAside.push(rel);
  };
  for (const rel of input.added) {
    await step(rel, async () => {
      const dest = resolveInside(targetDir, rel);
      if (await lstatOrNull(dest)) await aside(rel, dest);
    });
  }
  for (const rel of [...input.replaced, ...input.removed]) {
    await step(rel, async () => {
      const dest = resolveInside(targetDir, rel);
      const src = resolveInside(backupDir, rel);
      if (!(await lstatOrNull(src))) throw new Error('missing from the backup');
      if (await lstatOrNull(dest)) {
        if (await sameFile(src, dest)) {
          report.restored.push(rel);
          return;
        }
        await aside(rel, dest);
      }
      await copyBack(fsl, src, dest);
      report.restored.push(rel);
    });
  }
  return report;
}

// ---------- listing, pruning, restoring ----------

export interface BackupInfo {
  stamp: string;
  dir: string;
  createdAt: string | null;
  /** 'unknown' when manifest.json is missing or unreadable. */
  status: BackupStatus | 'unknown';
  packName: string | null;
  replaced: number;
  removed: number;
  added: number;
}

/** The backup folders directly under `backupRoot` (names matching the stamp pattern only), newest first. */
export function listBackups(backupRoot: string): BackupInfo[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(backupRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && STAMP_RE.test(e.name))
    .sort((a, b) => stampCompare(b.name, a.name))
    .map((e) => {
      const dir = path.join(backupRoot, e.name);
      const m = readManifest(dir);
      return { stamp: e.name, dir, createdAt: m?.createdAt || null, status: m?.status ?? 'unknown', packName: m?.packName ?? null, replaced: m?.replaced.length ?? 0, removed: m?.removed.length ?? 0, added: m?.added.length ?? 0 };
    });
}

/**
 * Deletes old backup folders, the only deletion the deploy code does besides its own temporary copies.
 * Folders whose manifest says `rolled_back` hold nothing and always go; of the others the newest `keep` stay.
 * Only direct children whose name matches the stamp pattern are ever touched. Returns the removed stamps.
 */
export function pruneBackups(backupRoot: string, keep: number): string[] {
  if (!Number.isInteger(keep) || keep < 1) throw new RangeError('keep must be a whole number of at least 1');
  const removed: string[] = [];
  let kept = 0;
  for (const b of listBackups(backupRoot)) {
    if (b.status !== 'rolled_back' && kept < keep) {
      kept++;
      continue;
    }
    if (!STAMP_RE.test(b.stamp) || path.dirname(b.dir) !== backupRoot) continue;
    fs.rmSync(b.dir, { recursive: true, force: true });
    removed.push(b.stamp);
  }
  return removed;
}

export interface RestoreOptions {
  /** Defaults to isProcessRunningFrom. */
  isRunning?: (dir: string) => boolean | Promise<boolean>;
  fs?: Partial<DeployFs>;
}
export interface RestoreResult {
  stamp: string;
  restored: string[];
  setAside: string[];
  errors: string[];
  /** false when some path could not be restored: the backup is kept and the manifest is not marked restored. */
  complete: boolean;
}

/** Puts every backed-up file back into `targetDir` and sets aside the files the apply had added (see undoChanges). */
export async function restoreBackup(backupRoot: string, stamp: string, targetDir: string, opts: RestoreOptions = {}): Promise<RestoreResult> {
  if (!STAMP_RE.test(stamp)) throw new DeployError('backup_not_found', `not a backup stamp: ${JSON.stringify(stamp)}`);
  const root = path.resolve(backupRoot);
  const backupDir = path.join(root, stamp);
  const st = await lstatOrNull(backupDir);
  if (!st?.isDirectory()) throw new DeployError('backup_not_found', `no backup ${stamp}`);
  const manifest = readManifest(backupDir);
  if (!manifest) throw new DeployError('backup_invalid', `backup ${stamp} has no readable manifest.json`);
  const target = assertRecognisedTarget(targetDir);
  if (isInside(backupDir, target)) throw new DeployError('backup_invalid', 'the target is inside the backup folder');
  let running: boolean;
  try {
    running = await (opts.isRunning ?? isProcessRunningFrom)(target);
  } catch (err) {
    throw new DeployError('process_check_failed', `cannot tell whether the game runs (${errText(err)}): close it and retry`);
  }
  if (running) throw new DeployError('game_running', `the game runs from ${target}: close it first, nothing was changed`);

  const fsl: DeployFs = { ...realFs, ...opts.fs };
  const report = await undoChanges({ fs: fsl, backupDir, targetDir: target, added: manifest.added, replaced: manifest.replaced, removed: manifest.removed });
  const complete = report.errors.length === 0;
  if (complete) await writeManifest(fsl, backupDir, { ...manifest, status: 'restored' });
  return { stamp, restored: report.restored, setAside: report.setAside, errors: report.errors, complete };
}

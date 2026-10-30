import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { isProcessRunningFrom } from '../profiles/process-check.js';
import { defineLimit, getNumberLimit } from '../settings/limits.js';
import {
  DeployError,
  TEMP_SUFFIX,
  assertRecognisedTarget,
  errText,
  isDeployRelative,
  isInside,
  isReservedBackupPath,
  lstatOrNull,
  pruneBackups,
  realFs,
  resolveInside,
  sha256File,
  STAMP_RE,
  undoChanges,
  utcStamp,
  writeManifest,
  type BackupManifest,
  type DeployFs,
} from './backups.js';

export { DeployError as ApplyError } from './backups.js';
export type { DeployErrorCode as ApplyErrorCode } from './backups.js';

/**
 * Studio's own apply engine: applies an update pack (the folder `buildUpdatePack` writes) to a server or instance folder,
 * with the same safety model as the generated apply.ps1 (dry run by default, sha256 of every pack file checked before anything
 * moves, replaced and removed files backed up, rollback when something fails, refuses while the game runs).
 * apply.ps1 is untouched and stays the way to apply a pack on a machine without Studio.
 */

export const KEEP_BACKUPS_LIMIT = defineLimit({ key: 'deploy.keepBackups', kind: 'number', default: 2, min: 1, max: 20, unit: 'count', group: 'deploy', label: 'Deploy backups kept' });

export type PlanKind = 'add' | 'replace' | 'remove' | 'cleanup' | 'absent';
export interface PlanOp {
  /** add: new file; replace: existing file overwritten (old content backed up); remove: jar from remove.txt moved to the backup; cleanup: extraRemovals entry moved to the backup; absent: named for removal but not there. */
  kind: PlanKind;
  /** Path relative to the target, forward slashes. */
  path: string;
  /** add and replace: where the new content comes from in the pack (`mods-add/x.jar`, `files-add/config/y.toml`). */
  source?: string;
  sha256?: string;
  size?: number;
}

export type ApplyStatus = 'dry_run' | 'applied' | 'rolled_back' | 'rollback_incomplete';
export interface ApplyResult {
  status: ApplyStatus;
  packName: string;
  plan: PlanOp[];
  counts: Record<PlanKind, number>;
  /** null when the check was not done or failed (dry run only: an apply refuses instead). */
  gameRunning: boolean | null;
  /** null for a dry run. */
  backup: { stamp: string; dir: string } | null;
  /** Stamps of the old backups deleted after a successful apply. */
  prunedBackups: string[];
  /** rolled_back and rollback_incomplete: why the apply stopped. */
  cause?: string;
  /** rollback_incomplete: paths that could not be put back, with the reason. The backup folder holds the originals. */
  rollbackErrors?: string[];
}

export interface ApplyOptions {
  packDir: string;
  targetDir: string;
  /** Default true: plan and verify, change nothing. */
  dryRun?: boolean;
  backupRoot: string;
  /** Default: the `deploy.keepBackups` limit. 1 to 20. */
  keepBackups?: number;
  /** Default isProcessRunningFrom. Only consulted for an apply, plus informationally in a dry run. */
  isRunning?: (dir: string) => boolean | Promise<boolean>;
  now?: Date | (() => Date);
  /** Extra target-relative paths to move to the backup (files or folders, at least two segments deep), e.g. an old NeoForge folder. */
  extraRemovals?: string[];
  log?: (message: string) => void;
  /** Replaces parts of the write layer (tests make the Nth write fail). */
  fs?: Partial<DeployFs>;
}

// ---------- reading and verifying the pack ----------

interface PackWrite {
  rel: string;
  src: string;
  source: string;
  sha256: string;
  size: number;
}
interface Pack {
  name: string;
  writes: PackWrite[];
  removeNames: string[];
}

const SHA_RE = /^[0-9a-f]{64}$/i;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

async function listPackFiles(root: string, rel = ''): Promise<{ rel: string; regular: boolean }[]> {
  const out: { rel: string; regular: boolean }[] = [];
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listPackFiles(root, r)));
    else out.push({ rel: r, regular: e.isFile() });
  }
  return out;
}

/** Reads changes.json and remove.txt and checks every pack file BEFORE anything else happens. Throws pack_invalid, unsafe_path or pack_corrupt. */
async function readAndVerifyPack(packDir: string): Promise<Pack> {
  let changes: unknown;
  try {
    changes = JSON.parse((await fsp.readFile(path.join(packDir, 'changes.json'), 'utf8')).replace(/^﻿/, ''));
  } catch (err) {
    throw new DeployError('pack_invalid', `changes.json is missing or unreadable in the pack folder (${errText(err)})`);
  }
  if (!isRecord(changes)) throw new DeployError('pack_invalid', 'changes.json is not an object');
  const name = typeof changes.name === 'string' && changes.name ? changes.name : path.basename(packDir);
  const asList = (v: unknown) => (Array.isArray(v) ? v : []);

  const unsafe: string[] = [];
  const problems: string[] = [];
  const writes: PackWrite[] = [];
  const listed = new Set<string>();
  const seenDest = new Set<string>();

  const entries: { dir: 'mods-add' | 'files-add'; raw: unknown }[] = [
    ...asList(changes.jars).map((raw) => ({ dir: 'mods-add' as const, raw })),
    ...asList(changes.files).map((raw) => ({ dir: 'files-add' as const, raw })),
  ];
  for (const { dir, raw } of entries) {
    const key = dir === 'mods-add' ? 'file' : 'path';
    const rel = isRecord(raw) ? raw[key] : undefined;
    const sha = isRecord(raw) ? raw.sha256 : undefined;
    if (!isDeployRelative(rel) || (dir === 'mods-add' && rel.includes('/')) || isReservedBackupPath(dir === 'mods-add' ? `mods/${rel}` : rel)) {
      unsafe.push(`unsafe ${key} in changes.json: ${JSON.stringify(rel)}`);
      continue;
    }
    const source = `${dir}/${rel}`;
    listed.add(source);
    if (typeof sha !== 'string' || !SHA_RE.test(sha)) {
      problems.push(`no valid sha256 in changes.json for ${source}`);
      continue;
    }
    const dest = dir === 'mods-add' ? `mods/${rel}` : rel;
    if (seenDest.has(dest.toLowerCase())) {
      problems.push(`listed twice in changes.json: ${dest}`);
      continue;
    }
    seenDest.add(dest.toLowerCase());
    const src = path.join(packDir, dir, ...rel.split('/'));
    const st = await lstatOrNull(src);
    if (!st?.isFile()) {
      problems.push(`missing from the pack (or not a regular file): ${source}`);
      continue;
    }
    const declaredSize = isRecord(raw) && typeof raw.size === 'number' ? raw.size : null;
    if (declaredSize !== null && declaredSize !== st.size) {
      problems.push(`size mismatch: ${source}`);
      continue;
    }
    if ((await sha256File(src)) !== sha.toLowerCase()) {
      problems.push(`sha256 mismatch: ${source}`);
      continue;
    }
    writes.push({ rel: dest, src, source, sha256: sha.toLowerCase(), size: st.size });
  }
  for (const dir of ['mods-add', 'files-add']) {
    for (const f of await listPackFiles(path.join(packDir, dir))) {
      const source = `${dir}/${f.rel}`;
      if (!f.regular) problems.push(`not a regular file: ${source}`);
      else if (!listed.has(source)) problems.push(`file not listed in changes.json: ${source}`);
    }
  }

  const removeNames: string[] = [];
  let removeText = '';
  try {
    removeText = await fsp.readFile(path.join(packDir, 'remove.txt'), 'utf8');
  } catch {
    // no remove.txt: nothing to remove
  }
  for (const line of removeText.replace(/^﻿/, '').split(/\r?\n/)) {
    const n = line.trim();
    if (!n) continue;
    if (!isDeployRelative(n) || n.includes('/') || isReservedBackupPath(`mods/${n}`)) unsafe.push(`unsafe name in remove.txt: ${n}`);
    else removeNames.push(n);
  }

  if (unsafe.length) throw new DeployError('unsafe_path', `the pack names a path outside the target: nothing was changed`, unsafe);
  if (problems.length) throw new DeployError('pack_corrupt', 'the pack does not match changes.json (sha256 check or missing files): nothing was changed', problems);
  return { name, writes, removeNames };
}

// ---------- planning ----------

interface Op extends PlanOp {
  abs: string;
  src?: string;
  isDir?: boolean;
}

async function planOperations(pack: Pack, target: string, backupRoot: string, extraRemovals: string[]): Promise<Op[]> {
  const ops = new Map<string, Op>();
  const keyOf = (rel: string) => rel.toLowerCase();

  for (const n of pack.removeNames) {
    const rel = `mods/${n}`;
    const abs = resolveInside(target, rel);
    const st = await lstatOrNull(abs);
    if (!st) ops.set(keyOf(rel), { kind: 'absent', path: rel, abs });
    else if (st.isFile()) ops.set(keyOf(rel), { kind: 'remove', path: rel, abs, size: st.size });
    else throw new DeployError('path_conflict', `remove.txt names ${rel}, which is not a regular file`);
  }

  for (const rel of extraRemovals) {
    if (!isDeployRelative(rel) || rel.split('/').length < 2 || isReservedBackupPath(rel)) {
      throw new DeployError('unsafe_path', `extraRemovals entry refused (must be a relative path of at least two segments): ${JSON.stringify(rel)}`);
    }
    const abs = resolveInside(target, rel);
    if (isInside(abs, backupRoot)) throw new DeployError('path_conflict', `${rel} contains the backup folder`);
    const st = await lstatOrNull(abs);
    if (!st) {
      if (!ops.has(keyOf(rel))) ops.set(keyOf(rel), { kind: 'absent', path: rel, abs });
    } else if (st.isSymbolicLink()) {
      throw new DeployError('path_conflict', `${rel} is a link: refusing to move it`);
    } else {
      ops.set(keyOf(rel), { kind: 'cleanup', path: rel, abs, isDir: st.isDirectory(), ...(st.isFile() ? { size: st.size } : {}) });
    }
  }

  for (const w of pack.writes) {
    const abs = resolveInside(target, w.rel);
    const st = await lstatOrNull(abs);
    if (st && !st.isFile()) throw new DeployError('path_conflict', `a folder or link is in the way of ${w.rel}: nothing was changed`);
    const prior = ops.get(keyOf(w.rel));
    if (prior?.kind === 'cleanup') throw new DeployError('path_conflict', `${w.rel} is both written by the pack and cleaned up`);
    ops.set(keyOf(w.rel), { kind: st ? 'replace' : 'add', path: w.rel, abs, src: w.src, source: w.source, sha256: w.sha256, size: w.size });
  }

  const all = [...ops.values()];
  for (const dir of all.filter((o) => o.kind === 'cleanup' && o.isDir)) {
    const prefix = `${dir.path.toLowerCase()}/`;
    const hit = all.find((o) => o !== dir && o.path.toLowerCase().startsWith(prefix));
    if (hit) throw new DeployError('path_conflict', `${hit.path} is inside the cleaned-up folder ${dir.path}`);
  }
  return all;
}

const countOps = (ops: PlanOp[]): Record<PlanKind, number> => {
  const c: Record<PlanKind, number> = { add: 0, replace: 0, remove: 0, cleanup: 0, absent: 0 };
  for (const o of ops) c[o.kind]++;
  return c;
};
const publicOp = ({ kind, path: p, source, sha256, size }: Op): PlanOp => ({ kind, path: p, ...(source ? { source } : {}), ...(sha256 ? { sha256 } : {}), ...(size !== undefined ? { size } : {}) });

// ---------- applying ----------

/**
 * Applies the pack in `packDir` to `targetDir`, or plans it (dryRun, the default).
 *
 * Order: target recognised, pack verified (sha256 of every file, nothing else touched), plan, game-running check (apply only),
 * backup of everything about to be replaced or removed into `<backupRoot>/<UTC stamp>/`, removals, then writes (temp copy,
 * sha256 check, rename). Any failure restores what was already done from the backup and returns `rolled_back`.
 * Refusals (nothing changed) throw an ApplyError with a `code`: pack_invalid, pack_corrupt, target_not_recognised, game_running,
 * process_check_failed, unsafe_path, path_conflict, backup_invalid.
 */
export async function applyPack(opts: ApplyOptions): Promise<ApplyResult> {
  const log = opts.log ?? (() => undefined);
  const dryRun = opts.dryRun ?? true;
  const keep = opts.keepBackups ?? getNumberLimit(KEEP_BACKUPS_LIMIT);
  if (!Number.isInteger(keep) || keep < 1 || keep > 20) throw new RangeError('keepBackups must be a whole number from 1 to 20');
  const fsl: DeployFs = { ...realFs, ...opts.fs };

  const target = assertRecognisedTarget(opts.targetDir);
  const packDir = path.resolve(opts.packDir);
  const backupRoot = path.resolve(opts.backupRoot);
  if (!path.isAbsolute(opts.backupRoot) || isInside(backupRoot, target)) throw new DeployError('backup_invalid', 'backupRoot must be an absolute path that does not contain the target');

  log(`verifying the pack ${packDir}`);
  const pack = await readAndVerifyPack(packDir);
  log(`sha256 check: ${pack.writes.length} file(s) match changes.json`);
  const ops = await planOperations(pack, target, backupRoot, opts.extraRemovals ?? []);
  const plan = ops.map(publicOp);
  const counts = countOps(plan);

  let gameRunning: boolean | null = null;
  try {
    gameRunning = Boolean(await (opts.isRunning ?? isProcessRunningFrom)(target));
  } catch (err) {
    if (!dryRun) throw new DeployError('process_check_failed', `cannot tell whether the game runs (${errText(err)}): close it and retry, nothing was changed`);
    log(`could not check whether the game runs: ${errText(err)}`);
  }
  if (!dryRun && gameRunning) throw new DeployError('game_running', `the game runs from ${target}: close it first, nothing was changed`);

  const base = { packName: pack.name, plan, counts, gameRunning, prunedBackups: [] as string[] };
  if (dryRun) {
    log(`dry run: ${counts.add} add, ${counts.replace} replace, ${counts.remove + counts.cleanup} to the backup, ${counts.absent} already absent`);
    return { ...base, status: 'dry_run', backup: null };
  }

  // 1. The backup folder and its manifest (written first, so a crash leaves a restorable record).
  const now = typeof opts.now === 'function' ? opts.now() : (opts.now ?? new Date());
  await fsl.mkdir(backupRoot);
  const baseStamp = utcStamp(now);
  let stamp = baseStamp;
  for (let n = 2; fs.existsSync(path.join(backupRoot, stamp)); n++) {
    if (n > 999) throw new DeployError('backup_invalid', 'too many backups in the same second');
    stamp = `${baseStamp}-${n}`;
  }
  if (!STAMP_RE.test(stamp)) throw new DeployError('backup_invalid', 'cannot build a backup stamp');
  const backupDir = path.join(backupRoot, stamp);
  await fsl.mkdir(backupDir);
  const manifest: BackupManifest = {
    format: 1,
    stamp,
    createdAt: now.toISOString(),
    packName: pack.name,
    status: 'in_progress',
    replaced: ops.filter((o) => o.kind === 'replace').map((o) => o.path),
    removed: ops.filter((o) => o.kind === 'remove' || o.kind === 'cleanup').map((o) => o.path),
    added: ops.filter((o) => o.kind === 'add').map((o) => o.path),
  };
  await writeManifest(fsl, backupDir, manifest);

  const done = { added: [] as string[], replaced: [] as string[], removed: [] as string[] };
  let currentTmp: string | null = null;
  try {
    // 2. Back up everything about to be replaced or removed, before touching any of it.
    for (const op of ops.filter((o) => o.kind === 'replace' || o.kind === 'remove' || o.kind === 'cleanup')) {
      const dst = resolveInside(backupDir, op.path);
      log(`backup ${op.path}`);
      if (op.isDir) {
        await fsl.cp(op.abs, dst);
      } else {
        await fsl.mkdir(path.dirname(dst));
        await fsl.copyFile(op.abs, dst);
        const [a, b] = await Promise.all([fsp.stat(op.abs), fsp.stat(dst)]);
        if (a.size !== b.size) throw new Error(`backup copy of ${op.path} is incomplete`);
      }
    }
    // 3. Removals: the complete copy is in the backup, the original leaves the target.
    for (const op of ops.filter((o) => o.kind === 'remove' || o.kind === 'cleanup')) {
      log(`move to backup ${op.path}`);
      done.removed.push(op.path); // journaled first: a half-done removal is undone too
      await fsl.rm(op.abs);
    }
    // 4. Writes: temp copy next to the destination, sha256 of the copy, rename over the destination.
    for (const op of ops.filter((o) => o.kind === 'add' || o.kind === 'replace')) {
      log(`${op.kind} ${op.path}`);
      const tmp = op.abs + TEMP_SUFFIX;
      currentTmp = tmp;
      await fsl.mkdir(path.dirname(op.abs));
      await fsl.copyFile(op.src!, tmp);
      if ((await sha256File(tmp)) !== op.sha256) throw new Error(`the copy of ${op.path} does not match its sha256`);
      await fsl.rename(tmp, op.abs);
      currentTmp = null;
      (op.kind === 'add' ? done.added : done.replaced).push(op.path);
    }
  } catch (err) {
    const cause = errText(err);
    log(`failed: ${cause}; rolling back`);
    if (currentTmp) await fsl.rm(currentTmp).catch(() => undefined);
    const report = await undoChanges({ fs: fsl, backupDir, targetDir: target, ...done });
    const clean = report.errors.length === 0;
    await writeManifest(realFs, backupDir, { ...manifest, status: clean ? 'rolled_back' : 'in_progress' }).catch(() => undefined);
    log(clean ? 'rolled back: the target is as before' : `rollback incomplete: ${report.errors.join('; ')}`);
    return { ...base, status: clean ? 'rolled_back' : 'rollback_incomplete', backup: { stamp, dir: backupDir }, cause, ...(clean ? {} : { rollbackErrors: report.errors }) };
  }

  await writeManifest(fsl, backupDir, { ...manifest, status: 'applied' });
  let prunedBackups: string[] = [];
  try {
    prunedBackups = pruneBackups(backupRoot, keep);
  } catch (err) {
    log(`could not prune old backups: ${errText(err)}`);
  }
  log(`done: backup ${stamp}, ${prunedBackups.length} old backup(s) deleted`);
  return { ...base, status: 'applied', backup: { stamp, dir: backupDir }, prunedBackups };
}

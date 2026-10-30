import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';
import type { Db } from '../db/open.js';
import { safeResolve } from '../fs-safe/safe-path.js';
import { APPLY_PS1 } from '../plan/apply-script.js';
import { actionableMods, isSafePlanFileKey, type ModPlanAction } from '../plan/plan-keys.js';
import { getPlanItems } from '../plan/plan-store.js';
import type { Profile } from '../profiles/profile-service.js';
import { READ_ONLY_ZIP_LIMITS, openZip, type ZipHandle } from '../zip/zip-reader.js';
import { getPins } from './blacklist-service.js';
import { diffModSets, type ModEntry } from './diff.js';
import { findDuplicateIds, loadModSet } from './modset-store.js';

/** Config files are small: anything bigger than this is refused rather than copied blindly. */
export const MAX_PLAN_FILE_BYTES = 64 * 1024 * 1024;
const MODS_JAR = /(^|\/)mods\/[^/]+\.jar$/i;

export const sha256Hex = (buf: Buffer) => crypto.createHash('sha256').update(buf).digest('hex');
export const profileTitle = (p: Pick<Profile, 'pack' | 'version' | 'side' | 'state'>) => `${p.pack} ${p.version} (${p.side}, ${p.state})`;

// ---------- reading the reference profile (folder or server-pack zip) ----------

export type SourceRead = { ok: true; where: string; data: Buffer } | { ok: false; where: string | null; reason: string };

export interface SourceReader {
  /** A top-level jar by file name: `<location>/mods/<file>` (or `<location>/<file>` when there is no mods/), or a zip entry under mods/. */
  jar(file: string): Promise<SourceRead>;
  /** The jars the location really holds (file name and size), without reading them. */
  list(): Promise<{ file: string; size: number }[]>;
  /** A file by instance-relative path (`config/x.toml`); in a zip, an optional single top-level folder is tried too. */
  file(rel: string): Promise<SourceRead>;
  close(): Promise<void>;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const isPlainFileName = (f: string) => !!f && !/[\\/]/.test(f) && f !== '.' && f !== '..';

function folderReader(location: string): SourceReader {
  // Same rule as the import (listFolderJars): jars sit in <location>/mods when it exists, else directly in <location>.
  const modsDir = fs.existsSync(path.join(location, 'mods')) ? path.join(location, 'mods') : location;
  const readUnder = async (root: string, rel: string, maxBytes: number): Promise<SourceRead> => {
    let full: string;
    try {
      full = safeResolve(root, rel);
    } catch (err) {
      return { ok: false, where: null, reason: `unsafe path: ${errText(err)}` };
    }
    let st: fs.Stats;
    try {
      st = await fsp.stat(full);
    } catch {
      return { ok: false, where: full, reason: `not found: ${full}` };
    }
    if (!st.isFile()) return { ok: false, where: full, reason: `not a file: ${full}` };
    if (st.size > maxBytes) return { ok: false, where: full, reason: `too big (${st.size} bytes, limit ${maxBytes})` };
    try {
      return { ok: true, where: full, data: await fsp.readFile(full) };
    } catch (err) {
      return { ok: false, where: full, reason: `cannot read ${full}: ${errText(err)}` };
    }
  };
  return {
    jar: (file) => (isPlainFileName(file) ? readUnder(modsDir, file, Number.MAX_SAFE_INTEGER) : Promise.resolve({ ok: false, where: null, reason: `not a plain jar file name: ${file}` })),
    file: (rel) => readUnder(location, rel, MAX_PLAN_FILE_BYTES),
    async list() {
      const out: { file: string; size: number }[] = [];
      try {
        for (const e of await fsp.readdir(modsDir, { withFileTypes: true })) {
          if (!e.isFile() || !e.name.toLowerCase().endsWith('.jar')) continue;
          out.push({ file: e.name, size: (await fsp.stat(path.join(modsDir, e.name))).size });
        }
      } catch {
        // unreadable folder: nothing to list
      }
      return out;
    },
    close: async () => undefined,
  };
}

async function zipReader(zipPath: string): Promise<SourceReader> {
  let zip: ZipHandle;
  try {
    zip = await openZip(zipPath, READ_ONLY_ZIP_LIMITS);
  } catch (err) {
    const reason = `cannot open the zip ${zipPath}: ${errText(err)}`;
    return { jar: async () => ({ ok: false, where: zipPath, reason }), file: async () => ({ ok: false, where: zipPath, reason }), list: async () => [], close: async () => undefined };
  }
  const entries = zip.entries();
  const names = new Set(entries.map((e) => e.name));
  const sizes = new Map(entries.map((e) => [e.name, e.size]));
  const tops = new Set(entries.map((e) => (e.name.includes('/') ? e.name.split('/')[0]! : '')));
  const prefix = tops.size === 1 && !tops.has('') ? `${[...tops][0]}/` : '';
  const jars = entries.filter((e) => MODS_JAR.test(e.name));
  const where = (entry: string) => `${zipPath}!/${entry}`;
  const readEntry = async (entry: string, maxBytes: number): Promise<SourceRead> => {
    const size = sizes.get(entry) ?? 0;
    if (size > maxBytes) return { ok: false, where: where(entry), reason: `too big (${size} bytes, limit ${maxBytes})` };
    try {
      return { ok: true, where: where(entry), data: await zip.read(entry) };
    } catch (err) {
      return { ok: false, where: where(entry), reason: `cannot read ${where(entry)}: ${errText(err)}` };
    }
  };
  return {
    async jar(file) {
      const hit = jars.find((e) => e.name.split('/').pop() === file) ?? jars.find((e) => e.name.split('/').pop()!.toLowerCase() === file.toLowerCase());
      if (!hit) return { ok: false, where: null, reason: `not found: no mods/${file} in ${zipPath}` };
      return readEntry(hit.name, Number.MAX_SAFE_INTEGER);
    },
    async file(rel) {
      if (!isSafePlanFileKey(rel)) return { ok: false, where: null, reason: `unsafe path: ${rel}` };
      const entry = names.has(rel) ? rel : prefix && names.has(prefix + rel) ? prefix + rel : null;
      if (!entry) return { ok: false, where: null, reason: `not found: no ${rel} in ${zipPath}` };
      return readEntry(entry, MAX_PLAN_FILE_BYTES);
    },
    list: async () => jars.map((e) => ({ file: e.name.split('/').pop()!, size: e.size })),
    close: () => zip.close(),
  };
}

export async function openSource(profile: Pick<Profile, 'locationKind' | 'location'>): Promise<SourceReader> {
  if (profile.locationKind === 'zip') return zipReader(profile.location);
  if (profile.locationKind === 'folder' || profile.locationKind === 'smb') return folderReader(profile.location);
  const reason = `location kind ${profile.locationKind} cannot be read by Studio`;
  return { jar: async () => ({ ok: false, where: null, reason }), file: async () => ({ ok: false, where: null, reason }), list: async () => [], close: async () => undefined };
}

/** How a jar known to the database was found in a location: its own name, another name, or not at all. */
export type JarLocation = { name: string; state: 'exact' | 'renamed' | 'missing' | 'unlisted' };

/**
 * Finds the file name a location REALLY has for a jar the database knows by `dbName`. The database keeps one file name per
 * sha256, so identical bytes held under another name (a copy, a rename by the player) are matched by size, then by content.
 * 'unlisted' = the location cannot be listed, so nothing was verified.
 */
export function makeJarLocator(reader: SourceReader): (dbName: string, sha256?: string, size?: number) => Promise<JarLocation> {
  let listing: Promise<{ file: string; size: number }[]> | null = null;
  return async (dbName, sha256, size) => {
    listing ??= reader.list();
    const all = await listing;
    if (all.length === 0) return { name: dbName, state: 'unlisted' };
    const exact = all.find((j) => j.file === dbName) ?? all.find((j) => j.file.toLowerCase() === dbName.toLowerCase());
    if (exact) return { name: exact.file, state: 'exact' };
    if (sha256) {
      for (const c of all.filter((j) => size === undefined || j.size === size)) {
        const read = await reader.jar(c.file);
        if (read.ok && sha256Hex(read.data) === sha256) return { name: c.file, state: 'renamed' };
      }
    }
    return { name: dbName, state: 'missing' };
  };
}

// ---------- the update pack ----------

export type ExportFailure = { kind: 'mod' | 'file'; key: string; reason: string };
export type ExportCounts = { modsUpdated: number; modsRestored: number; jarsToRemove: number; files: number; failures: number };
export type ChangesJson = {
  format: 1;
  name: string;
  createdAt: string;
  base: { id: number; label: string };
  other: { id: number; label: string };
  mods: { modId: string; action: ModPlanAction; file: string; sha256: string; size: number; toVersion: string; fromVersion: string | null; replaces: string | null }[];
  jars: { file: string; sha256: string; size: number; modIds: string[] }[];
  remove: { file: string; modIds: string[] }[];
  files: { path: string; sha256: string; size: number }[];
  failures: ExportFailure[];
  warnings: string[];
  counts: ExportCounts;
};
export type ExportResult = {
  name: string;
  folder: string;
  zipPath: string;
  zipBytes: number;
  createdAt: string;
  base: { id: number; label: string };
  other: { id: number; label: string };
  counts: ExportCounts;
  failures: ExportFailure[];
  warnings: string[];
};

const pad = (n: number) => String(n).padStart(2, '0');
export const utcStamp = (d: Date) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;

export const EXPORT_NAME = /^[A-Za-z0-9._-]+$/;

export function exportSafeName(other: Pick<Profile, 'pack' | 'version'>, base: Pick<Profile, 'pack' | 'version'>, now: Date): string {
  const raw = `update-${other.pack}-${other.version}-from-${base.pack}-${base.version}-${utcStamp(now)}`;
  return raw.replace(/[^A-Za-z0-9._-]/g, '_');
}

export const isInside = (parent: string, child: string) => {
  const rel = path.relative(path.resolve(parent).toLowerCase(), path.resolve(child).toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

async function listTree(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fsp.readdir(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listTree(dir, r)));
    else if (e.isFile()) out.push(r);
  }
  return out.sort();
}

export async function writeZip(folder: string, rootName: string, zipPath: string): Promise<void> {
  const zip = new yazl.ZipFile();
  for (const rel of await listTree(folder)) zip.addFile(path.join(folder, ...rel.split('/')), `${rootName}/${rel}`);
  zip.end();
  await pipeline(zip.outputStream, fs.createWriteStream(zipPath));
}

export const mdCell = (s: string | null | undefined) => (s ?? '').replace(/\|/g, '\\|');

function changesMarkdown(c: ChangesJson): string {
  const lines = [`# Update pack ${c.name}`, '', `- Reference (source of the files): ${c.base.label}`, `- Target: ${c.other.label}`, `- Created: ${c.createdAt}`, ''];
  const updates = c.mods.filter((m) => m.action === 'update');
  const restores = c.mods.filter((m) => m.action === 'restore');
  lines.push(`## Mods to update (${updates.length})`, '');
  if (updates.length) {
    lines.push('| Mod | Current version | New version | New jar | Old jar (moved to the backup) |', '| --- | --- | --- | --- | --- |');
    for (const m of updates) lines.push(`| ${mdCell(m.modId)} | ${mdCell(m.fromVersion)} | ${mdCell(m.toVersion)} | ${mdCell(m.file)} | ${mdCell(m.replaces)} |`);
  } else lines.push('None.');
  lines.push('', `## Mods to restore (${restores.length})`, '');
  if (restores.length) {
    lines.push('| Mod | Version | Jar |', '| --- | --- | --- |');
    for (const m of restores) lines.push(`| ${mdCell(m.modId)} | ${mdCell(m.toVersion)} | ${mdCell(m.file)} |`);
  } else lines.push('None.');
  lines.push('', `## Jars moved out of mods/ (remove.txt, ${c.remove.length})`, '');
  if (c.remove.length) {
    lines.push('| Jar | Mods it provides |', '| --- | --- |');
    for (const r of c.remove) lines.push(`| ${mdCell(r.file)} | ${mdCell(r.modIds.join(', '))} |`);
  } else lines.push('None.');
  lines.push('', `## Config and other files (${c.files.length})`, '');
  if (c.files.length) {
    lines.push('| Path | Size | sha256 |', '| --- | --- | --- |');
    for (const f of c.files) lines.push(`| ${mdCell(f.path)} | ${f.size} | ${f.sha256} |`);
  } else lines.push('None.');
  if (c.failures.length) {
    lines.push('', `## Not exported (${c.failures.length})`, '', '| Kind | Item | Reason |', '| --- | --- | --- |');
    for (const f of c.failures) lines.push(`| ${f.kind} | ${mdCell(f.key)} | ${mdCell(f.reason)} |`);
  }
  if (c.warnings.length) {
    lines.push('', '## Warnings', '');
    for (const w of c.warnings) lines.push(`- ${w}`);
  }
  lines.push(
    '',
    '## How to apply',
    '',
    '1. Close the game.',
    '2. Dry run, changes nothing: `powershell -ExecutionPolicy Bypass -File .\\apply.ps1 -InstanceDir "<instance folder>"`',
    '3. Apply: same command with `-Apply`.',
    '',
    'Pass the instance folder to `-InstanceDir` without a trailing backslash (`...\\MyInstance`, not `...\\MyInstance\\`): inside quotes, a final backslash escapes the closing quote.',
    '',
    'Nothing is deleted: every replaced or removed file is moved to `<instance>\\_studio-backup-<timestamp>\\`.',
    'The script checks the sha256 of every file of this pack against `changes.json` before touching anything.',
    '',
  );
  return lines.join('\n');
}

export type UpdatePackOptions = {
  db: Db;
  base: Profile;
  other: Profile;
  exportsDir: string;
  now?: Date;
  signal?: AbortSignal;
  progress?: (pct: number, msg?: string) => void;
};

/**
 * Builds a delta pack that brings `other` to the reference (`base`) for every planned item, in `<exportsDir>/<name>/`,
 * plus `<exportsDir>/<name>.zip`. Never writes anywhere else. Throws when nothing at all could be exported.
 */
export async function buildUpdatePack(opts: UpdatePackOptions): Promise<ExportResult> {
  const { db, base, other } = opts;
  const now = opts.now ?? new Date();
  const exportsDir = path.resolve(opts.exportsDir);
  for (const p of [base, other]) {
    if (p.locationKind !== 'zip' && isInside(p.location, exportsDir)) throw new Error(`the exports folder ${exportsDir} is inside the profile folder ${p.location}: refusing to write into an instance`);
  }

  const baseSet = loadModSet(db, base.id);
  const otherSet = loadModSet(db, other.id);
  const actionable = actionableMods(diffModSets(baseSet, otherSet, { pins: getPins(db) }));
  const planMods = getPlanItems(db, base.id, other.id, 'mod').map((i) => i.key);
  const planFiles = getPlanItems(db, base.id, other.id, 'file').map((i) => i.key);

  fs.mkdirSync(exportsDir, { recursive: true });
  let name = exportSafeName(other, base, now);
  for (let n = 2; fs.existsSync(path.join(exportsDir, name)) || fs.existsSync(path.join(exportsDir, `${name}.partial`)) || fs.existsSync(path.join(exportsDir, `${name}.zip`)); n++) {
    name = `${exportSafeName(other, base, now)}-${n}`;
  }
  const staging = path.join(exportsDir, `${name}.partial`);
  const zipStaging = path.join(exportsDir, `${name}.zip.partial`);
  const folder = path.join(exportsDir, name);
  const zipPath = path.join(exportsDir, `${name}.zip`);
  fs.mkdirSync(staging);

  const failures: ExportFailure[] = [];
  const warnings: string[] = [];
  const mods: ChangesJson['mods'] = [];
  const jars = new Map<string, ChangesJson['jars'][number]>();
  const removeDb = new Map<string, string[]>(); // keyed by the file name the database knows
  const removeSha = new Map<string, string | undefined>();
  const remove = new Map<string, string[]>(); // keyed by the file name the target really has
  const files: ChangesJson['files'] = [];
  const total = Math.max(planMods.length + planFiles.length, 1);
  let step = 0;
  const tick = (msg: string) => opts.progress?.(Math.min(95, Math.round((++step / total) * 90)), msg);
  const checkAbort = () => {
    if (opts.signal?.aborted) throw new Error('aborted');
  };

  const dupOther = new Map(findDuplicateIds(db, other.id).map((d) => [d.modId, d.files]));
  const jarRow = db.sqlite.prepare('SELECT j.sha256 AS sha256, j.size AS size FROM jar j WHERE j.sha256 = ?');
  const jarSize = (sha?: string) => (sha ? (jarRow.get(sha) as { size: number } | undefined)?.size : undefined);
  const shaOfFile = db.sqlite.prepare('SELECT j.sha256 AS sha256 FROM jar_mod m JOIN jar j ON j.sha256 = m.jar_sha256 WHERE m.profile_id = ? AND m.mod_id = ? AND COALESCE(m.file_name, j.filename) = ? AND m.is_jij = 0 LIMIT 1');
  const source = await openSource(base);
  const locateBase = makeJarLocator(source);
  try {
    for (const modId of planMods) {
      checkAbort();
      tick(modId);
      const action = actionable.get(modId);
      const ref = baseSet.get(modId);
      if (!action || !ref) {
        failures.push({ kind: 'mod', key: modId, reason: 'not an update or a missing mod in the current comparison anymore (re-imported, pinned or already up to date): skipped' });
        continue;
      }
      const cur: ModEntry | undefined = action === 'update' ? otherSet.get(modId) : undefined;
      const refLoc = await locateBase(ref.file, ref.sha256, jarSize(ref.sha256));
      const refFile = refLoc.name; // the name the reference location really has
      if (!jars.has(refFile)) {
        const read = await source.jar(refFile);
        if (!read.ok) {
          failures.push({ kind: 'mod', key: modId, reason: `reference jar ${refFile}: ${read.reason}` });
          continue;
        }
        const actual = sha256Hex(read.data);
        if (actual !== ref.sha256) {
          failures.push({ kind: 'mod', key: modId, reason: `reference jar ${read.where} changed since the import: sha256 ${actual.slice(0, 12)}… instead of ${ref.sha256.slice(0, 12)}… (the imported profile is immutable: delete the reference profile and register it again, or edit it, then import)` });
          continue;
        }
        await fsp.mkdir(path.join(staging, 'mods-add'), { recursive: true });
        await fsp.writeFile(safeResolve(staging, `mods-add/${refFile}`), read.data);
        jars.set(refFile, { file: refFile, sha256: actual, size: read.data.length, modIds: [] });
      }
      jars.get(refFile)!.modIds.push(modId);
      mods.push({ modId, action, file: refFile, sha256: ref.sha256, size: jars.get(refFile)!.size, toVersion: ref.version, fromVersion: cur?.version ?? null, replaces: cur?.file ?? null });
      if (cur) {
        // Two jars for one mod id in the target: both must leave, or the instance keeps a duplicate next to the new jar.
        const dups = dupOther.get(modId);
        for (const f of dups ?? [cur.file]) {
          removeDb.set(f, [...(removeDb.get(f) ?? []), modId]);
          removeSha.set(f, f === cur.file ? cur.sha256 : (shaOfFile.get(other.id, modId, f) as { sha256: string } | undefined)?.sha256);
        }
        if (dups) warnings.push(`${modId} has several jars in the target (${dups.join(', ')}): all of them are listed in remove.txt`);
      }
    }

    // Moving a jar out also removes every other mod it provides: say so when one of them is not part of the plan.
    for (const [file, ids] of removeDb) {
      const others = [...otherSet.values()].filter((e) => e.file === file && !ids.includes(e.modId)).map((e) => e.modId);
      if (others.length) warnings.push(`${file} also provides ${others.join(', ')}, which leave with it`);
    }

    // remove.txt names files, and apply.ps1 moves only files that exist: use the names the target really has.
    if (removeDb.size > 0) {
      const target = await openSource(other);
      try {
        const locate = makeJarLocator(target);
        let unverified = false;
        for (const [dbFile, ids] of removeDb) {
          const sha = removeSha.get(dbFile);
          const loc = await locate(dbFile, sha, jarSize(sha));
          if (loc.state === 'unlisted') unverified = true;
          else if (loc.state === 'missing') warnings.push(`${dbFile} was not found in the target: remove.txt names it anyway, check the target mods folder`);
          else if (loc.state === 'renamed') warnings.push(`${dbFile} is named ${loc.name} in the target: remove.txt uses that name`);
          remove.set(loc.name, [...new Set([...(remove.get(loc.name) ?? []), ...ids])]);
        }
        if (unverified) warnings.push('the target location could not be listed: the jar names in remove.txt come from the last import and were not checked');
      } finally {
        await target.close();
      }
    }

    for (const key of planFiles) {
      checkAbort();
      tick(key);
      if (!isSafePlanFileKey(key)) {
        failures.push({ kind: 'file', key, reason: 'unsafe path: must be relative, with forward slashes, without .., drive letter or colon' });
        continue;
      }
      const read = await source.file(key);
      if (!read.ok) {
        failures.push({ kind: 'file', key, reason: read.reason });
        continue;
      }
      const target = safeResolve(staging, `files-add/${key}`);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, read.data);
      files.push({ path: key, sha256: sha256Hex(read.data), size: read.data.length });
    }
  } catch (err) {
    await source.close();
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }
  await source.close();

  const counts: ExportCounts = {
    modsUpdated: mods.filter((m) => m.action === 'update').length,
    modsRestored: mods.filter((m) => m.action === 'restore').length,
    jarsToRemove: remove.size,
    files: files.length,
    failures: failures.length,
  };
  if (mods.length === 0 && files.length === 0) {
    fs.rmSync(staging, { recursive: true, force: true });
    const why = failures.slice(0, 5).map((f) => `${f.key}: ${f.reason}`).join('; ');
    throw new Error(`nothing could be exported${why ? `: ${why}` : ' (the plan is empty)'}`);
  }

  const createdAt = now.toISOString();
  const baseInfo = { id: base.id, label: profileTitle(base) };
  const otherInfo = { id: other.id, label: profileTitle(other) };
  const changes: ChangesJson = {
    format: 1,
    name,
    createdAt,
    base: baseInfo,
    other: otherInfo,
    mods,
    jars: [...jars.values()],
    remove: [...remove.entries()].map(([file, modIds]) => ({ file, modIds })),
    files,
    failures,
    warnings,
    counts,
  };
  try {
    opts.progress?.(96, 'writing changes.json, CHANGES.md, apply.ps1');
    await fsp.writeFile(path.join(staging, 'remove.txt'), [...remove.keys()].map((f) => `${f}\r\n`).join(''));
    await fsp.writeFile(path.join(staging, 'changes.json'), JSON.stringify(changes, null, 2));
    await fsp.writeFile(path.join(staging, 'CHANGES.md'), changesMarkdown(changes));
    await fsp.writeFile(path.join(staging, 'apply.ps1'), APPLY_PS1, 'ascii');
    opts.progress?.(98, 'zipping');
    await writeZip(staging, name, zipStaging);
    fs.renameSync(staging, folder);
    fs.renameSync(zipStaging, zipPath);
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(zipStaging, { force: true });
    throw err;
  }
  const result: ExportResult = { name, folder, zipPath, zipBytes: fs.statSync(zipPath).size, createdAt, base: baseInfo, other: otherInfo, counts, failures, warnings };
  // result.json is written last: an export folder without it is incomplete and is never listed.
  await fsp.writeFile(path.join(folder, 'result.json'), JSON.stringify(result, null, 2));
  opts.progress?.(100, `export ${name}: ${counts.modsUpdated} update(s), ${counts.modsRestored} restore(s), ${counts.files} file(s), ${counts.failures} failure(s)`);
  return result;
}

/**
 * Deletes what interrupted exports left behind: `update-*.partial` folders and `update-*.zip.partial` files directly under the
 * exports folder. Call it once at server start, when no export job can be running. Returns the removed names.
 */
export function removeStaleExportLeftovers(exportsDir: string): string[] {
  if (!fs.existsSync(exportsDir)) return [];
  const removed: string[] = [];
  for (const e of fs.readdirSync(exportsDir, { withFileTypes: true })) {
    if (!/^update-[A-Za-z0-9._-]+\.(zip\.)?partial$/.test(e.name)) continue;
    try {
      fs.rmSync(path.join(exportsDir, e.name), { recursive: true, force: true });
      removed.push(e.name);
    } catch {
      // locked or already gone: the next start tries again
    }
  }
  return removed;
}

/** Reads `<exportsDir>/<name>/result.json`; null when the name is unsafe or the export is incomplete. */
export function readExportResult(exportsDir: string, name: string): ExportResult | null {
  if (!EXPORT_NAME.test(name) || name.endsWith('.partial')) return null;
  try {
    const file = safeResolve(exportsDir, path.join(name, 'result.json'));
    return JSON.parse(fs.readFileSync(file, 'utf8')) as ExportResult;
  } catch {
    return null;
  }
}

export function listExports(exportsDir: string, max = 50): ExportResult[] {
  if (!fs.existsSync(exportsDir)) return [];
  return fs
    .readdirSync(exportsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => readExportResult(exportsDir, e.name))
    .filter((r): r is ExportResult => r !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.name.localeCompare(a.name))
    .slice(0, max);
}

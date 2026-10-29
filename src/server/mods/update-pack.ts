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
import { openZip, type ZipHandle } from '../zip/zip-reader.js';
import { getPins } from './blacklist-service.js';
import { diffModSets, type ModEntry } from './diff.js';
import { loadModSet } from './modset-store.js';

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
    close: async () => undefined,
  };
}

async function zipReader(zipPath: string): Promise<SourceReader> {
  let zip: ZipHandle;
  try {
    zip = await openZip(zipPath);
  } catch (err) {
    const reason = `cannot open the zip ${zipPath}: ${errText(err)}`;
    return { jar: async () => ({ ok: false, where: zipPath, reason }), file: async () => ({ ok: false, where: zipPath, reason }), close: async () => undefined };
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
    close: () => zip.close(),
  };
}

export async function openSource(profile: Pick<Profile, 'locationKind' | 'location'>): Promise<SourceReader> {
  if (profile.locationKind === 'zip') return zipReader(profile.location);
  if (profile.locationKind === 'folder' || profile.locationKind === 'smb') return folderReader(profile.location);
  const reason = `location kind ${profile.locationKind} cannot be read by Studio`;
  return { jar: async () => ({ ok: false, where: null, reason }), file: async () => ({ ok: false, where: null, reason }), close: async () => undefined };
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
const utcStamp = (d: Date) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;

export const EXPORT_NAME = /^[A-Za-z0-9._-]+$/;

export function exportSafeName(other: Pick<Profile, 'pack' | 'version'>, base: Pick<Profile, 'pack' | 'version'>, now: Date): string {
  const raw = `update-${other.pack}-${other.version}-from-${base.pack}-${base.version}-${utcStamp(now)}`;
  return raw.replace(/[^A-Za-z0-9._-]/g, '_');
}

const isInside = (parent: string, child: string) => {
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

async function writeZip(folder: string, rootName: string, zipPath: string): Promise<void> {
  const zip = new yazl.ZipFile();
  for (const rel of await listTree(folder)) zip.addFile(path.join(folder, ...rel.split('/')), `${rootName}/${rel}`);
  zip.end();
  await pipeline(zip.outputStream, fs.createWriteStream(zipPath));
}

const mdCell = (s: string | null | undefined) => (s ?? '').replace(/\|/g, '\\|');

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
  const remove = new Map<string, string[]>();
  const files: ChangesJson['files'] = [];
  const total = Math.max(planMods.length + planFiles.length, 1);
  let step = 0;
  const tick = (msg: string) => opts.progress?.(Math.min(95, Math.round((++step / total) * 90)), msg);
  const checkAbort = () => {
    if (opts.signal?.aborted) throw new Error('aborted');
  };

  const source = await openSource(base);
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
      if (!jars.has(ref.file)) {
        const read = await source.jar(ref.file);
        if (!read.ok) {
          failures.push({ kind: 'mod', key: modId, reason: `reference jar ${ref.file}: ${read.reason}` });
          continue;
        }
        const actual = sha256Hex(read.data);
        if (actual !== ref.sha256) {
          failures.push({ kind: 'mod', key: modId, reason: `reference jar ${read.where} changed since the import: sha256 ${actual.slice(0, 12)}… instead of ${ref.sha256.slice(0, 12)}… (re-import the reference profile)` });
          continue;
        }
        await fsp.mkdir(path.join(staging, 'mods-add'), { recursive: true });
        await fsp.writeFile(safeResolve(staging, `mods-add/${ref.file}`), read.data);
        jars.set(ref.file, { file: ref.file, sha256: actual, size: read.data.length, modIds: [] });
      }
      jars.get(ref.file)!.modIds.push(modId);
      mods.push({ modId, action, file: ref.file, sha256: ref.sha256, size: jars.get(ref.file)!.size, toVersion: ref.version, fromVersion: cur?.version ?? null, replaces: cur?.file ?? null });
      if (cur) remove.set(cur.file, [...(remove.get(cur.file) ?? []), modId]);
    }

    // Moving a jar out also removes every other mod it provides: say so when one of them is not part of the plan.
    for (const [file, ids] of remove) {
      const others = [...otherSet.values()].filter((e) => e.file === file && !ids.includes(e.modId)).map((e) => e.modId);
      if (others.length) warnings.push(`${file} also provides ${others.join(', ')}, which leave with it`);
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

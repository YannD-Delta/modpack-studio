import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { BlobStore } from '../blobs/blob-store.js';
import type { Db } from '../db/open.js';
import { safeResolve } from '../fs-safe/safe-path.js';
import { findDuplicateIds, loadModSet } from '../mods/modset-store.js';
import { isInside, makeJarLocator, mdCell, openSource, profileTitle, sha256Hex, utcStamp, writeZip, type ExportFailure, type ExportResult, type SourceReader } from '../mods/update-pack.js';
import { APPLY_PS1 } from '../plan/apply-script.js';
import { isSafePlanFileKey } from '../plan/plan-keys.js';
import type { Profile } from '../profiles/profile-service.js';
import type { Choice, ReplayReason, ReplayStatus } from './replay.js';
import { ProjectError, getPicks, listChanges, renderFileMerge, type Preview, type PreviewItem } from './service.js';

/** What happened to one retouch in the pack. */
export type ExportOutcome = 'replayed' | 'removed' | 'kept-base' | 'skipped' | 'nothing' | 'missing';
/** For a config file: copied whole, merged key by key, or merged with `picks` manual picks for the keys both sides changed. */
export type ExportHow = 'copied' | 'merged' | 'merged-picks';
export type ExportItem = { kind: 'file' | 'mod'; key: string; status: ReplayStatus; reason: ReplayReason; choice: Choice | null; outcome: ExportOutcome; how?: ExportHow; picks?: number };
export type ProjectExportResult = ExportResult & { project: { id: number; name: string }; newBase: { id: number; label: string }; items: ExportItem[]; missingJars: string[] };

export type ProjectExportOptions = {
  db: Db;
  dataDir: string;
  exportsDir: string;
  /** The preview this export replays: every conflict and warning must already carry a choice. */
  preview: Preview;
  /** The copy the pack will be applied to (used to name the jars to move out); the new clean copy when omitted. */
  target?: Profile | null;
  /** Looks a profile up by id; null when it no longer exists. */
  profileById: (id: number) => Profile | null;
  /** Candidate to read jars from when a retouch was validated before the candidate was recorded with it. */
  candidateFallback?: Profile | null;
  now?: Date;
};

type ModJar = { file: string; sha256: string; size: number; modIds: string[] };

const sanitize = (raw: string) => raw.replace(/[^A-Za-z0-9._-]/g, '_');
const plainName = (f: string) => !!f && !/[\\/]/.test(f) && f !== '.' && f !== '..';

function changesMarkdown(c: ChangesJson): string {
  const lines = [`# Project pack ${c.name}`, '', `- Project: ${c.project.name}`, `- New base version: ${c.newBase.label}`, `- Target: ${c.other.label}`, `- Created: ${c.createdAt}`, ''];
  lines.push(`## Retouches (${c.items.length})`, '', '| Kind | Item | Verdict | Choice | Result |', '| --- | --- | --- | --- | --- |');
  for (const i of c.items) lines.push(`| ${i.kind} | ${mdCell(i.key)} | ${i.status} (${i.reason}) | ${i.choice ?? '-'} | ${i.outcome}${i.how ? ` (${i.how === 'copied' ? 'copied whole' : i.how === 'merged' ? 'merged' : `merged with ${i.picks ?? 0} manual picks`})` : ''} |`);
  lines.push('', `## Mods to add or replace (${c.jars.length})`, '');
  if (c.jars.length) {
    lines.push('| Jar | Mods | sha256 |', '| --- | --- | --- |');
    for (const j of c.jars) lines.push(`| ${mdCell(j.file)} | ${mdCell(j.modIds.join(', '))} | ${j.sha256} |`);
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
    lines.push('', `## Not exported, missing (${c.failures.length})`, '', '| Kind | Item | Reason |', '| --- | --- | --- |');
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

type ChangesJson = {
  format: 1;
  name: string;
  createdAt: string;
  project: { id: number; name: string };
  newBase: { id: number; label: string };
  base: { id: number; label: string };
  other: { id: number; label: string };
  items: ExportItem[];
  jars: ModJar[];
  remove: { file: string; modIds: string[] }[];
  files: { path: string; sha256: string; size: number; how?: ExportHow; picks?: number }[];
  failures: ExportFailure[];
  warnings: string[];
};

/**
 * Builds a pack that replays the retouches you validated on the new base version, following your choices:
 * config files from the blob store go to files-add/, mods you added or replaced go to mods-add/ (jars read from the candidate
 * they were validated on), jars the target has that must leave go to remove.txt. Same layout and apply.ps1 as the update pack.
 * Never writes anywhere else than `<exportsDir>/<name>/` and `<exportsDir>/<name>.zip`.
 */
export async function buildProjectExport(opts: ProjectExportOptions): Promise<ProjectExportResult> {
  const { db, preview } = opts;
  const now = opts.now ?? new Date();
  const exportsDir = path.resolve(opts.exportsDir);
  const newClean = opts.profileById(preview.newClean.id);
  if (!newClean) throw new ProjectError(404, `profile ${preview.newClean.id} not found`, 'profile_not_found');
  const target = opts.target ?? newClean;
  const changes = new Map(listChanges(db, preview.project.id).map((c) => [`${c.kind}:${c.key}`, c]));
  const blobs = new BlobStore(path.join(opts.dataDir, 'blobs'), db);

  const guarded = new Map<number, Profile>([[newClean.id, newClean], [target.id, target]]);
  const readers: SourceReader[] = [];
  const candidateOf = (c: ReturnType<typeof changes.get>): Profile | null => {
    const id = c && c.kind === 'mod' ? c.payload.candidateId : undefined;
    const p = id ? opts.profileById(id) : null;
    const use = p ?? opts.candidateFallback ?? null;
    if (use) guarded.set(use.id, use);
    return use;
  };
  for (const c of changes.values()) candidateOf(c);
  for (const p of guarded.values()) {
    if (p.locationKind !== 'zip' && isInside(p.location, exportsDir)) throw new Error(`the exports folder ${exportsDir} is inside the profile folder ${p.location}: refusing to write into an instance`);
  }

  fs.mkdirSync(exportsDir, { recursive: true });
  const stem = sanitize(`update-project-${preview.project.name}-${newClean.version}-${utcStamp(now)}`);
  let name = stem;
  for (let n = 2; fs.existsSync(path.join(exportsDir, name)) || fs.existsSync(path.join(exportsDir, `${name}.partial`)) || fs.existsSync(path.join(exportsDir, `${name}.zip`)); n++) name = `${stem}-${n}`;
  const staging = path.join(exportsDir, `${name}.partial`);
  const zipStaging = path.join(exportsDir, `${name}.zip.partial`);
  const folder = path.join(exportsDir, name);
  const zipPath = path.join(exportsDir, `${name}.zip`);
  fs.mkdirSync(staging);

  const failures: ExportFailure[] = [];
  const warnings: string[] = [];
  const items: ExportItem[] = [];
  const jars = new Map<string, ModJar>();
  const files: ChangesJson['files'] = [];
  const removeDb = new Map<string, { modIds: string[]; sha?: string }>();
  const newSet = loadModSet(db, newClean.id);
  const dups = new Map(findDuplicateIds(db, newClean.id).map((d) => [d.modId, d.files]));
  const jarSize = (sha?: string | null) => (sha ? (db.sqlite.prepare('SELECT size FROM jar WHERE sha256 = ?').get(sha) as { size: number } | undefined)?.size : undefined);
  const candidateSources = new Map<number, { reader: SourceReader; locate: ReturnType<typeof makeJarLocator> }>();
  const sourceFor = async (p: Profile) => {
    let s = candidateSources.get(p.id);
    if (!s) {
      const reader = await openSource(p);
      readers.push(reader);
      s = { reader, locate: makeJarLocator(reader) };
      candidateSources.set(p.id, s);
    }
    return s;
  };
  const queueRemoval = (modId: string, except?: string) => {
    const nb = newSet.get(modId);
    if (!nb) return;
    for (const f of dups.get(modId) ?? [nb.file]) {
      if (f === except) continue;
      const cur = removeDb.get(f) ?? { modIds: [], sha: f === nb.file ? nb.sha256 : undefined };
      cur.modIds.push(modId);
      removeDb.set(f, cur);
    }
  };

  try {
    for (const it of preview.items as PreviewItem[]) {
      const c = changes.get(`${it.kind}:${it.key}`);
      const rec = (outcome: ExportOutcome, extra: Pick<ExportItem, 'how' | 'picks'> = {}): void => void items.push({ kind: it.kind, key: it.key, status: it.status, reason: it.reason, choice: it.choice, outcome, ...extra });
      if (!c || it.choice === null) {
        rec('nothing');
        continue;
      }
      if (it.choice === 'base') {
        rec('kept-base');
        continue;
      }
      if (it.choice === 'skip') {
        rec('skipped');
        continue;
      }
      if (c.kind === 'file') {
        if (!isSafePlanFileKey(c.key)) {
          failures.push({ kind: 'file', key: c.key, reason: 'unsafe path: must be relative, with forward slashes, without .., drive letter or colon' });
          rec('missing');
          continue;
        }
        let buf: Buffer;
        let how: ExportHow = 'copied';
        let picked = 0;
        try {
          const picks = getPicks(db, preview.project.id, newClean.id).get(`file:${c.key}`) ?? {};
          if (it.reason === 'merged-keys' || (it.reason === 'keys-conflict' && Object.keys(picks).length > 0)) {
            // key-level merge: your edits on the new base's text, with your picks for the keys both sides changed
            const m = await renderFileMerge(db, opts.dataDir, c, newClean, picks);
            if (!m || !m.clean) {
              failures.push({ kind: 'file', key: c.key, reason: `merge impossible: ${m ? m.problems.slice(0, 3).join('; ') : 'the three versions cannot be read or parsed anymore'}` });
              rec('missing');
              continue;
            }
            buf = Buffer.from(m.text, 'utf8');
            how = m.picks > 0 ? 'merged-picks' : 'merged';
            picked = m.picks;
            const dest = safeResolve(staging, `files-add/${c.key}`);
            await fsp.mkdir(path.dirname(dest), { recursive: true });
            await fsp.writeFile(dest, buf);
            files.push({ path: c.key, sha256: sha256Hex(buf), size: buf.length, how, ...(how === 'merged-picks' ? { picks: picked } : {}) });
            rec('replayed', { how, ...(how === 'merged-picks' ? { picks: picked } : {}) });
            continue;
          }
          buf = await readBlob(blobs, c.payload.sha256);
        } catch (err) {
          failures.push({ kind: 'file', key: c.key, reason: `stored content unreadable: ${err instanceof Error ? err.message : String(err)}` });
          rec('missing');
          continue;
        }
        if (sha256Hex(buf) !== c.payload.sha256) {
          failures.push({ kind: 'file', key: c.key, reason: 'stored content does not match its sha256' });
          rec('missing');
          continue;
        }
        const dest = safeResolve(staging, `files-add/${c.key}`);
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.writeFile(dest, buf);
        files.push({ path: c.key, sha256: c.payload.sha256, size: buf.length, how });
        rec('replayed', { how });
        continue;
      }
      // mods
      if (c.action === 'remove') {
        if (newSet.has(c.key)) queueRemoval(c.key);
        rec(newSet.has(c.key) ? 'removed' : 'nothing');
        continue;
      }
      const cand = candidateOf(c);
      if (!cand || !c.payload.file) {
        failures.push({ kind: 'mod', key: c.key, reason: 'jar missing: the candidate it was validated on is not known anymore' });
        rec('missing');
        continue;
      }
      const src = await sourceFor(cand);
      const loc = await src.locate(c.payload.file, c.payload.sha256 ?? undefined, jarSize(c.payload.sha256));
      const read = loc.state === 'missing' ? null : await src.reader.jar(loc.name);
      if (!read || !read.ok || !plainName(loc.name)) {
        failures.push({ kind: 'mod', key: c.key, reason: `jar missing: ${c.payload.file} is not in ${profileTitle(cand)}${read && !read.ok ? ` (${read.reason})` : ''}` });
        rec('missing');
        continue;
      }
      const actual = sha256Hex(read.data);
      if (c.payload.sha256 && actual !== c.payload.sha256) {
        failures.push({ kind: 'mod', key: c.key, reason: `jar missing: ${loc.name} changed since you validated it (sha256 ${actual.slice(0, 12)}...)` });
        rec('missing');
        continue;
      }
      if (!jars.has(loc.name)) {
        await fsp.mkdir(path.join(staging, 'mods-add'), { recursive: true });
        await fsp.writeFile(safeResolve(staging, `mods-add/${loc.name}`), read.data);
        jars.set(loc.name, { file: loc.name, sha256: actual, size: read.data.length, modIds: [] });
      }
      jars.get(loc.name)!.modIds.push(c.key);
      if (newSet.has(c.key)) queueRemoval(c.key, loc.name);
      rec('replayed');
    }

    // remove.txt names files, and apply.ps1 moves only files that exist: use the names the target really has.
    const remove = new Map<string, string[]>();
    if (removeDb.size > 0) {
      for (const [file, { modIds }] of removeDb) {
        const others = [...newSet.values()].filter((e) => e.file === file && !modIds.includes(e.modId)).map((e) => e.modId);
        if (others.length) warnings.push(`${file} also provides ${others.join(', ')}, which leave with it`);
      }
      const tsrc = await sourceFor(target);
      let unverified = false;
      for (const [dbFile, { modIds, sha }] of removeDb) {
        const loc = await tsrc.locate(dbFile, sha, jarSize(sha));
        if (loc.state === 'unlisted') unverified = true;
        else if (loc.state === 'missing') warnings.push(`${dbFile} was not found in the target: remove.txt names it anyway, check the target mods folder`);
        else if (loc.state === 'renamed') warnings.push(`${dbFile} is named ${loc.name} in the target: remove.txt uses that name`);
        remove.set(loc.name, [...new Set([...(remove.get(loc.name) ?? []), ...modIds])]);
      }
      if (unverified) warnings.push('the target location could not be listed: the jar names in remove.txt come from the last import and were not checked');
      if (!opts.target) warnings.push(`no target given: jar names were checked against ${profileTitle(newClean)}`);
    }

    if (jars.size === 0 && files.length === 0 && remove.size === 0) {
      const why = failures.slice(0, 5).map((f) => `${f.key}: ${f.reason}`).join('; ');
      throw new ProjectError(409, `nothing to export${why ? `: ${why}` : ': every retouch is already in place, kept from the base or skipped'}`, 'nothing_to_export', { failures });
    }

    const createdAt = now.toISOString();
    const newBase = { id: newClean.id, label: profileTitle(newClean) };
    const changesJson: ChangesJson = {
      format: 1,
      name,
      createdAt,
      project: { id: preview.project.id, name: preview.project.name },
      newBase,
      base: newBase,
      other: { id: target.id, label: profileTitle(target) },
      items,
      jars: [...jars.values()],
      remove: [...remove.entries()].map(([file, modIds]) => ({ file, modIds })),
      files,
      failures,
      warnings,
    };
    await fsp.writeFile(path.join(staging, 'remove.txt'), [...remove.keys()].map((f) => `${f}\r\n`).join(''));
    await fsp.writeFile(path.join(staging, 'changes.json'), JSON.stringify(changesJson, null, 2));
    await fsp.writeFile(path.join(staging, 'CHANGES.md'), changesMarkdown(changesJson));
    await fsp.writeFile(path.join(staging, 'apply.ps1'), APPLY_PS1, 'ascii');
    await writeZip(staging, name, zipStaging);
    fs.renameSync(staging, folder);
    fs.renameSync(zipStaging, zipPath);

    const missingJars = items.filter((i) => i.kind === 'mod' && i.outcome === 'missing').map((i) => i.key);
    const result: ProjectExportResult = {
      name,
      folder,
      zipPath,
      zipBytes: fs.statSync(zipPath).size,
      createdAt,
      base: newBase,
      other: changesJson.other,
      counts: { modsUpdated: jars.size, modsRestored: 0, jarsToRemove: remove.size, files: files.length, failures: failures.length },
      failures,
      warnings,
      project: changesJson.project,
      newBase,
      items,
      missingJars,
    };
    // result.json is written last: an export folder without it is incomplete and is never listed.
    await fsp.writeFile(path.join(folder, 'result.json'), JSON.stringify(result, null, 2));
    return result;
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(zipStaging, { force: true });
    throw err;
  } finally {
    for (const r of readers) await r.close();
  }
}

async function readBlob(blobs: BlobStore, sha: string): Promise<Buffer> {
  if (!blobs.has(sha)) throw new Error('blob not found');
  const chunks: Buffer[] = [];
  for await (const chunk of blobs.get(sha)) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  return Buffer.concat(chunks);
}

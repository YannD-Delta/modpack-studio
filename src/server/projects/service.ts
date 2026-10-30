import path from 'node:path';
import { BlobStore } from '../blobs/blob-store.js';
import { inventoryOrThrow, NotScannedError, sha256, sourceOf } from '../configs/compare.js';
import { analyzeCustomizations, INCLUDE_STATUSES, type CustomFile } from '../configs/customizations.js';
import { findInInventory, openProfileReader } from '../configs/profile-files.js';
import type { Db } from '../db/open.js';
import { diffModSets, type ModSet } from '../mods/diff.js';
import { getSources } from '../mods/curseforge-sources.js';
import { loadModSet } from '../mods/modset-store.js';
import type { Profile } from '../profiles/profile-service.js';
import { getNumberLimit } from '../settings/limits.js';
import { formatOf, parseKeys, type KeyFormat } from '../configs/keys.js';
import { renderMerged, threeWayMerge, type MergeResult } from '../configs/merge.js';
import type { ProfileFileReader } from '../configs/profile-files.js';
import { classifyFileChange, classifyModChange, effectiveChoice, parseChoiceKey, type Choice, type Fingerprint, type ReplayReason, type ReplayStatus } from './replay.js';

export class ProjectError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string,
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ProjectError';
  }
}

export type Project = { id: number; name: string; baseVersion: string | null; createdAt: string };

/** `baseBlob` is the sha256 of the base's file as the clean copy had it (the "base then" of the key-level merge); absent on retouches validated before it existed. */
type FilePayload = { sha256: string; size: number; status: string; base: Fingerprint | null; baseBlob?: string };
/** `candidateId` and `sha256` tell where the jar came from and which bytes were validated (absent on retouches validated before they existed). */
type ModPayload = { version: string | null; file: string | null; baseVersion: string | null; candidateId?: number; sha256?: string | null; cf: { projectId: number; fileId: number; name: string; url: string } | null };
export type StoredChange =
  | { id: number; kind: 'file'; key: string; action: 'file'; validatedAt: string; payload: FilePayload }
  | { id: number; kind: 'mod'; key: string; action: 'add' | 'update' | 'remove'; validatedAt: string; payload: ModPayload };

const toProject = (r: { id: number; name: string; base_version: string | null; created_at: string }): Project => ({ id: r.id, name: r.name, baseVersion: r.base_version, createdAt: r.created_at });

export function createProject(db: Db, name: string, baseVersion: string | null): Project {
  const clean = name.trim();
  if (!clean || clean.length > 60) throw new ProjectError(400, 'a project name is 1 to 60 characters', 'invalid_name');
  if (db.sqlite.prepare('SELECT 1 FROM project WHERE lower(name) = lower(?)').get(clean)) throw new ProjectError(409, `a project named ${clean} already exists`, 'duplicate_project');
  const r = db.sqlite.prepare('INSERT INTO project (name, base_version, created_at) VALUES (?, ?, ?)').run(clean, baseVersion?.trim() || null, new Date().toISOString());
  return getProject(db, Number(r.lastInsertRowid));
}

export function getProject(db: Db, id: number): Project {
  const r = db.sqlite.prepare('SELECT id, name, base_version, created_at FROM project WHERE id = ?').get(id) as Parameters<typeof toProject>[0] | undefined;
  if (!r) throw new ProjectError(404, `project ${id} not found`, 'project_not_found');
  return toProject(r);
}

export function listProjects(db: Db): (Project & { changes: number })[] {
  const rows = db.sqlite.prepare('SELECT p.id, p.name, p.base_version, p.created_at, (SELECT count(*) FROM project_change c WHERE c.project_id = p.id) AS changes FROM project p ORDER BY p.id').all() as (Parameters<typeof toProject>[0] & { changes: number })[];
  return rows.map((r) => ({ ...toProject(r), changes: r.changes }));
}

export function listChanges(db: Db, projectId: number): StoredChange[] {
  const rows = db.sqlite.prepare('SELECT id, kind, key, action, payload, validated_at FROM project_change WHERE project_id = ? ORDER BY kind, key').all(projectId) as { id: number; kind: string; key: string; action: string; payload: string; validated_at: string }[];
  return rows.map((r) => ({ id: r.id, kind: r.kind, key: r.key, action: r.action, payload: JSON.parse(r.payload), validatedAt: r.validated_at }) as StoredChange);
}

export function deleteChange(db: Db, dataDir: string, projectId: number, changeId: number): void {
  const row = db.sqlite.prepare('SELECT kind, key, payload FROM project_change WHERE id = ? AND project_id = ?').get(changeId, projectId) as { kind: string; key: string; payload: string } | undefined;
  if (!row) throw new ProjectError(404, `change ${changeId} not found in project ${projectId}`, 'change_not_found');
  db.sqlite.prepare('DELETE FROM project_change WHERE id = ?').run(changeId);
  db.sqlite.prepare('DELETE FROM project_choice WHERE project_id = ? AND kind = ? AND key = ?').run(projectId, row.kind, row.key);
  if (row.kind === 'file') {
    const old = JSON.parse(row.payload) as FilePayload;
    const blobs = new BlobStore(path.join(dataDir, 'blobs'), db);
    blobs.unref(old.sha256);
    if (old.baseBlob) blobs.unref(old.baseBlob);
  }
}

export type TriadProfiles = { clean: Profile; launched: Profile; candidate: Profile };

export type ProposedMod = { modId: string; action: 'add' | 'update' | 'remove'; version: string | null; baseVersion: string | null; file: string | null; validated: boolean };
export type Proposal = { files: (CustomFile & { validated: boolean })[]; mods: ProposedMod[] };

/** What you could validate: the config files you changed (three-copy analysis) and the mods that differ between the clean copy and your candidate. */
export async function proposal(db: Db, dataDir: string, projectId: number, p: TriadProfiles): Promise<Proposal> {
  getProject(db, projectId);
  const stored = listChanges(db, projectId);
  const storedFiles = new Set(stored.filter((c) => c.kind === 'file').map((c) => c.key.toLowerCase()));
  const storedMods = new Set(stored.filter((c) => c.kind === 'mod').map((c) => c.key));
  const found = await analyzeCustomizations(dataDir, { clean: p.clean, launched: p.launched, played: p.candidate });
  const files = found.files.filter((f) => INCLUDE_STATUSES.has(f.status)).map((f) => ({ ...f, validated: storedFiles.has(f.path.toLowerCase()) }));
  const diff = diffModSets(loadModSet(db, p.clean.id), loadModSet(db, p.candidate.id));
  const mods: ProposedMod[] = [
    ...diff.added.map((e) => ({ modId: e.modId, action: 'add' as const, version: e.version, baseVersion: null, file: e.file })),
    ...diff.updated.map((u) => ({ modId: u.modId, action: 'update' as const, version: u.to.version, baseVersion: u.from.version, file: u.to.file })),
    ...diff.removed.map((e) => ({ modId: e.modId, action: 'remove' as const, version: null, baseVersion: e.version, file: null })),
  ].map((m) => ({ ...m, validated: storedMods.has(m.modId) }));
  return { files, mods };
}

const fingerprintOf = (e: { sha256: string; size: number; sizeOnly?: true }): Fingerprint => ({ sha256: e.sha256, size: e.size, ...(e.sizeOnly ? { sizeOnly: true } : {}) });

/** Stores the retouches you picked: config files (content kept in the blob store, the base file's identity kept for the three-way check) and mods. Re-validating a key replaces it. */
export async function saveChanges(db: Db, dataDir: string, projectId: number, p: TriadProfiles, pick: { files: string[]; mods: string[] }): Promise<{ files: number; mods: number }> {
  const project = getProject(db, projectId);
  const proposed = await proposal(db, dataDir, projectId, p);
  const byFile = new Map(proposed.files.map((f) => [f.path.toLowerCase(), f]));
  const byMod = new Map(proposed.mods.map((m) => [m.modId, m]));
  const unknown = [...pick.files.filter((f) => !byFile.has(f.toLowerCase())), ...pick.mods.filter((m) => !byMod.has(m))];
  if (unknown.length) throw new ProjectError(400, `not a retouch of this candidate: ${unknown.join(', ')}`, 'unknown_change', { unknown });

  const blobs = new BlobStore(path.join(dataDir, 'blobs'), db);
  const now = new Date().toISOString();
  const candInv = inventoryOrThrow(dataDir, p.candidate);
  const cleanInv = inventoryOrThrow(dataDir, p.clean);
  const maxBytes = getNumberLimit('configs.maxTextMb') * 1024 * 1024;
  const src = sourceOf(p.candidate);
  if (pick.files.length && !src) throw new ProjectError(409, `a ${p.candidate.locationKind} profile cannot be read yet`, 'unreadable_profile');

  const upsert = db.sqlite.prepare(
    'INSERT INTO project_change (project_id, kind, key, action, payload, validated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, kind, key) DO UPDATE SET action = excluded.action, payload = excluded.payload, validated_at = excluded.validated_at',
  );
  const existing = (kind: string, key: string) => db.sqlite.prepare('SELECT payload FROM project_change WHERE project_id = ? AND kind = ? AND key = ?').get(projectId, kind, key) as { payload: string } | undefined;

  const fileRows: { key: string; payload: FilePayload; blob: Buffer; baseBuf: Buffer | null }[] = [];
  if (pick.files.length) {
    const reader = openProfileReader(src!);
    const cleanSrc = sourceOf(p.clean);
    const cleanReader = cleanSrc ? openProfileReader(cleanSrc) : null;
    try {
      for (const raw of pick.files) {
        const f = byFile.get(raw.toLowerCase())!;
        const entry = findInInventory(candInv.files, f.path);
        if (!entry) throw new ProjectError(409, `${f.path} is not in the last scan of the candidate: rescan it`, 'stale_scan');
        if (entry.entry.size > maxBytes) throw new ProjectError(400, `${f.path} is larger than the ${maxBytes / 1048576} MiB limit (setting configs.maxTextMb)`, 'file_too_large');
        const buf = await reader.read(entry.path, maxBytes);
        const baseEntry = findInInventory(cleanInv.files, f.path)?.entry ?? null;
        // The base's own content, as the clean copy had it: the "base then" of a later key-level merge. Skipped when it cannot be read or does not match the scan.
        let baseBuf: Buffer | null = null;
        if (baseEntry && cleanReader && baseEntry.size <= maxBytes) {
          try {
            const read = await cleanReader.read(findInInventory(cleanInv.files, f.path)!.path, maxBytes);
            if (read.length === baseEntry.size && (baseEntry.sizeOnly || sha256(read) === baseEntry.sha256)) baseBuf = read;
          } catch {
            baseBuf = null;
          }
        }
        fileRows.push({ key: f.path, blob: buf, baseBuf, payload: { sha256: sha256(buf), size: buf.length, status: f.status, base: baseEntry ? fingerprintOf(baseEntry) : null } });
      }
    } finally {
      await reader.close();
      await cleanReader?.close();
    }
  }
  const sources = getSources(db, p.candidate.id);
  const candidateMods = loadModSet(db, p.candidate.id);
  const tx = db.sqlite.transaction(() => {
    db.sqlite.prepare('UPDATE project SET base_version = ? WHERE id = ?').run(p.clean.version, projectId);
  });
  tx();
  for (const row of fileRows) {
    const { sha256: sha } = await blobs.put(row.blob);
    const old = existing('file', row.key);
    blobs.ref(sha);
    if (row.baseBuf) {
      row.payload.baseBlob = (await blobs.put(row.baseBuf)).sha256;
      blobs.ref(row.payload.baseBlob);
    }
    if (old) {
      const o = JSON.parse(old.payload) as FilePayload;
      blobs.unref(o.sha256);
      if (o.baseBlob) blobs.unref(o.baseBlob);
    }
    upsert.run(projectId, 'file', row.key, 'file', JSON.stringify(row.payload), now);
  }
  for (const id of pick.mods) {
    const m = byMod.get(id)!;
    const cf = m.file ? sources.get(m.file) : undefined;
    const payload: ModPayload = { version: m.version, file: m.file, baseVersion: m.baseVersion, candidateId: p.candidate.id, sha256: candidateMods.get(id)?.sha256 ?? null, cf: cf ? { projectId: cf.projectId, fileId: cf.fileId, name: cf.name, url: cf.url } : null };
    upsert.run(projectId, 'mod', id, m.action, JSON.stringify(payload), now);
  }
  void project;
  return { files: fileRows.length, mods: pick.mods.length };
}

export type PreviewItem = {
  id: number;
  kind: 'file' | 'mod';
  key: string;
  action: string;
  status: ReplayStatus;
  reason: ReplayReason;
  mine: { version?: string | null; size?: number };
  newBase: { version?: string; size?: number } | null;
  /** What will be exported: your stored choice, else the default (safe = mine). null = no decision yet or nothing to do. */
  choice: Choice | null;
  /** merged-keys and keys-conflict: how many keys the merge takes from your file and from the new base. */
  merge?: { fromMine: number; fromBase: number };
  /** keys-conflict: the keys both sides changed, with your pick for each. */
  keyConflicts?: KeyConflict[];
  /** keys-conflict: conflicting keys still without a pick (counts for the pending counter). */
  unresolvedKeys?: number;
};
export type Preview = {
  project: Project;
  newClean: { id: number; label: string };
  missing: { scan: boolean; import: boolean };
  summary: Record<ReplayStatus, number>;
  items: PreviewItem[];
  baseDiff: { added: number; removed: number; updated: number } | null;
};

export type PickSide = 'mine' | 'base';
export type KeyConflict = { key: string; then: string | null; now: string | null; mine: string | null; pick: PickSide | null };
type FileChange = Extract<StoredChange, { kind: 'file' }>;
type Analysis = { format: KeyFormat; result: MergeResult; baseNowText: string; mineText: string };

async function readBlobBuffer(blobs: BlobStore, sha: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of blobs.get(sha)) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  return Buffer.concat(chunks);
}

/**
 * Three-way key merge of one file: base then (stored blob), mine (stored blob) and the new base's file. null when it cannot be done
 * (no base content kept, unknown format, unreadable, too large, or one of the three does not parse): the whole-file verdict then stands.
 */
async function analyseMerge(blobs: BlobStore, reader: ProfileFileReader, maxBytes: number, c: FileChange, newPath: string, newSize: number): Promise<Analysis | null> {
  const format = formatOf(c.key);
  const baseBlob = c.payload.baseBlob;
  if (!format || !baseBlob || newSize > maxBytes || !blobs.has(baseBlob) || !blobs.has(c.payload.sha256)) return null;
  try {
    const thenText = (await readBlobBuffer(blobs, baseBlob)).toString('utf8');
    const mineText = (await readBlobBuffer(blobs, c.payload.sha256)).toString('utf8');
    const baseNowText = (await reader.read(newPath, maxBytes)).toString('utf8');
    const then = parseKeys(thenText, format);
    const now = parseKeys(baseNowText, format);
    const mine = parseKeys(mineText, format);
    if (!then.ok || !now.ok || !mine.ok) return null;
    return { format, result: threeWayMerge(then.keys, now.keys, mine.keys), baseNowText, mineText };
  } catch {
    return null;
  }
}

/** Settles the conflicting keys you picked: "mine" takes your value, "base" keeps the new base's. Keys without a pick stay conflicts. */
function applyPicks(result: MergeResult, picks: Record<string, PickSide>): MergeResult {
  const decisions = result.decisions.map((d) => {
    if (d.decision !== 'conflict') return d;
    const pick = picks[d.key];
    if (pick === 'mine') return { ...d, decision: 'mine' as const, value: d.mine };
    if (pick === 'base') return { ...d, decision: 'base' as const, value: d.now };
    return d;
  });
  const merged = new Map<string, string>();
  for (const d of decisions) if (d.value !== undefined) merged.set(d.key, d.value);
  const conflicts = result.conflicts.filter((k) => !picks[k.key]);
  return { merged, decisions, conflicts, clean: conflicts.length === 0 };
}

const countOf = (r: MergeResult) => ({ fromMine: r.decisions.filter((d) => d.decision === 'mine').length, fromBase: r.decisions.filter((d) => d.decision === 'base').length });

/** The merged text of one file for the export: your edits on the new base's text, with your picks for the keys both sides changed. null when the merge cannot be computed. */
export async function renderFileMerge(db: Db, dataDir: string, c: FileChange, newClean: Profile, picks: Record<string, PickSide>): Promise<{ text: string; clean: boolean; problems: string[]; picks: number } | null> {
  const src = sourceOf(newClean);
  if (!src) return null;
  const hit = findInInventory(inventoryOrThrow(dataDir, newClean).files, c.key);
  if (!hit) return null;
  const reader = openProfileReader(src);
  try {
    const an = await analyseMerge(new BlobStore(path.join(dataDir, 'blobs'), db), reader, getNumberLimit('configs.maxTextMb') * 1024 * 1024, c, hit.path, hit.entry.size);
    if (!an) return null;
    const resolved = applyPicks(an.result, picks);
    const r = renderMerged(an.format, an.baseNowText, an.mineText, resolved);
    return { text: r.text, clean: r.clean, problems: r.conflicts.map((k) => (k.detail ? `${k.key}: ${k.detail}` : k.key)), picks: an.result.conflicts.filter((k) => picks[k.key]).length };
  } finally {
    await reader.close();
  }
}

/** What replaying your validated retouches on a new version of the base would do, item by item, before anything is written. */
export async function preview(db: Db, dataDir: string, projectId: number, newClean: Profile, oldClean: Profile | null): Promise<Preview> {
  const project = getProject(db, projectId);
  const changes = listChanges(db, projectId);
  let inv: ReturnType<typeof inventoryOrThrow> | null = null;
  try {
    inv = inventoryOrThrow(dataDir, newClean);
  } catch (err) {
    if (!(err instanceof NotScannedError)) throw err;
  }
  const mods: ModSet = loadModSet(db, newClean.id);
  const haveMods = mods.size > 0;
  const items: PreviewItem[] = [];
  const stored = getChoices(db, projectId, newClean.id);
  const storedPicks = getPicks(db, projectId, newClean.id);
  const blobs = new BlobStore(path.join(dataDir, 'blobs'), db);
  const maxBytes = getNumberLimit('configs.maxTextMb') * 1024 * 1024;
  const newSrc = sourceOf(newClean);
  const reader = inv && newSrc ? openProfileReader(newSrc) : null;
  try {
    for (const c of changes) {
      if (c.kind === 'file') {
        if (!inv) continue;
        const hit = findInInventory(inv.files, c.key);
        let v = classifyFileChange({ mine: { sha256: c.payload.sha256, size: c.payload.size }, base: c.payload.base }, hit ? fingerprintOf(hit.entry) : null);
        const base: Omit<PreviewItem, 'status' | 'reason' | 'choice'> = { id: c.id, kind: 'file', key: c.key, action: c.action, mine: { size: c.payload.size }, newBase: hit ? { size: hit.entry.size } : null };
        const storedChoice = stored.get(`file:${c.key}`);
        // Both sides changed the file: try the key-level merge before calling it a conflict.
        const an = v.reason === 'base-changed' && hit && reader ? await analyseMerge(blobs, reader, maxBytes, c, hit.path, hit.entry.size) : null;
        if (an && an.result.clean && renderMerged(an.format, an.baseNowText, an.mineText, an.result).clean) {
          v = { status: 'safe', reason: 'merged-keys' };
          items.push({ ...base, ...v, merge: countOf(an.result), choice: effectiveChoice(v.status, storedChoice) });
        } else if (an && !an.result.clean) {
          const picks = storedPicks.get(`file:${c.key}`) ?? {};
          const keyConflicts: KeyConflict[] = an.result.decisions
            .filter((d) => d.decision === 'conflict')
            .map((d) => ({ key: d.key, then: d.then ?? null, now: d.now ?? null, mine: d.mine ?? null, pick: picks[d.key] ?? null }));
          const unresolvedKeys = keyConflicts.filter((k) => k.pick === null).length;
          // A whole-file choice settles the file ("mine" without any pick = your whole file); with picks, it is settled once every conflicting key has one.
          const picked = Object.keys(picks).length > 0;
          const choice: Choice | null = storedChoice === 'base' || storedChoice === 'skip' ? storedChoice : storedChoice === 'mine' && (!picked || unresolvedKeys === 0) ? 'mine' : null;
          items.push({ ...base, status: 'conflict', reason: 'keys-conflict', merge: countOf(an.result), keyConflicts, unresolvedKeys, choice });
        } else {
          items.push({ ...base, ...v, choice: effectiveChoice(v.status, storedChoice) });
        }
      } else {
        if (!haveMods) continue;
        const nb = mods.get(c.key) ?? null;
        const v = classifyModChange({ action: c.action, mineVersion: c.payload.version, baseVersion: c.payload.baseVersion }, nb ? { version: nb.version } : null);
        items.push({ id: c.id, kind: 'mod', key: c.key, action: c.action, ...v, mine: { version: c.payload.version }, newBase: nb ? { version: nb.version } : null, choice: effectiveChoice(v.status, stored.get(`mod:${c.key}`)) });
      }
    }
  } finally {
    await reader?.close();
  }
  const summary: Record<ReplayStatus, number> = { safe: 0, already: 0, conflict: 0, warning: 0 };
  for (const i of items) summary[i.status]++;
  let baseDiff: Preview['baseDiff'] = null;
  if (oldClean && haveMods) {
    const d = diffModSets(loadModSet(db, oldClean.id), mods);
    baseDiff = { added: d.added.length, removed: d.removed.length, updated: d.updated.length };
  }
  return {
    project,
    newClean: { id: newClean.id, label: `${newClean.pack} ${newClean.version} · ${newClean.side} · ${newClean.state}` },
    missing: { scan: !inv && changes.some((c) => c.kind === 'file'), import: !haveMods && changes.some((c) => c.kind === 'mod') },
    summary,
    items,
    baseDiff,
  };
}

/** Stored choices for one project replayed on one new base, keyed "<kind>:<key>". */
export function getChoices(db: Db, projectId: number, newCleanId: number): Map<string, Choice> {
  const rows = db.sqlite.prepare('SELECT kind, key, choice FROM project_choice WHERE project_id = ? AND new_clean_id = ?').all(projectId, newCleanId) as { kind: string; key: string; choice: Choice }[];
  return new Map(rows.map((r) => [`${r.kind}:${r.key}`, r.choice]));
}

/** Your pick per conflicting key, for each file retouch that has some, keyed "file:<key>". */
export function getPicks(db: Db, projectId: number, newCleanId: number): Map<string, Record<string, PickSide>> {
  const rows = db.sqlite.prepare('SELECT kind, key, picks FROM project_choice WHERE project_id = ? AND new_clean_id = ? AND picks IS NOT NULL').all(projectId, newCleanId) as { kind: string; key: string; picks: string }[];
  return new Map(rows.map((r) => [`${r.kind}:${r.key}`, JSON.parse(r.picks) as Record<string, PickSide>]));
}

/**
 * Stores your choices (replacing earlier ones for the same retouch) and your picks per conflicting key. Refuses a key that is not one of the project's retouches.
 * Picks are merged into earlier ones; a file that gets picks and has no choice yet is chosen "mine" (the merge with your picks).
 */
export function setChoices(db: Db, projectId: number, newCleanId: number, choices: Record<string, Choice>, picks: Record<string, Record<string, PickSide>> = {}): number {
  getProject(db, projectId);
  const known = new Set(listChanges(db, projectId).map((c) => `${c.kind}:${c.key}`));
  const unknown = [...Object.keys(choices), ...Object.keys(picks)].filter((k) => !parseChoiceKey(k) || !known.has(k));
  const notFile = Object.keys(picks).filter((k) => parseChoiceKey(k)?.kind !== 'file');
  if (unknown.length || notFile.length) throw new ProjectError(400, `not a retouch of this project: ${[...unknown, ...notFile].join(', ')}`, 'unknown_change', { unknown: [...unknown, ...notFile] });
  const upsert = db.sqlite.prepare('INSERT INTO project_choice (project_id, new_clean_id, kind, key, choice) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id, new_clean_id, kind, key) DO UPDATE SET choice = excluded.choice');
  const setPicks = db.sqlite.prepare('UPDATE project_choice SET picks = ? WHERE project_id = ? AND new_clean_id = ? AND kind = ? AND key = ?');
  const current = getChoices(db, projectId, newCleanId);
  const earlier = getPicks(db, projectId, newCleanId);
  db.sqlite.transaction(() => {
    for (const [k, v] of Object.entries(choices)) {
      const { kind, key } = parseChoiceKey(k)!;
      upsert.run(projectId, newCleanId, kind, key, v);
      // an explicit whole-file choice replaces earlier per-key picks, unless picks come with it
      if (!(k in picks)) setPicks.run(null, projectId, newCleanId, kind, key);
    }
    for (const [k, mine] of Object.entries(picks)) {
      const { kind, key } = parseChoiceKey(k)!;
      if (!(k in choices)) upsert.run(projectId, newCleanId, kind, key, current.get(k) === 'base' || current.get(k) === 'skip' ? 'mine' : (current.get(k) ?? 'mine'));
      setPicks.run(JSON.stringify({ ...(earlier.get(k) ?? {}), ...mine }), projectId, newCleanId, kind, key);
    }
  })();
  return Object.keys(choices).length + Object.keys(picks).length;
}

/** Retouches that need a decision before an export (conflicts and warnings without a choice). */
export const withoutChoice = (items: PreviewItem[]): PreviewItem[] => items.filter((i) => (i.status === 'conflict' || i.status === 'warning') && i.choice === null);

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
import { classifyFileChange, classifyModChange, type Fingerprint, type ReplayReason, type ReplayStatus } from './replay.js';

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

type FilePayload = { sha256: string; size: number; status: string; base: Fingerprint | null };
type ModPayload = { version: string | null; file: string | null; baseVersion: string | null; cf: { projectId: number; fileId: number; name: string; url: string } | null };
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
  const row = db.sqlite.prepare('SELECT kind, payload FROM project_change WHERE id = ? AND project_id = ?').get(changeId, projectId) as { kind: string; payload: string } | undefined;
  if (!row) throw new ProjectError(404, `change ${changeId} not found in project ${projectId}`, 'change_not_found');
  db.sqlite.prepare('DELETE FROM project_change WHERE id = ?').run(changeId);
  if (row.kind === 'file') new BlobStore(path.join(dataDir, 'blobs'), db).unref((JSON.parse(row.payload) as FilePayload).sha256);
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

  const fileRows: { key: string; payload: FilePayload; blob: Buffer }[] = [];
  if (pick.files.length) {
    const reader = openProfileReader(src!);
    try {
      for (const raw of pick.files) {
        const f = byFile.get(raw.toLowerCase())!;
        const entry = findInInventory(candInv.files, f.path);
        if (!entry) throw new ProjectError(409, `${f.path} is not in the last scan of the candidate: rescan it`, 'stale_scan');
        if (entry.entry.size > maxBytes) throw new ProjectError(400, `${f.path} is larger than the ${maxBytes / 1048576} MiB limit (setting configs.maxTextMb)`, 'file_too_large');
        const buf = await reader.read(entry.path, maxBytes);
        const baseEntry = findInInventory(cleanInv.files, f.path)?.entry ?? null;
        fileRows.push({ key: f.path, blob: buf, payload: { sha256: sha256(buf), size: buf.length, status: f.status, base: baseEntry ? fingerprintOf(baseEntry) : null } });
      }
    } finally {
      await reader.close();
    }
  }
  const sources = getSources(db, p.candidate.id);
  const tx = db.sqlite.transaction(() => {
    db.sqlite.prepare('UPDATE project SET base_version = ? WHERE id = ?').run(p.clean.version, projectId);
  });
  tx();
  for (const row of fileRows) {
    const { sha256: sha } = await blobs.put(row.blob);
    const old = existing('file', row.key);
    blobs.ref(sha);
    if (old) blobs.unref((JSON.parse(old.payload) as FilePayload).sha256);
    upsert.run(projectId, 'file', row.key, 'file', JSON.stringify(row.payload), now);
  }
  for (const id of pick.mods) {
    const m = byMod.get(id)!;
    const cf = m.file ? sources.get(m.file) : undefined;
    const payload: ModPayload = { version: m.version, file: m.file, baseVersion: m.baseVersion, cf: cf ? { projectId: cf.projectId, fileId: cf.fileId, name: cf.name, url: cf.url } : null };
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
};
export type Preview = {
  project: Project;
  newClean: { id: number; label: string };
  missing: { scan: boolean; import: boolean };
  summary: Record<ReplayStatus, number>;
  items: PreviewItem[];
  baseDiff: { added: number; removed: number; updated: number } | null;
};

/** What replaying your validated retouches on a new version of the base would do, item by item, before anything is written. */
export function preview(db: Db, dataDir: string, projectId: number, newClean: Profile, oldClean: Profile | null): Preview {
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
  for (const c of changes) {
    if (c.kind === 'file') {
      if (!inv) continue;
      const hit = findInInventory(inv.files, c.key);
      const v = classifyFileChange({ mine: { sha256: c.payload.sha256, size: c.payload.size }, base: c.payload.base }, hit ? fingerprintOf(hit.entry) : null);
      items.push({ id: c.id, kind: 'file', key: c.key, action: c.action, ...v, mine: { size: c.payload.size }, newBase: hit ? { size: hit.entry.size } : null });
    } else {
      if (!haveMods) continue;
      const nb = mods.get(c.key) ?? null;
      const v = classifyModChange({ action: c.action, mineVersion: c.payload.version, baseVersion: c.payload.baseVersion }, nb ? { version: nb.version } : null);
      items.push({ id: c.id, kind: 'mod', key: c.key, action: c.action, ...v, mine: { version: c.payload.version }, newBase: nb ? { version: nb.version } : null });
    }
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

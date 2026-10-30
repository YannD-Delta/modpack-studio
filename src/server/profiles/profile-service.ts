import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/open.js';

/** A pack name is a setting (see settings/packs.ts): the followed pack, Base by default, and the player's own, Own by default. */
export type Pack = string;
export type Side = 'client' | 'server';
export type State = 'clean' | 'launched' | 'run';
export type LocationKind = 'zip' | 'folder' | 'smb' | 'agent';

export type NewProfile = { pack: Pack; version: string; side: Side; state: State; locationKind: LocationKind; location: string };
export type Profile = NewProfile & { id: number; packVersionId: number; capturedAt: string | null; manifestHash: string | null; immutable: boolean };

export class LaunchArtifactsError extends Error {
  constructor(public readonly artifacts: string[]) {
    super(`launch artifacts found, this is not a clean profile: ${artifacts.join(', ')}`);
    this.name = 'LaunchArtifactsError';
  }
}
export class ProcessRunningError extends Error {
  constructor(location: string) {
    super(`a process is running from ${location}, refusing to capture it`);
    this.name = 'ProcessRunningError';
  }
}
export class ImmutableProfileError extends Error {
  constructor(id: number) {
    super(`profile ${id} is immutable`);
    this.name = 'ImmutableProfileError';
  }
}
export class DuplicateProfileError extends Error {
  constructor(input: NewProfile) {
    super(`a ${input.pack} ${input.version} ${input.side} ${input.state} profile already exists`);
    this.name = 'DuplicateProfileError';
  }
}

/** Thrown when a registered location is unusable; `status` is the HTTP code the API answers with. */
export class LocationError extends Error {
  constructor(
    public readonly code: 'location_not_absolute' | 'location_not_found' | 'location_wrong_kind',
    message: string,
    public readonly status: 400 | 422,
  ) {
    super(message);
    this.name = 'LocationError';
  }
}

/** Checks that `location` is absolute, reachable and of the right type (file for a zip, directory otherwise). Any fs failure is a clean 422, never a 500. */
export function validateLocation(kind: LocationKind, location: string): void {
  if (!path.isAbsolute(location)) throw new LocationError('location_not_absolute', 'location must be an absolute path (no surrounding quotes)', 400);
  if (kind === 'agent') return; // nothing in Studio can read it, keep old rows editable
  let stat: fs.Stats;
  try {
    stat = fs.statSync(location);
  } catch {
    throw new LocationError('location_not_found', 'location does not exist or is not reachable', 422);
  }
  if (kind === 'zip' && !stat.isFile()) throw new LocationError('location_wrong_kind', 'location must be a zip file', 422);
  if (kind !== 'zip' && !stat.isDirectory()) throw new LocationError('location_wrong_kind', 'location must be a folder', 422);
}

const ARTIFACT_DIRS = ['logs', 'crash-reports', 'world', 'saves'];
const ARTIFACT_FILES = ['options.txt'];
// The CurseForge app creates these in an instance that was never launched (seen on real instances).
const APP_CREATED = new Set(['instance_audit.txt']);

function hasLaunchContent(full: string): boolean {
  return fs.readdirSync(full).some((n) => !APP_CREATED.has(n));
}

/** Names (relative to `dir`) that only exist once the game or server has been started. */
export function detectLaunchArtifacts(dir: string): string[] {
  const found: string[] = [];
  const scan = (sub: string) => {
    const full = path.join(dir, sub);
    if (!fs.existsSync(full)) return;
    for (const e of fs.readdirSync(full, { withFileTypes: true })) {
      const rel = sub ? path.join(sub, e.name) : e.name;
      if (!sub && e.isDirectory() && ARTIFACT_DIRS.includes(e.name) && hasLaunchContent(path.join(full, e.name))) found.push(rel);
      else if (!sub && e.isFile() && ARTIFACT_FILES.includes(e.name)) found.push(rel);
      else if (e.isFile() && e.name.endsWith('.bak')) found.push(rel);
    }
  };
  scan('');
  scan('config');
  return found;
}

type Row = {
  id: number; pack_version_id: number; pack: string; version: string; side: string; state: string;
  location_kind: string; location: string; captured_at: string | null; manifest_hash: string | null; immutable: number;
};

const SELECT = `SELECT p.id, p.pack_version_id, v.pack, v.version, p.side, p.state, p.location_kind, p.location, p.captured_at, p.manifest_hash, p.immutable
  FROM profile p JOIN pack_version v ON v.id = p.pack_version_id`;

function toProfile(r: Row): Profile {
  return {
    id: r.id, packVersionId: r.pack_version_id, pack: r.pack as Pack, version: r.version, side: r.side as Side, state: r.state as State,
    locationKind: r.location_kind as LocationKind, location: r.location, capturedAt: r.captured_at, manifestHash: r.manifest_hash, immutable: r.immutable === 1,
  };
}

export function createProfile(db: Db, input: NewProfile, deps: { isProcessRunning?: (location: string) => boolean } = {}): Profile {
  if (input.state === 'clean' && (input.locationKind === 'folder' || input.locationKind === 'smb') && fs.existsSync(input.location)) {
    const artifacts = detectLaunchArtifacts(input.location);
    if (artifacts.length) throw new LaunchArtifactsError(artifacts);
  }
  if (input.state === 'run' && deps.isProcessRunning?.(input.location)) throw new ProcessRunningError(input.location);

  db.sqlite.prepare('INSERT INTO pack_version (pack, version) VALUES (?, ?) ON CONFLICT(pack, version) DO NOTHING').run(input.pack, input.version);
  const pv = db.sqlite.prepare('SELECT id FROM pack_version WHERE pack = ? AND version = ?').get(input.pack, input.version) as { id: number };
  const dup = db.sqlite.prepare('SELECT 1 FROM profile WHERE pack_version_id = ? AND side = ? AND state = ?').get(pv.id, input.side, input.state);
  if (dup) throw new DuplicateProfileError(input);

  const immutable = input.state === 'run' ? 0 : 1;
  const r = db.sqlite
    .prepare('INSERT INTO profile (pack_version_id, side, state, location_kind, location, captured_at, immutable) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(pv.id, input.side, input.state, input.locationKind, input.location, new Date().toISOString(), immutable);
  return getProfile(db, Number(r.lastInsertRowid));
}

export function getProfile(db: Db, id: number): Profile {
  const row = db.sqlite.prepare(`${SELECT} WHERE p.id = ?`).get(id) as Row | undefined;
  if (!row) throw new Error(`profile ${id} not found`);
  return toProfile(row);
}

export function updateProfile(db: Db, id: number, patch: Partial<Pick<NewProfile, 'location' | 'locationKind'>>): Profile {
  const current = getProfile(db, id);
  if (current.immutable) throw new ImmutableProfileError(id);
  db.sqlite
    .prepare('UPDATE profile SET location = ?, location_kind = ?, captured_at = ? WHERE id = ?')
    .run(patch.location ?? current.location, patch.locationKind ?? current.locationKind, new Date().toISOString(), id);
  return getProfile(db, id);
}

/** Mod and import-issue counts of a profile. `complete`: at least one mod read and no skipped jar. */
export function importStatus(db: Db, id: number): { mods: number; issues: number; complete: boolean } {
  const r = db.sqlite
    .prepare('SELECT (SELECT count(*) FROM jar_mod WHERE profile_id = @id) AS mods, (SELECT count(*) FROM import_issue WHERE profile_id = @id) AS issues')
    .get({ id }) as { mods: number; issues: number };
  return { ...r, complete: r.mods > 0 && r.issues === 0 };
}

/** Moves a profile (any state) to another location of the same kind; imported data is kept. Same validation as creation. */
export function relocateProfile(db: Db, id: number, location: string): Profile {
  const current = getProfile(db, id);
  validateLocation(current.locationKind, location);
  if (current.state === 'clean' && (current.locationKind === 'folder' || current.locationKind === 'smb')) {
    const artifacts = detectLaunchArtifacts(location);
    if (artifacts.length) throw new LaunchArtifactsError(artifacts);
  }
  db.sqlite.prepare('UPDATE profile SET location = ? WHERE id = ?').run(location, id);
  return getProfile(db, id);
}

/** Removes a profile with the rows that belong only to it, then its pack version when nothing else uses it. Jars and decisions are shared and stay. */
export function deleteProfile(db: Db, id: number): void {
  const current = getProfile(db, id);
  db.sqlite.transaction(() => {
    for (const t of ['jar_mod', 'import_issue', 'jar_source']) db.sqlite.prepare(`DELETE FROM ${t} WHERE profile_id = ?`).run(id);
    db.sqlite.prepare('DELETE FROM update_plan_item WHERE base_profile_id = ? OR other_profile_id = ?').run(id, id);
    db.sqlite.prepare('DELETE FROM profile WHERE id = ?').run(id);
    db.sqlite.prepare('DELETE FROM pack_version WHERE id = ? AND NOT EXISTS (SELECT 1 FROM profile WHERE pack_version_id = ?)').run(current.packVersionId, current.packVersionId);
  })();
}

export type MatrixProfile = Profile & { importedAt: string | null; importIssueCount: number };
export type MatrixRow = { pack: Pack; version: string; cells: Record<string, MatrixProfile | null> };

const CELL_KEYS = (['client', 'server'] as const).flatMap((s) => (['clean', 'launched', 'run'] as const).map((st) => `${s}-${st}`));

function withImportInfo(db: Db, p: Profile): MatrixProfile {
  const st = importStatus(db, p.id);
  let importedAt: string | null = null;
  if (st.mods > 0) {
    const a = db.sqlite.prepare("SELECT max(at) AS at FROM audit_log WHERE action = 'profile.import' AND target = ?").get(String(p.id)) as { at: string | null };
    importedAt = a.at ?? p.capturedAt ?? new Date(0).toISOString();
  }
  return { ...p, importedAt, importIssueCount: st.issues };
}

/** One row per pack version, one cell per side x state; empty cells are null. */
export function listMatrix(db: Db): MatrixRow[] {
  const versions = db.sqlite.prepare('SELECT id, pack, version FROM pack_version ORDER BY id').all() as { id: number; pack: string; version: string }[];
  const profiles = (db.sqlite.prepare(`${SELECT} ORDER BY p.id`).all() as Row[]).map(toProfile).map((p) => withImportInfo(db, p));
  return versions.map((v) => {
    const cells: Record<string, MatrixProfile | null> = Object.fromEntries(CELL_KEYS.map((k) => [k, null]));
    for (const p of profiles.filter((x) => x.packVersionId === v.id)) cells[`${p.side}-${p.state}`] = p;
    return { pack: v.pack as Pack, version: v.version, cells };
  });
}

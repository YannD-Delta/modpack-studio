import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/open.js';

/** A pack name is a setting (see settings/packs.ts): the followed pack, ATM10 by default, and the player's own, LMP by default. */
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

export type MatrixRow = { pack: Pack; version: string; cells: Record<string, Profile | null> };

const CELL_KEYS = (['client', 'server'] as const).flatMap((s) => (['clean', 'launched', 'run'] as const).map((st) => `${s}-${st}`));

/** One row per pack version, one cell per side x state; empty cells are null. */
export function listMatrix(db: Db): MatrixRow[] {
  const versions = db.sqlite.prepare('SELECT id, pack, version FROM pack_version ORDER BY id').all() as { id: number; pack: string; version: string }[];
  const profiles = (db.sqlite.prepare(`${SELECT} ORDER BY p.id`).all() as Row[]).map(toProfile);
  return versions.map((v) => {
    const cells: Record<string, Profile | null> = Object.fromEntries(CELL_KEYS.map((k) => [k, null]));
    for (const p of profiles.filter((x) => x.packVersionId === v.id)) cells[`${p.side}-${p.state}`] = p;
    return { pack: v.pack as Pack, version: v.version, cells };
  });
}

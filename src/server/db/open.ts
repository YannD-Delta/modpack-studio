import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';

export type Db = {
  sqlite: Database.Database;
  orm: BetterSQLite3Database<typeof schema>;
  close(): void;
};

/** Rolling backups of studio.db kept in the backup folder (the oldest are deleted after a new copy succeeded). */
export const BACKUP_KEEP = 5;
/** No second automatic backup within this delay, so a restart loop (watch mode) does not push the good copies out. */
export const BACKUP_MIN_INTERVAL_MS = 60 * 60 * 1000;

export type OpenDbOptions = { backupDir?: string; migrationsFolder?: string; backupKeep?: number; backupMinIntervalMs?: number };

const DEFAULT_MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../drizzle');

function journalEntryCount(folder: string): number {
  const file = path.join(folder, 'meta', '_journal.json');
  if (!fs.existsSync(file)) return 0;
  return (JSON.parse(fs.readFileSync(file, 'utf8')).entries as unknown[]).length;
}

function appliedMigrationCount(sqlite: Database.Database): number {
  const has = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='__drizzle_migrations'").get();
  if (!has) return 0;
  return (sqlite.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get() as { n: number }).n;
}

function listBackups(dir: string, base: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.startsWith(`${base}.`) && f.endsWith('.bak')).sort(); // the ISO stamp sorts oldest first
}

/**
 * Copies the database with VACUUM INTO (consistent, WAL included) after an integrity check, so a damaged file never
 * rotates the good copies out. Taken before migrations; skipped when a recent copy exists, unless a migration is pending.
 */
function backupBeforeMigrations(sqlite: Database.Database, file: string, dir: string, opts: { keep: number; minIntervalMs: number; force: boolean }): void {
  const base = path.basename(file);
  const check = sqlite.pragma('quick_check', { simple: true });
  if (check !== 'ok') throw new Error(`integrity check failed (${String(check)})`);
  const existing = listBackups(dir, base);
  const newest = existing.at(-1);
  if (!opts.force && newest && Date.now() - fs.statSync(path.join(dir, newest)).mtimeMs < opts.minIntervalMs) return;
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(dir, `${base}.${stamp}.bak`);
  sqlite.prepare('VACUUM INTO ?').run(target);
  for (const old of listBackups(dir, base).slice(0, -Math.max(1, opts.keep))) fs.rmSync(path.join(dir, old), { force: true });
}

export function openDb(file: string, opts: OpenDbOptions = {}): Db {
  const folder = opts.migrationsFolder ?? DEFAULT_MIGRATIONS;
  const onDisk = file !== ':memory:';
  const existed = onDisk && fs.existsSync(file) && fs.statSync(file).size > 0;
  let sqlite: Database.Database | undefined;
  try {
    sqlite = new Database(file);
    if (onDisk) sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');

    const pending = journalEntryCount(folder) - appliedMigrationCount(sqlite);
    if (existed && opts.backupDir) {
      backupBeforeMigrations(sqlite, file, opts.backupDir, { keep: opts.backupKeep ?? BACKUP_KEEP, minIntervalMs: opts.backupMinIntervalMs ?? BACKUP_MIN_INTERVAL_MS, force: pending > 0 });
    }

    const orm = drizzle(sqlite, { schema });
    migrate(orm, { migrationsFolder: folder });
    const handle = sqlite;
    return { sqlite: handle, orm, close: () => handle.close() };
  } catch (err) {
    if (sqlite?.open) sqlite.close(); // a leaked handle keeps the file locked (even deleting it fails on Windows)
    const reason = (err as Error).message;
    const where = opts.backupDir ? ` If the file is damaged, move it aside and restore a copy from ${opts.backupDir}.` : '';
    throw new Error(`Cannot open the Studio database (${file}): ${reason}.${where} A locked file means another Studio process is still running.`, { cause: err });
  }
}

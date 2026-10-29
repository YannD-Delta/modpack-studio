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

export type OpenDbOptions = { backupDir?: string; migrationsFolder?: string };

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

export function openDb(file: string, opts: OpenDbOptions = {}): Db {
  const folder = opts.migrationsFolder ?? DEFAULT_MIGRATIONS;
  const onDisk = file !== ':memory:';
  const existed = onDisk && fs.existsSync(file) && fs.statSync(file).size > 0;

  const sqlite = new Database(file);
  if (onDisk) sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  const pending = journalEntryCount(folder) - appliedMigrationCount(sqlite);
  if (existed && pending > 0 && opts.backupDir) {
    sqlite.pragma('wal_checkpoint(TRUNCATE)');
    fs.mkdirSync(opts.backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(file, path.join(opts.backupDir, `${path.basename(file)}.${stamp}.bak`));
  }

  const orm = drizzle(sqlite, { schema });
  migrate(orm, { migrationsFolder: folder });
  return { sqlite, orm, close: () => sqlite.close() };
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BACKUP_KEEP, openDb } from '../../src/server/db/open.js';

const TABLES = ['pack_version', 'profile', 'jar', 'jar_mod', 'mod_decision', 'blacklist', 'blob', 'job', 'setting', 'audit_log', 'event', 'import_issue'];

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'db-'));
}

describe('openDb', () => {
  it('creates every table of the phase 1 schema', () => {
    const db = openDb(':memory:');
    const names = (db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
    for (const t of TABLES) expect(names).toContain(t);
    db.close();
  });

  it('enforces foreign keys', () => {
    const db = openDb(':memory:');
    const insert = () => db.sqlite.prepare("INSERT INTO profile (pack_version_id, side, state, location_kind, location) VALUES (999, 'server', 'clean', 'zip', 'x')").run();
    expect(insert).toThrow(/FOREIGN KEY/i);
    db.close();
  });

  it('uses WAL for a file database', () => {
    const dir = tmpDir();
    const db = openDb(path.join(dir, 'studio.db'));
    expect(db.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('backs the file up before applying a pending migration', () => {
    const dir = tmpDir();
    const mig = path.join(dir, 'mig');
    fs.mkdirSync(path.join(mig, 'meta'), { recursive: true });
    const journal = (n: number) => ({
      version: '7',
      dialect: 'sqlite',
      entries: Array.from({ length: n }, (_, i) => ({ idx: i, version: '6', when: 1700000000000 + i, tag: `000${i}_m`, breakpoints: true })),
    });
    fs.writeFileSync(path.join(mig, '0000_m.sql'), 'CREATE TABLE a (id integer);');
    fs.writeFileSync(path.join(mig, 'meta', '_journal.json'), JSON.stringify(journal(1)));

    const file = path.join(dir, 'studio.db');
    const backups = path.join(dir, 'backups');
    openDb(file, { migrationsFolder: mig, backupDir: backups }).close();
    expect(fs.existsSync(backups) ? fs.readdirSync(backups) : []).toEqual([]); // fresh file: nothing to protect

    fs.writeFileSync(path.join(mig, '0001_m.sql'), 'CREATE TABLE b (id integer);');
    fs.writeFileSync(path.join(mig, 'meta', '_journal.json'), JSON.stringify(journal(2)));
    const db = openDb(file, { migrationsFolder: mig, backupDir: backups });
    const tables = (db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
    expect(tables).toContain('b');
    expect(fs.readdirSync(backups).length).toBe(1);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('takes a rolling backup of an existing file at startup, even without a pending migration, and keeps only the last few', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'studio.db');
    const backups = path.join(dir, 'backups');
    openDb(file, { backupDir: backups }).close(); // fresh file: nothing to protect
    expect(fs.existsSync(backups) ? fs.readdirSync(backups) : []).toEqual([]);
    for (let i = 0; i < BACKUP_KEEP + 3; i++) openDb(file, { backupDir: backups, backupMinIntervalMs: 0 }).close();
    const kept = fs.readdirSync(backups).filter((f) => f.endsWith('.bak'));
    expect(kept.length).toBe(BACKUP_KEEP);
    // a backup is a usable database
    const copy = openDb(path.join(backups, kept[0]!), {});
    expect((copy.sqlite.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'profile'").get() as { n: number }).n).toBe(1);
    copy.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not take a second backup within the minimum interval (restart loops)', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'studio.db');
    const backups = path.join(dir, 'backups');
    openDb(file, { backupDir: backups }).close();
    openDb(file, { backupDir: backups }).close();
    openDb(file, { backupDir: backups }).close();
    expect(fs.readdirSync(backups).filter((f) => f.endsWith('.bak')).length).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('gives a readable error for a corrupt file, keeps the old backups, and releases the file', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'studio.db');
    const backups = path.join(dir, 'backups');
    openDb(file, { backupDir: backups }).close();
    openDb(file, { backupDir: backups, backupMinIntervalMs: 0 }).close();
    const before = fs.readdirSync(backups);
    fs.writeFileSync(file, 'this is not a database '.repeat(200));
    let message = '';
    try {
      openDb(file, { backupDir: backups, backupMinIntervalMs: 0 });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/Cannot open the Studio database/);
    expect(message).toContain(backups);
    expect(message.includes(String.fromCharCode(10))).toBe(false); // one readable line, no stack
    expect(fs.readdirSync(backups)).toEqual(before);
    fs.rmSync(file); // would fail with EPERM if the handle had leaked
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

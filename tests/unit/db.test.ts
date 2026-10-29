import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/server/db/open.js';

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
});

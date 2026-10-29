import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/server/db/open.js';

describe('migration 0004_user_origin', () => {
  it("renames the legacy 'yann' blacklist origin to 'user' and leaves other origins alone", () => {
    const db = openDb(':memory:');
    db.sqlite.prepare("INSERT INTO blacklist (mod_id, origin, valid_for, reason) VALUES ('old', 'yann', NULL, ''), ('derived', 'atm_derived', '8.3', '')").run();
    db.sqlite.exec(fs.readFileSync('drizzle/0004_user_origin.sql', 'utf8'));
    const rows = db.sqlite.prepare('SELECT mod_id, origin FROM blacklist ORDER BY mod_id').all();
    expect(rows).toEqual([{ mod_id: 'derived', origin: 'atm_derived' }, { mod_id: 'old', origin: 'user' }]);
    db.close();
  });
});

import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/server/db/open.js';

describe('migration 0005_upstream_names', () => {
  it('renames the legacy columns and the derived origin without losing data', () => {
    const db = openDb(':memory:');
    // Put the database back in its pre-0005 shape, with rows that carry the old names.
    db.sqlite.exec('ALTER TABLE pack_version RENAME COLUMN base_upstream_version TO base_atm_version; ALTER TABLE pack_version RENAME COLUMN own_hotfix TO lmp_hotfix');
    db.sqlite.prepare("INSERT INTO pack_version (pack, version, base_atm_version, lmp_hotfix) VALUES ('Own', '1.0', '8.3', 2)").run();
    db.sqlite.prepare("INSERT INTO blacklist (mod_id, origin, valid_for, reason) VALUES ('mine', 'user', NULL, ''), ('derived', 'atm_derived', '8.3', '')").run();

    db.sqlite.exec(fs.readFileSync('drizzle/0005_upstream_names.sql', 'utf8'));

    expect(db.sqlite.prepare('SELECT base_upstream_version AS b, own_hotfix AS h FROM pack_version').all()).toEqual([{ b: '8.3', h: 2 }]);
    expect(db.sqlite.prepare('SELECT mod_id, origin FROM blacklist ORDER BY mod_id').all()).toEqual([
      { mod_id: 'derived', origin: 'upstream_derived' },
      { mod_id: 'mine', origin: 'user' },
    ]);
    db.close();
  });
});

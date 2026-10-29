import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { audit } from '../../src/server/db/audit.js';
import { openDb, type Db } from '../../src/server/db/open.js';
import { addToBlacklist, effectiveBlacklist, getPins, recomputeAtmDerived, removeFromBlacklist, setBlacklistReason, setDecision } from '../../src/server/mods/blacklist-service.js';
import { debugInfo, listAudit, listJobs, listMemory, setDecisionReason, unsetDecision } from '../../src/server/mods/decisions-service.js';

let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
});
afterEach(() => db.close());

const auditRows = () => db.sqlite.prepare('SELECT action, target, detail FROM audit_log ORDER BY id').all() as { action: string; target: string; detail: string }[];

describe('listMemory', () => {
  it('lists every decision and only user blacklist rows, counting the ATM-derived ones', () => {
    setDecision(db, { modId: 'old', kind: 'pin', reason: 'keep 1.0' });
    setDecision(db, { modId: 'gone', kind: 'ignore', reason: 'dropped' });
    setDecision(db, { modId: 'hud', kind: 'side', side: 'client', reason: 'client only' });
    addToBlacklist(db, 'mine', 'crashes the server');
    recomputeAtmDerived(db, '8.3', ['cli1', 'cli2']);

    const m = listMemory(db);
    expect(m.decisions.map((d) => [d.modId, d.kind, d.side])).toEqual([
      ['gone', 'ignore', null],
      ['hud', 'side', 'client'],
      ['old', 'pin', null],
    ]);
    expect(m.decisions[0]!.reason).toBe('dropped');
    expect(m.decisions[0]!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(m.blacklist).toEqual([{ modId: 'mine', origin: 'user', reason: 'crashes the server', createdAt: expect.stringMatching(/^\d{4}-/) }]);
    expect(m.atmDerivedCount).toBe(2);
  });

  it('gives a null createdAt to a blacklist row that has no audit trace', () => {
    db.sqlite.prepare("INSERT INTO blacklist (mod_id, origin, valid_for, reason) VALUES ('legacy', 'user', NULL, '')").run();
    expect(listMemory(db).blacklist).toEqual([{ modId: 'legacy', origin: 'user', reason: '', createdAt: null }]);
  });
});

describe('unsetDecision', () => {
  it('removes the row, audits it and the next read no longer sees it', () => {
    setDecision(db, { modId: 'old', kind: 'pin', reason: 'keep' });
    setDecision(db, { modId: 'hud', kind: 'side', side: 'client', reason: '' });
    expect(getPins(db).has('old')).toBe(true);
    expect(effectiveBlacklist(db, '8.3').map((e) => e.modId)).toEqual(['hud']);

    expect(unsetDecision(db, 'old', 'pin')).toBe(true);
    expect(unsetDecision(db, 'hud', 'side')).toBe(true);
    expect(getPins(db).has('old')).toBe(false);
    expect(effectiveBlacklist(db, '8.3')).toEqual([]);

    const last = auditRows().filter((r) => r.action === 'decision.unset');
    expect(last.map((r) => r.target)).toEqual(['old', 'hud']);
    expect(JSON.parse(last[1]!.detail)).toMatchObject({ kind: 'side', side: 'client' });
  });

  it('returns false and audits nothing when the decision does not exist', () => {
    setDecision(db, { modId: 'old', kind: 'pin', reason: '' });
    expect(unsetDecision(db, 'old', 'ignore')).toBe(false);
    expect(unsetDecision(db, 'nope', 'pin')).toBe(false);
    expect(auditRows().filter((r) => r.action === 'decision.unset')).toEqual([]);
  });
});

describe('setDecisionReason', () => {
  it('edits the reason only and audits the old and new text', () => {
    setDecision(db, { modId: 'old', kind: 'pin', reason: 'before' });
    const createdAt = listMemory(db).decisions[0]!.createdAt;
    expect(setDecisionReason(db, 'old', 'pin', 'after')).toBe(true);
    const d = listMemory(db).decisions[0]!;
    expect(d.reason).toBe('after');
    expect(d.createdAt).toBe(createdAt);
    const row = auditRows().find((r) => r.action === 'decision.reason')!;
    expect(row.target).toBe('old');
    expect(JSON.parse(row.detail)).toEqual({ kind: 'pin', from: 'before', to: 'after' });
  });

  it('returns false for an absent decision', () => {
    expect(setDecisionReason(db, 'x', 'pin', 'y')).toBe(false);
  });
});

describe('removeFromBlacklist', () => {
  it('removes a user row, keeps an ATM-derived row of the same id, and audits', () => {
    recomputeAtmDerived(db, '8.3', ['both']);
    addToBlacklist(db, 'both', 'mine too');
    addToBlacklist(db, 'mine', '');
    expect(removeFromBlacklist(db, 'mine')).toBe('removed');
    expect(removeFromBlacklist(db, 'both')).toBe('removed');
    expect(effectiveBlacklist(db, '8.3')).toEqual([{ modId: 'both', origin: 'atm_derived', stale: false }]);
    expect(auditRows().filter((r) => r.action === 'blacklist.remove').map((r) => r.target)).toEqual(['mine', 'both']);
  });

  it('refuses an ATM-derived row and reports an absent one', () => {
    recomputeAtmDerived(db, '8.3', ['cli']);
    expect(removeFromBlacklist(db, 'cli')).toBe('atm_derived');
    expect(removeFromBlacklist(db, 'nope')).toBe('absent');
    expect(effectiveBlacklist(db, '8.3').map((e) => e.modId)).toEqual(['cli']);
    expect(auditRows().filter((r) => r.action === 'blacklist.remove')).toEqual([]);
  });
});

describe('setBlacklistReason', () => {
  it("edits only the user's row, keeps its date and audits", () => {
    recomputeAtmDerived(db, '8.3', ['cli']);
    addToBlacklist(db, 'mine', 'before');
    const createdAt = listMemory(db).blacklist[0]!.createdAt;
    expect(setBlacklistReason(db, 'mine', 'after')).toBe('updated');
    expect(listMemory(db).blacklist).toEqual([{ modId: 'mine', origin: 'user', reason: 'after', createdAt }]);
    expect(setBlacklistReason(db, 'cli', 'x')).toBe('atm_derived');
    expect(setBlacklistReason(db, 'nope', 'x')).toBe('absent');
    const rows = auditRows().filter((r) => r.action === 'blacklist.reason');
    expect(rows.map((r) => [r.target, JSON.parse(r.detail)])).toEqual([['mine', { from: 'before', to: 'after' }]]);
  });
});

describe('listAudit', () => {
  beforeEach(() => {
    for (let i = 1; i <= 7; i++) audit(db, i % 2 ? 'decision.set' : 'blacklist.add', `mod${i}`, { n: i });
    db.sqlite.prepare("INSERT INTO audit_log (at, actor, action, target, detail) VALUES ('2026-01-01T00:00:00.000Z', 'user', 'broken', 'zzz', '{not json')").run();
  });

  it('returns rows newest first, parses the payload and survives a bad one', () => {
    const page = listAudit(db, { limit: 3 });
    expect(page.entries.map((e) => e.target)).toEqual(['zzz', 'mod7', 'mod6']);
    expect(page.entries[0]).toMatchObject({ action: 'broken', payload: '{not json', payloadValid: false });
    expect(page.entries[1]).toMatchObject({ action: 'decision.set', actor: 'user', payload: { n: 7 }, payloadValid: true });
    expect(page.nextBefore).toBe(page.entries[2]!.id);
  });

  it('pages with before and stops with a null cursor', () => {
    const first = listAudit(db, { limit: 5 });
    const second = listAudit(db, { limit: 5, before: first.nextBefore! });
    expect(second.entries.map((e) => e.target)).toEqual(['mod3', 'mod2', 'mod1']);
    expect(second.nextBefore).toBeNull();
  });

  it('filters on action, target or payload text, literally', () => {
    expect(listAudit(db, { limit: 100, q: 'blacklist' }).entries.map((e) => e.target)).toEqual(['mod6', 'mod4', 'mod2']);
    expect(listAudit(db, { limit: 100, q: 'mod5' }).entries.map((e) => e.target)).toEqual(['mod5']);
    expect(listAudit(db, { limit: 100, q: '"n":3' }).entries.map((e) => e.target)).toEqual(['mod3']);
    expect(listAudit(db, { limit: 100, q: '%' }).entries).toEqual([]);
  });

  it('keeps a null payload as null', () => {
    db.sqlite.prepare("INSERT INTO audit_log (at, actor, action, target, detail) VALUES ('2026-01-02T00:00:00.000Z', 'system', 'boot', NULL, NULL)").run();
    expect(listAudit(db, { limit: 1 }).entries[0]).toMatchObject({ action: 'boot', target: null, payload: null, payloadValid: true });
  });
});

describe('listJobs', () => {
  const insert = (id: string, status: string, params: string, created: string) =>
    db.sqlite
      .prepare('INSERT INTO job (id, type, params, status, progress, message, lock_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, 'import', params, status, status === 'done' ? 100 : null, status === 'failed' ? 'boom: bad jar' : null, 'profile:1', created, created);

  it('lists jobs newest first, filters on status and caps the params text', () => {
    insert('a', 'done', '{"path":"x"}', '2026-01-01T00:00:00.000Z');
    insert('b', 'failed', JSON.stringify({ blob: 'y'.repeat(5000) }), '2026-01-02T00:00:00.000Z');
    insert('c', 'running', 'null', '2026-01-03T00:00:00.000Z');

    const all = listJobs(db, { limit: 50 });
    expect(all.map((j) => j.id)).toEqual(['c', 'b', 'a']);
    expect(all[2]).toEqual({ id: 'a', type: 'import', status: 'done', progress: 100, message: null, lockKey: 'profile:1', params: '{"path":"x"}', paramsTruncated: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
    expect(all[1]!.params.length).toBe(2000);
    expect(all[1]!.paramsTruncated).toBe(true);

    expect(listJobs(db, { limit: 50, status: 'failed' }).map((j) => [j.id, j.message])).toEqual([['b', 'boom: bad jar']]);
    expect(listJobs(db, { limit: 1 }).map((j) => j.id)).toEqual(['c']);
  });
});

describe('debugInfo', () => {
  it('reports versions, counts and paths without any config', () => {
    setDecision(db, { modId: 'old', kind: 'pin', reason: '' });
    setDecision(db, { modId: 'hud', kind: 'side', side: 'client', reason: '' });
    addToBlacklist(db, 'mine', '');
    recomputeAtmDerived(db, '8.3', ['cli']);
    db.sqlite.prepare("INSERT INTO job (id, type, params, status, created_at, updated_at) VALUES ('j1', 'import', 'null', 'failed', 't', 't'), ('j2', 'import', 'null', 'done', 't', 't'), ('j3', 'import', 'null', 'done', 't', 't')").run();

    const info = debugInfo(db, { dataDir: 'some-data' });
    expect(info.node).toBe(process.version);
    expect(info.platform).toBe(`${process.platform} ${process.arch}`);
    expect(info.studioVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(info.dataDir).toBe(path.resolve('some-data'));
    expect(info.db.file).toBeNull();
    expect(info.db.sizeBytes).toBeNull();
    expect(info.db.migrations).toBeGreaterThanOrEqual(1);
    expect(info.counts.decisions).toEqual({ pin: 1, ignore: 0, side: 1 });
    expect(info.counts.blacklist).toEqual({ user: 1, atmDerived: 1 });
    expect(info.counts.jobs).toEqual({ queued: 0, running: 0, done: 2, failed: 1, cancelled: 0, interrupted: 0 });
    expect(info.counts.profiles).toBe(0);
    expect(info.counts.jars).toBe(0);
    expect(info.counts.modRows).toBe(0);
    expect(info.counts.auditEntries).toBeGreaterThan(0);
    expect(info.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('reports the size of an on-disk database', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbg-'));
    const disk = openDb(path.join(dir, 'studio.db'));
    try {
      const info = debugInfo(disk, { dataDir: dir });
      expect(info.db.file).toBe(path.join(dir, 'studio.db'));
      expect(info.db.sizeBytes).toBeGreaterThan(0);
    } finally {
      disk.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

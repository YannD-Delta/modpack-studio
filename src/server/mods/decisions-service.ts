import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { audit } from '../db/audit.js';
import type { Db } from '../db/open.js';
import type { JobStatus } from '../jobs/runner.js';
import type { Side } from './side-classifier.js';

export const DECISION_KINDS = ['side', 'pin', 'ignore'] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];
export const JOB_STATUSES = ['queued', 'running', 'done', 'failed', 'cancelled', 'interrupted'] as const satisfies readonly JobStatus[];

export type DecisionRow = { modId: string; kind: DecisionKind; side: Side | null; reason: string; createdAt: string };
export type UserBlacklistRow = { modId: string; origin: 'yann'; reason: string; createdAt: string | null };
export type Memory = { decisions: DecisionRow[]; blacklist: UserBlacklistRow[]; atmDerivedCount: number };

/** Everything Studio remembers on the user's behalf. ATM-derived blacklist rows are computed, so they are only counted. */
export function listMemory(db: Db): Memory {
  const decisions = (
    db.sqlite.prepare('SELECT mod_id, kind, side, reason, created_at FROM mod_decision ORDER BY mod_id, kind').all() as {
      mod_id: string;
      kind: DecisionKind;
      side: Side | null;
      reason: string;
      created_at: string;
    }[]
  ).map((r) => ({ modId: r.mod_id, kind: r.kind, side: r.side, reason: r.reason, createdAt: r.created_at }));

  // The blacklist table has no timestamp: the date shown is the last 'blacklist.add' audit entry for that id, when there is one.
  const blacklist = (
    db.sqlite
      .prepare(
        `SELECT b.mod_id, b.reason,
           (SELECT max(a.at) FROM audit_log a WHERE a.action = 'blacklist.add' AND a.target = b.mod_id) AS created_at
         FROM blacklist b WHERE b.origin = 'yann' ORDER BY b.mod_id`,
      )
      .all() as { mod_id: string; reason: string; created_at: string | null }[]
  ).map((r) => ({ modId: r.mod_id, origin: 'yann' as const, reason: r.reason, createdAt: r.created_at }));

  const { n } = db.sqlite.prepare("SELECT count(*) AS n FROM blacklist WHERE origin = 'atm_derived'").get() as { n: number };
  return { decisions, blacklist, atmDerivedCount: n };
}

type RawDecision = { side: Side | null; reason: string; created_at: string };
const findDecision = (db: Db, modId: string, kind: DecisionKind) =>
  db.sqlite.prepare('SELECT side, reason, created_at FROM mod_decision WHERE mod_id = ? AND kind = ?').get(modId, kind) as RawDecision | undefined;

/** Forgets a decision; the diff and the blacklist read the table on every request, so the undo applies at once. False when absent. */
export function unsetDecision(db: Db, modId: string, kind: DecisionKind): boolean {
  return db.sqlite.transaction(() => {
    const row = findDecision(db, modId, kind);
    if (!row) return false;
    db.sqlite.prepare('DELETE FROM mod_decision WHERE mod_id = ? AND kind = ?').run(modId, kind);
    audit(db, 'decision.unset', modId, { kind, side: row.side, reason: row.reason, createdAt: row.created_at });
    return true;
  })();
}

/** Edits the free-text reason of a decision without touching its date. False when absent. */
export function setDecisionReason(db: Db, modId: string, kind: DecisionKind, reason: string): boolean {
  return db.sqlite.transaction(() => {
    const row = findDecision(db, modId, kind);
    if (!row) return false;
    db.sqlite.prepare('UPDATE mod_decision SET reason = ? WHERE mod_id = ? AND kind = ?').run(reason, modId, kind);
    audit(db, 'decision.reason', modId, { kind, from: row.reason, to: reason });
    return true;
  })();
}

export type AuditEntry = { id: number; at: string; actor: string; action: string; target: string | null; payload: unknown; payloadValid: boolean };
export type AuditPage = { entries: AuditEntry[]; nextBefore: number | null };

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function parsePayload(detail: string | null): { payload: unknown; payloadValid: boolean } {
  if (detail === null) return { payload: null, payloadValid: true };
  try {
    return { payload: JSON.parse(detail), payloadValid: true };
  } catch {
    return { payload: detail, payloadValid: false };
  }
}

/** Audit rows newest first. `before` is an exclusive id cursor; `q` is a literal substring searched in action, target and payload. */
export function listAudit(db: Db, opts: { limit: number; before?: number; q?: string }): AuditPage {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (opts.before !== undefined) {
    where.push('id < ?');
    args.push(opts.before);
  }
  if (opts.q) {
    const like = `%${escapeLike(opts.q)}%`;
    where.push("(action LIKE ? ESCAPE '\\' OR coalesce(target, '') LIKE ? ESCAPE '\\' OR coalesce(detail, '') LIKE ? ESCAPE '\\')");
    args.push(like, like, like);
  }
  // One extra row tells whether another page exists.
  const rows = db.sqlite
    .prepare(`SELECT id, at, actor, action, target, detail FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`)
    .all(...args, opts.limit + 1) as { id: number; at: string; actor: string; action: string; target: string | null; detail: string | null }[];
  const page = rows.slice(0, opts.limit);
  return {
    entries: page.map((r) => ({ id: r.id, at: r.at, actor: r.actor, action: r.action, target: r.target, ...parsePayload(r.detail) })),
    nextBefore: rows.length > opts.limit ? page[page.length - 1]!.id : null,
  };
}

export const JOB_PARAMS_MAX = 2000;
export type JobRow = {
  id: string;
  type: string;
  status: JobStatus;
  progress: number | null;
  message: string | null;
  lockKey: string | null;
  params: string;
  paramsTruncated: boolean;
  createdAt: string;
  updatedAt: string;
};

/** Jobs newest first; the params JSON text is capped so a huge payload cannot flood the page. */
export function listJobs(db: Db, opts: { limit: number; status?: JobStatus }): JobRow[] {
  const rows = db.sqlite
    .prepare(
      `SELECT id, type, status, progress, message, lock_key, params, created_at, updated_at FROM job
       ${opts.status ? 'WHERE status = ?' : ''} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(...(opts.status ? [opts.status] : []), opts.limit) as {
    id: string;
    type: string;
    status: JobStatus;
    progress: number | null;
    message: string | null;
    lock_key: string | null;
    params: string;
    created_at: string;
    updated_at: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    status: r.status,
    progress: r.progress,
    message: r.message,
    lockKey: r.lock_key,
    params: r.params.slice(0, JOB_PARAMS_MAX),
    paramsTruncated: r.params.length > JOB_PARAMS_MAX,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export type DebugInfo = {
  studioVersion: string;
  node: string;
  platform: string;
  uptimeSeconds: number;
  dataDir: string;
  db: { file: string | null; sizeBytes: number | null; migrations: number };
  counts: {
    profiles: number;
    jars: number;
    modRows: number;
    decisions: Record<DecisionKind, number>;
    blacklist: { yann: number; atmDerived: number };
    jobs: Record<JobStatus, number>;
    auditEntries: number;
  };
};

const PACKAGE_JSON = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../package.json');

function studioVersion(): string {
  try {
    return String((JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8')) as { version?: unknown }).version ?? 'unknown');
  } catch {
    return 'unknown';
  }
}

const fileSize = (file: string) => (fs.existsSync(file) ? fs.statSync(file).size : 0);

/** Facts for troubleshooting. Built from the database and the process only: no config, so no password hash, session or host list. */
export function debugInfo(db: Db, opts: { dataDir: string }): DebugInfo {
  const count = (sql: string) => (db.sqlite.prepare(sql).get() as { n: number }).n;
  const main = (db.sqlite.prepare('PRAGMA database_list').all() as { name: string; file: string }[]).find((d) => d.name === 'main');
  const file = main?.file ? main.file : null;
  const hasMigrations = db.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name = '__drizzle_migrations'").get();

  const decisions = Object.fromEntries(DECISION_KINDS.map((k) => [k, 0])) as Record<DecisionKind, number>;
  for (const r of db.sqlite.prepare('SELECT kind, count(*) AS n FROM mod_decision GROUP BY kind').all() as { kind: string; n: number }[]) {
    if (r.kind in decisions) decisions[r.kind as DecisionKind] = r.n;
  }
  const jobs = Object.fromEntries(JOB_STATUSES.map((s) => [s, 0])) as Record<JobStatus, number>;
  for (const r of db.sqlite.prepare('SELECT status, count(*) AS n FROM job GROUP BY status').all() as { status: string; n: number }[]) {
    if (r.status in jobs) jobs[r.status as JobStatus] = r.n;
  }

  return {
    studioVersion: studioVersion(),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    uptimeSeconds: Math.round(process.uptime()),
    dataDir: path.resolve(opts.dataDir),
    db: {
      file,
      // WAL mode keeps recent writes in the -wal file, so it counts towards the real size on disk.
      sizeBytes: file ? fileSize(file) + fileSize(`${file}-wal`) : null,
      migrations: hasMigrations ? count('SELECT count(*) AS n FROM __drizzle_migrations') : 0,
    },
    counts: {
      profiles: count('SELECT count(*) AS n FROM profile'),
      jars: count('SELECT count(*) AS n FROM jar'),
      modRows: count('SELECT count(*) AS n FROM jar_mod'),
      decisions,
      blacklist: {
        yann: count("SELECT count(*) AS n FROM blacklist WHERE origin = 'yann'"),
        atmDerived: count("SELECT count(*) AS n FROM blacklist WHERE origin = 'atm_derived'"),
      },
      jobs,
      auditEntries: count('SELECT count(*) AS n FROM audit_log'),
    },
  };
}

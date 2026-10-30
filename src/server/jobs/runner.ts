import crypto from 'node:crypto';
import type { Db } from '../db/open.js';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';

export interface JobEvent {
  id: string;
  type: string;
  status: JobStatus;
  progress?: number;
  message?: string;
}

export interface JobContext {
  params: unknown;
  signal: AbortSignal;
  progress(pct: number, msg?: string): void;
}

type JobHandler = (ctx: JobContext) => Promise<unknown>;
type Meta = { type: string; params: unknown; lockKey?: string };

/**
 * Persisted job queue: per-resource locks, cancellation, and `interrupted` marking after a restart.
 * Database writes for status and progress never throw into the job machinery: a busy or full database is logged and the in-memory state stays right.
 */
export class JobRunner {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly meta = new Map<string, Meta>();
  private readonly queue: string[] = [];
  private readonly running = new Map<string, AbortController>();
  private readonly locks = new Set<string>();
  private readonly listeners = new Set<(e: JobEvent) => void>();
  private readonly createdAt = new Date().toISOString();

  constructor(
    private readonly db: Db,
    private readonly concurrency = 4,
  ) {}

  /**
   * Marks the jobs a dead process left queued or running as `interrupted`; returns how many.
   * Call it once, after the port is bound: a second Studio process that fails to listen must not touch the first one's live jobs.
   * Jobs enqueued since this runner was built are its own and are left alone.
   */
  recoverInterrupted(): number {
    return this.db.sqlite.prepare("UPDATE job SET status = 'interrupted', updated_at = ? WHERE status IN ('queued', 'running') AND created_at < ?").run(new Date().toISOString(), this.createdAt).changes;
  }

  register(type: string, fn: JobHandler): void {
    this.handlers.set(type, fn);
  }

  on(listener: (e: JobEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  enqueue(type: string, params: unknown, opts: { lockKey?: string } = {}): string {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.sqlite
      .prepare('INSERT INTO job (id, type, params, status, lock_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, type, JSON.stringify(params ?? null), 'queued', opts.lockKey ?? null, now, now);
    this.meta.set(id, { type, params, lockKey: opts.lockKey });
    this.queue.push(id);
    this.emit({ id, type, status: 'queued' });
    setImmediate(() => this.pump());
    return id;
  }

  cancel(id: string): void {
    const ctrl = this.running.get(id);
    if (ctrl) {
      ctrl.abort();
      return;
    }
    const idx = this.queue.indexOf(id);
    if (idx >= 0) {
      this.queue.splice(idx, 1);
      this.finish(id, 'cancelled');
      this.meta.delete(id); // after finish(): it reads the type for the event
    }
  }

  private emit(e: JobEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch (err) {
        console.error(`job listener failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Runs a job-row update; a failure (database busy or full) is logged, never thrown. */
  private persist(sql: string, ...params: unknown[]): void {
    try {
      this.db.sqlite.prepare(sql).run(...params);
    } catch (err) {
      console.error(`job row not updated: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private finish(id: string, status: JobStatus, message?: string): void {
    const type = this.meta.get(id)?.type ?? '';
    this.persist('UPDATE job SET status = ?, message = COALESCE(?, message), updated_at = ? WHERE id = ?', status, message ?? null, new Date().toISOString(), id);
    this.emit({ id, type, status, message });
  }

  private pump(): void {
    while (this.running.size < this.concurrency) {
      const idx = this.queue.findIndex((id) => {
        const key = this.meta.get(id)?.lockKey;
        return !key || !this.locks.has(key);
      });
      if (idx < 0) return;
      const [id] = this.queue.splice(idx, 1);
      if (id) void this.start(id).catch((err) => console.error(`job ${id} crashed: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  private async start(id: string): Promise<void> {
    const meta = this.meta.get(id)!;
    const ctrl = new AbortController();
    this.running.set(id, ctrl);
    if (meta.lockKey) this.locks.add(meta.lockKey);
    try {
      this.finish(id, 'running');
      const handler = this.handlers.get(meta.type);
      if (!handler) throw new Error(`no handler registered for job type ${meta.type}`);
      await handler({
        params: meta.params,
        signal: ctrl.signal,
        progress: (pct, msg) => {
          this.persist('UPDATE job SET progress = ?, message = COALESCE(?, message), updated_at = ? WHERE id = ?', pct, msg ?? null, new Date().toISOString(), id);
          this.emit({ id, type: meta.type, status: 'running', progress: pct, message: msg });
        },
      });
      this.finish(id, 'done'); // a handler that returned has finished its work, even if cancel arrived too late to stop it
    } catch (err) {
      if (ctrl.signal.aborted) this.finish(id, 'cancelled');
      else this.finish(id, 'failed', err instanceof Error ? err.message : String(err));
    } finally {
      this.running.delete(id);
      if (meta.lockKey) this.locks.delete(meta.lockKey);
      this.meta.delete(id);
      this.pump();
    }
  }
}

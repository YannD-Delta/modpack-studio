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

/** Persisted job queue: per-resource locks, cancellation, and `interrupted` marking after a restart. */
export class JobRunner {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly meta = new Map<string, Meta>();
  private readonly queue: string[] = [];
  private readonly running = new Map<string, AbortController>();
  private readonly locks = new Set<string>();
  private readonly listeners = new Set<(e: JobEvent) => void>();

  constructor(
    private readonly db: Db,
    private readonly concurrency = 4,
  ) {
    db.sqlite.prepare("UPDATE job SET status = 'interrupted', updated_at = ? WHERE status IN ('queued', 'running')").run(new Date().toISOString());
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
    }
  }

  private emit(e: JobEvent): void {
    for (const l of this.listeners) l(e);
  }

  private finish(id: string, status: JobStatus, message?: string): void {
    const type = this.meta.get(id)?.type ?? '';
    this.db.sqlite.prepare('UPDATE job SET status = ?, message = COALESCE(?, message), updated_at = ? WHERE id = ?').run(status, message ?? null, new Date().toISOString(), id);
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
      if (id) void this.start(id);
    }
  }

  private async start(id: string): Promise<void> {
    const meta = this.meta.get(id)!;
    const handler = this.handlers.get(meta.type);
    const ctrl = new AbortController();
    this.running.set(id, ctrl);
    if (meta.lockKey) this.locks.add(meta.lockKey);
    this.finish(id, 'running');
    try {
      if (!handler) throw new Error(`no handler registered for job type ${meta.type}`);
      await handler({
        params: meta.params,
        signal: ctrl.signal,
        progress: (pct, msg) => {
          this.db.sqlite.prepare('UPDATE job SET progress = ?, message = COALESCE(?, message), updated_at = ? WHERE id = ?').run(pct, msg ?? null, new Date().toISOString(), id);
          this.emit({ id, type: meta.type, status: 'running', progress: pct, message: msg });
        },
      });
      this.finish(id, ctrl.signal.aborted ? 'cancelled' : 'done');
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

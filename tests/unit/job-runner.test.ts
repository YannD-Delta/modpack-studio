import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../../src/server/db/open.js';
import { JobRunner, type JobEvent } from '../../src/server/jobs/runner.js';

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

let db: Db;
let runner: JobRunner;
beforeEach(() => {
  db = openDb(':memory:');
  runner = new JobRunner(db);
});

const statusOf = (id: string) => (db.sqlite.prepare('SELECT status FROM job WHERE id = ?').get(id) as { status: string }).status;

describe('JobRunner', () => {
  it('never overlaps two jobs that share a lockKey', async () => {
    const log: string[] = [];
    const gate = deferred();
    runner.register('slow', async (ctx) => {
      const name = (ctx.params as { name: string }).name;
      log.push(`start ${name}`);
      if (name === 'a') await gate.promise;
      log.push(`end ${name}`);
    });
    runner.enqueue('slow', { name: 'a' }, { lockKey: 'server-pack' });
    runner.enqueue('slow', { name: 'b' }, { lockKey: 'server-pack' });
    await tick();
    expect(log).toEqual(['start a']);
    gate.resolve();
    await tick();
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b']);
  });

  it('cancel aborts the signal and ends in cancelled', async () => {
    runner.register('wait', (ctx) => new Promise((_, reject) => ctx.signal.addEventListener('abort', () => reject(new Error('aborted')))));
    const id = runner.enqueue('wait', null);
    await tick();
    expect(statusOf(id)).toBe('running');
    runner.cancel(id);
    await tick();
    expect(statusOf(id)).toBe('cancelled');
  });

  it('does not touch live jobs when a runner is built; recoverInterrupted marks the ones left by a dead process', async () => {
    runner.register('hang', () => new Promise(() => undefined));
    const id = runner.enqueue('hang', null);
    await tick();
    expect(statusOf(id)).toBe('running');
    const second = new JobRunner(db); // a second Studio process on the same database must not disturb the first one
    expect(statusOf(id)).toBe('running');
    expect(second.recoverInterrupted()).toBe(1); // simulated restart, run once the port is bound
    expect(statusOf(id)).toBe('interrupted');
  });

  it('emits queued, running, progress, done in order', async () => {
    const events: string[] = [];
    runner.on((e: JobEvent) => events.push(e.progress !== undefined ? `${e.status}:progress` : e.status));
    runner.register('work', async (ctx) => ctx.progress(50, 'half'));
    runner.enqueue('work', null);
    await tick();
    expect(events).toEqual(['queued', 'running', 'running:progress', 'done']);
  });

  it('records a thrown error as failed with its message', async () => {
    runner.register('bad', async () => {
      throw new Error('nope');
    });
    const id = runner.enqueue('bad', null);
    await tick();
    const row = db.sqlite.prepare('SELECT status, message FROM job WHERE id = ?').get(id) as { status: string; message: string };
    expect(row).toEqual({ status: 'failed', message: 'nope' });
  });

  it('survives a failed status write: no unhandled rejection, lock and slot released, the next job runs', async () => {
    const events: string[] = [];
    runner.on((e) => events.push(e.status));
    runner.register('work', async () => undefined);
    const realPrepare = db.sqlite.prepare.bind(db.sqlite);
    const spy = vi.spyOn(db.sqlite, 'prepare').mockImplementation(((sql: string) => {
      if (/^UPDATE job SET status/.test(sql)) throw new Error('SQLITE_BUSY: database is locked');
      return realPrepare(sql);
    }) as typeof db.sqlite.prepare);
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    runner.enqueue('work', null, { lockKey: 'k' });
    await tick(50);
    expect(events).toEqual(['queued', 'running', 'done']);
    expect((runner as unknown as { running: Map<string, unknown> }).running.size).toBe(0);
    expect((runner as unknown as { locks: Set<string> }).locks.size).toBe(0);
    spy.mockRestore();
    quiet.mockRestore();
    const next = runner.enqueue('work', null, { lockKey: 'k' });
    await tick(50);
    expect(statusOf(next)).toBe('done');
  });

  it('releases the lock and the slot when a job type has no handler', async () => {
    const id = runner.enqueue('nobody', null, { lockKey: 'k' });
    await tick();
    expect(statusOf(id)).toBe('failed');
    expect((runner as unknown as { locks: Set<string> }).locks.size).toBe(0);
    expect((runner as unknown as { running: Map<string, unknown> }).running.size).toBe(0);
  });

  it('cancelling a queued job cleans its metadata', async () => {
    const gate = deferred();
    runner.register('slow', () => gate.promise);
    runner.enqueue('slow', null, { lockKey: 'k' });
    const queued = runner.enqueue('slow', null, { lockKey: 'k' });
    await tick();
    runner.cancel(queued);
    expect(statusOf(queued)).toBe('cancelled');
    gate.resolve();
    await tick();
    expect((runner as unknown as { meta: Map<string, unknown> }).meta.size).toBe(0);
  });

  it('records finished work as done even when cancel arrived too late to stop it', async () => {
    const gate = deferred();
    runner.register('stubborn', () => gate.promise); // ignores the signal and completes
    const id = runner.enqueue('stubborn', null);
    await tick();
    runner.cancel(id);
    gate.resolve();
    await tick();
    expect(statusOf(id)).toBe('done');
  });
});

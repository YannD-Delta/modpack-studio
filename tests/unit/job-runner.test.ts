import { beforeEach, describe, expect, it } from 'vitest';
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

  it('marks a job left running in the database as interrupted when a new runner starts', async () => {
    runner.register('hang', () => new Promise(() => undefined));
    const id = runner.enqueue('hang', null);
    await tick();
    expect(statusOf(id)).toBe('running');
    new JobRunner(db); // simulated restart on the same database
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
});

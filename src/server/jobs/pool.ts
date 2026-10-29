import { Piscina } from 'piscina';

let pool: Piscina | null = null;

function getPool(): Piscina {
  pool ??= new Piscina({ filename: new URL('./worker.mjs', import.meta.url).href });
  return pool;
}

/** Runs a CPU-bound task (see worker.mjs) in a worker thread. */
export function runInPool<T>(task: string, payload: unknown): Promise<T> {
  return getPool().run({ task, payload }) as Promise<T>;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.close();
    pool = null;
  }
}

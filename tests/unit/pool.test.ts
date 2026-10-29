import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { closePool, runInPool } from '../../src/server/jobs/pool.js';

afterAll(() => closePool());

describe('runInPool', () => {
  it('hashes a file in a worker thread', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-'));
    const file = path.join(dir, 'a.bin');
    fs.writeFileSync(file, 'hello pool');
    const expected = crypto.createHash('sha256').update('hello pool').digest('hex');
    expect(await runInPool<{ sha256: string; size: number }>('sha256-file', { path: file })).toEqual({ sha256: expected, size: 10 });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects an unknown task', async () => {
    await expect(runInPool('nope', {})).rejects.toThrow(/unknown task/i);
  });
});

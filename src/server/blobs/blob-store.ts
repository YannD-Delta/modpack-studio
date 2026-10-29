import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Db } from '../db/open.js';

const RENAME_RETRIES = 3;

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= RENAME_RETRIES || (code !== 'EPERM' && code !== 'EBUSY')) throw err;
      await new Promise((r) => setTimeout(r, 50 * attempt));
    }
  }
}

/** Content-addressed, reference-counted blob store: files on disk (`dir/ab/<sha256>`), counters in SQLite. */
export class BlobStore {
  constructor(
    private readonly dir: string,
    private readonly db: Db,
  ) {
    fs.mkdirSync(dir, { recursive: true });
  }

  private pathFor(sha256: string): string {
    return path.join(this.dir, sha256.slice(0, 2), sha256);
  }

  async put(data: Buffer | NodeJS.ReadableStream): Promise<{ sha256: string; size: number }> {
    const tmp = path.join(this.dir, `.tmp-${crypto.randomUUID()}`);
    const hash = crypto.createHash('sha256');
    let size = 0;
    const source = Buffer.isBuffer(data) ? Readable.from([data]) : (data as Readable);
    try {
      source.on('data', (chunk: Buffer) => {
        hash.update(chunk);
        size += chunk.length;
      });
      await pipeline(source, fs.createWriteStream(tmp));
      const handle = await fsp.open(tmp, 'r+');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (err) {
      await fsp.rm(tmp, { force: true });
      throw err;
    }

    const sha256 = hash.digest('hex');
    const target = this.pathFor(sha256);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    if (fs.existsSync(target)) await fsp.rm(tmp, { force: true });
    else await renameWithRetry(tmp, target);
    this.db.sqlite.prepare('INSERT INTO blob (sha256, size, refs) VALUES (?, ?, 0) ON CONFLICT(sha256) DO NOTHING').run(sha256, size);
    return { sha256, size };
  }

  get(sha256: string): NodeJS.ReadableStream {
    return fs.createReadStream(this.pathFor(sha256));
  }

  has(sha256: string): boolean {
    const row = this.db.sqlite.prepare('SELECT 1 FROM blob WHERE sha256 = ?').get(sha256);
    return !!row && fs.existsSync(this.pathFor(sha256));
  }

  ref(sha256: string): void {
    const r = this.db.sqlite.prepare('UPDATE blob SET refs = refs + 1 WHERE sha256 = ?').run(sha256);
    if (r.changes === 0) throw new Error(`unknown blob: ${sha256}`);
  }

  unref(sha256: string): void {
    this.db.sqlite.prepare('UPDATE blob SET refs = MAX(refs - 1, 0) WHERE sha256 = ?').run(sha256);
  }

  /** Deletes every blob nobody references; returns how many were removed. */
  async gc(): Promise<number> {
    const rows = this.db.sqlite.prepare('SELECT sha256 FROM blob WHERE refs <= 0').all() as { sha256: string }[];
    for (const { sha256 } of rows) {
      await fsp.rm(this.pathFor(sha256), { force: true });
      this.db.sqlite.prepare('DELETE FROM blob WHERE sha256 = ?').run(sha256);
    }
    return rows.length;
  }

  async verify(sha256: string): Promise<boolean> {
    const file = this.pathFor(sha256);
    if (!fs.existsSync(file)) return false;
    const hash = crypto.createHash('sha256');
    await pipeline(fs.createReadStream(file), hash);
    return hash.digest('hex') === sha256;
  }
}

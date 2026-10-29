import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BlobStore } from '../../src/server/blobs/blob-store.js';
import { openDb, type Db } from '../../src/server/db/open.js';

let dir: string;
let db: Db;
let store: BlobStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blobs-'));
  db = openDb(':memory:');
  store = new BlobStore(dir, db);
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const files = () => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile());

describe('BlobStore', () => {
  it('stores identical content once', async () => {
    const a = await store.put(Buffer.from('same'));
    const b = await store.put(Buffer.from('same'));
    expect(a).toEqual(b);
    expect(files().length).toBe(1);
  });

  it('lays files out as dir/<first two hex>/<sha256>', async () => {
    const { sha256 } = await store.put(Buffer.from('layout'));
    expect(fs.existsSync(path.join(dir, sha256.slice(0, 2), sha256))).toBe(true);
    expect(sha256).toBe(sha(Buffer.from('layout')));
  });

  it('hashes a stream like a buffer', async () => {
    const viaStream = await store.put(Readable.from([Buffer.from('ab'), Buffer.from('cd')]));
    expect(viaStream.sha256).toBe(sha(Buffer.from('abcd')));
    expect(viaStream.size).toBe(4);
  });

  it('gc removes only unreferenced blobs', async () => {
    const keep = await store.put(Buffer.from('keep'));
    const drop = await store.put(Buffer.from('drop'));
    store.ref(keep.sha256);
    store.ref(drop.sha256);
    store.unref(drop.sha256);
    expect(await store.gc()).toBe(1);
    expect(store.has(drop.sha256)).toBe(false);
    expect(store.has(keep.sha256)).toBe(true);
  });

  it('leaves no file behind when the source stream fails', async () => {
    const failing = new Readable({
      read() {
        this.push(Buffer.from('partial'));
        this.destroy(new Error('boom'));
      },
    });
    await expect(store.put(failing)).rejects.toThrow('boom');
    expect(files().length).toBe(0);
  });

  it('verify detects a tampered file', async () => {
    const { sha256 } = await store.put(Buffer.from('original'));
    expect(await store.verify(sha256)).toBe(true);
    fs.writeFileSync(path.join(dir, sha256.slice(0, 2), sha256), 'tampered');
    expect(await store.verify(sha256)).toBe(false);
  });

  it('refuses to ref an unknown blob', () => {
    expect(() => store.ref('0'.repeat(64))).toThrow();
  });
});

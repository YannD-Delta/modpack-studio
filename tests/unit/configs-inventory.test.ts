import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { needsScan, readInventoryCache, writeInventoryCache } from '../../src/server/configs/inventory-cache.js';
import { isExcludedPath, scanInstanceTree, detectZipPrefix } from '../../src/server/configs/inventory.js';
import { buildZip } from '../fixtures-gen/zip.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-inv-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const sha = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('hex');
function put(root: string, rel: string, content: string | Buffer) {
  const full = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe('isExcludedPath', () => {
  it('drops backups, temp files, logs, OS junk and cache dirs', () => {
    for (const p of ['config/a.toml.bak', 'config/a.tmp', 'config/x.LOG', 'config/Thumbs.db', 'kubejs/.DS_Store', 'config/logs/a.txt', 'kubejs/.cache/x.js', 'config/mod/cache/c.json']) {
      expect(isExcludedPath(p), p).toBe(true);
    }
    for (const p of ['config/a.toml', 'kubejs/server_scripts/a.js', 'config/backup.toml', 'config/catalogue.json']) expect(isExcludedPath(p), p).toBe(false);
  });
});

describe('scanInstanceTree (folder)', () => {
  it('hashes tracked roots only, skips exclusions and untracked folders', async () => {
    put(tmp, 'config/atm.toml', 'welcome = true\n');
    put(tmp, 'config/atm.toml.bak', 'old\n');
    put(tmp, 'config/sub/deep/x.json', '{"a":1}');
    put(tmp, 'config/logs/l.txt', 'nope');
    put(tmp, 'kubejs/server_scripts/a.js', '// hi\n');
    put(tmp, 'defaultconfigs/d.toml', 'x = 1\n');
    put(tmp, 'mods/a.jar', 'jar');
    put(tmp, 'options.txt', 'launch artifact');
    put(tmp, 'saves/w/level.dat', 'x');
    put(tmp, 'config/icon.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1]));

    const progress: number[] = [];
    const inv = await scanInstanceTree({ kind: 'folder', path: tmp }, { onProgress: (p) => progress.push(p) });
    expect([...inv.files.keys()].sort()).toEqual(['config/atm.toml', 'config/icon.png', 'config/sub/deep/x.json', 'defaultconfigs/d.toml', 'kubejs/server_scripts/a.js']);
    expect(inv.files.get('config/atm.toml')).toEqual({ size: 15, sha256: sha('welcome = true\n'), kind: 'text' });
    expect(inv.files.get('config/icon.png')!.kind).toBe('binary');
    expect(progress.at(-1)).toBe(100);
    expect(inv.issues).toEqual([]);
  });

  it('does not read known binary files (textures, nbt...): size only, unless deepBinary is asked', async () => {
    const png = Buffer.alloc(300, 7);
    put(tmp, 'kubejs/assets/a/textures/x.png', png);
    put(tmp, 'kubejs/server_scripts/a.js', '// hi\n');
    const hashed: string[] = [];
    const inv = await scanInstanceTree({ kind: 'folder', path: tmp }, { hooks: { beforeHash: (rel) => hashed.push(rel) } });
    expect(hashed).toEqual(['kubejs/server_scripts/a.js']);
    expect(inv.files.get('kubejs/assets/a/textures/x.png')).toEqual({ size: 300, sha256: 'size:300', kind: 'binary', sizeOnly: true });

    const deep = await scanInstanceTree({ kind: 'folder', path: tmp }, { deepBinary: true });
    expect(deep.files.get('kubejs/assets/a/textures/x.png')).toEqual({ size: 300, sha256: sha(png), kind: 'binary' });
  });

  it('reports progress while listing, not only while hashing', async () => {
    for (let i = 0; i < 5; i++) put(tmp, `config/d${i}/f.toml`, 'a = 1\n');
    const messages: string[] = [];
    await scanInstanceTree({ kind: 'folder', path: tmp }, { onProgress: (_p, m) => messages.push(m ?? '') });
    expect(messages.some((m) => /^listing files: \d+ found/.test(m))).toBe(true);
  });

  it('lists a deep tree in parallel and still returns every file, sorted', async () => {
    for (let i = 0; i < 20; i++) for (let j = 0; j < 3; j++) put(tmp, `kubejs/server_scripts/d${i}/e${j}/f.js`, `// ${i}${j}\n`);
    const inv = await scanInstanceTree({ kind: 'folder', path: tmp }, { concurrency: 8 });
    const keys = [...inv.files.keys()];
    expect(keys.length).toBe(60);
    expect(keys).toEqual([...keys].sort());
  });

  it('flags files above the text limit as binary tooLarge but still hashes them', async () => {
    const big = 'a'.repeat(2048);
    put(tmp, 'config/big.json', big);
    const inv = await scanInstanceTree({ kind: 'folder', path: tmp }, { maxTextBytes: 1024 });
    expect(inv.files.get('config/big.json')).toEqual({ size: 2048, sha256: sha(big), kind: 'binary', tooLarge: true });
  });

  it('detects NUL bytes as binary whatever the extension', async () => {
    put(tmp, 'config/weird.txt', Buffer.from('ab\0cd'));
    const inv = await scanInstanceTree({ kind: 'folder', path: tmp });
    expect(inv.files.get('config/weird.txt')!.kind).toBe('binary');
  });

  it('does not follow junctions or symlinks (no loop) and records them as issues', async () => {
    put(tmp, 'config/a.toml', 'a = 1\n');
    try {
      fs.symlinkSync(path.join(tmp, 'config'), path.join(tmp, 'config', 'loop'), 'junction');
    } catch {
      return; // the OS refuses links here: nothing to test
    }
    const inv = await scanInstanceTree({ kind: 'folder', path: tmp });
    expect([...inv.files.keys()]).toEqual(['config/a.toml']);
    expect(inv.issues.map((i) => i.path)).toEqual(['config/loop']);
  });

  it('records unreadable files and keeps going', async () => {
    put(tmp, 'config/a.toml', 'a\n');
    put(tmp, 'config/b.toml', 'b\n');
    const inv = await scanInstanceTree({ kind: 'folder', path: tmp }, {
      hooks: { beforeHash: (rel) => { if (rel === 'config/a.toml') fs.rmSync(path.join(tmp, 'config', 'a.toml')); } },
    });
    expect([...inv.files.keys()]).toEqual(['config/b.toml']);
    expect(inv.issues).toEqual([{ path: 'config/a.toml', reason: expect.stringMatching(/disappeared/) }]);
  });

  it('returns an issue for a missing location', async () => {
    const inv = await scanInstanceTree({ kind: 'folder', path: path.join(tmp, 'nope') });
    expect(inv.files.size).toBe(0);
    expect(inv.issues).toEqual([{ path: '.', reason: 'cannot read the location: location not found' }]);
  });

  it('reports a location without any tracked folder instead of an empty inventory', async () => {
    put(tmp, 'mods/a.jar', 'jar');
    put(tmp, 'saves/w/level.dat', 'x');
    const inv = await scanInstanceTree({ kind: 'folder', path: tmp });
    expect(inv.files.size).toBe(0);
    expect(inv.issues).toEqual([{ path: '.', reason: expect.stringMatching(/none of .*config.* found in the location/) }]);
  });

  it('accepts a tracked folder that is empty or only holds excluded files', async () => {
    put(tmp, 'config/old.toml.bak', 'x');
    fs.mkdirSync(path.join(tmp, 'kubejs'));
    const inv = await scanInstanceTree({ kind: 'folder', path: tmp });
    expect(inv.files.size).toBe(0);
    expect(inv.issues).toEqual([]);
  });
});

describe('scanInstanceTree (zip)', () => {
  it('reads a server pack zip with a single top-level folder', async () => {
    const zipPath = path.join(tmp, 'server.zip');
    fs.writeFileSync(zipPath, buildZip([
      { name: 'Server-Files-8.3/config/atm.toml', data: Buffer.from('welcome = true\n') },
      { name: 'Server-Files-8.3/config/atm.toml.bak', data: Buffer.from('x') },
      { name: 'Server-Files-8.3/kubejs/startup_scripts/s.js', data: Buffer.from('//s\n'), method: 'deflate' },
      { name: 'Server-Files-8.3/mods/a.jar', data: Buffer.from('jar') },
      { name: 'Server-Files-8.3/startserver.bat', data: Buffer.from('@echo off') },
    ]));
    const inv = await scanInstanceTree({ kind: 'zip', path: zipPath });
    expect([...inv.files.keys()].sort()).toEqual(['config/atm.toml', 'kubejs/startup_scripts/s.js']);
    expect(inv.files.get('kubejs/startup_scripts/s.js')!.sha256).toBe(sha('//s\n'));
  });

  it('never lists directory entries, whatever their separator, as zero-byte files', async () => {
    const zipPath = path.join(tmp, 'dirs.zip');
    fs.writeFileSync(zipPath, buildZip([
      { name: 'config\\sub\\', data: Buffer.alloc(0) },
      { name: 'config/other/', data: Buffer.alloc(0) },
      { name: 'config\\sub\\a.toml', data: Buffer.from('a = 1\n') },
    ]));
    const inv = await scanInstanceTree({ kind: 'zip', path: zipPath });
    expect([...inv.files.keys()]).toEqual(['config/sub/a.toml']);
    expect(inv.issues).toEqual([]);
  });

  it('reports a zip without any tracked folder (a stray file next to the wrapper folder defeats the prefix detection)', async () => {
    const zipPath = path.join(tmp, 'readme.zip');
    fs.writeFileSync(zipPath, buildZip([
      { name: 'README.txt', data: Buffer.from('hi') },
      { name: 'Wrapper/config/a.toml', data: Buffer.from('a = 1\n') },
    ]));
    const inv = await scanInstanceTree({ kind: 'zip', path: zipPath });
    expect(inv.files.size).toBe(0);
    expect(inv.issues).toEqual([{ path: '.', reason: expect.stringMatching(/none of .* found in the zip/) }]);
  });

  it('reports a missing zip as not found', async () => {
    const inv = await scanInstanceTree({ kind: 'zip', path: path.join(tmp, 'nope.zip') });
    expect(inv.issues).toEqual([{ path: '.', reason: 'cannot open the zip: location not found' }]);
  });

  it('detects the wrapper prefix only when every entry shares a non-root folder', () => {
    expect(detectZipPrefix(['W/config/a', 'W/mods/b.jar'])).toBe('W/');
    expect(detectZipPrefix(['config/a', 'config/b'])).toBe('');
    expect(detectZipPrefix(['W/config/a', 'startserver.bat'])).toBe('');
  });
});

describe('inventory cache', () => {
  it('round-trips and decides when a rescan is needed', async () => {
    put(tmp, 'src/config/a.toml', 'a\n');
    const inv = await scanInstanceTree({ kind: 'folder', path: path.join(tmp, 'src') });
    const dataDir = path.join(tmp, 'data');
    expect(readInventoryCache(dataDir, 7)).toBeNull();
    const written = writeInventoryCache(dataDir, 7, path.join(tmp, 'src'), inv);
    const back = readInventoryCache(dataDir, 7)!;
    expect(back.files['config/a.toml']).toEqual(inv.files.get('config/a.toml'));
    expect(back.scannedAt).toBe(written.scannedAt);
    expect(fs.existsSync(path.join(dataDir, 'cache', 'configs-7.json'))).toBe(true);

    const immutable = { immutable: true, location: path.join(tmp, 'src') };
    expect(needsScan(immutable, back, false)).toBe(false);
    expect(needsScan(immutable, back, true)).toBe(true);
    expect(needsScan({ ...immutable, immutable: false }, back, false)).toBe(true);
    expect(needsScan({ ...immutable, location: 'elsewhere' }, back, false)).toBe(true);
    expect(needsScan(immutable, null, false)).toBe(true);
  });

  it('treats a corrupt cache file as missing', () => {
    fs.mkdirSync(path.join(tmp, 'cache'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'cache', 'configs-3.json'), '{nope');
    expect(readInventoryCache(tmp, 3)).toBeNull();
  });
});

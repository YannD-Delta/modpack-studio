import { describe, expect, it } from 'vitest';
import { CaseCollisionError, READ_ONLY_ZIP_LIMITS, ZipLimitError, ZipSlipError, decodeEntryName, openZip } from '../../src/server/zip/zip-reader.js';
import { makeJar, makeZip } from '../fixtures-gen/jar.js';
import { buildZip } from '../fixtures-gen/zip.js';

const raw = (name: string, data = 'x', method: 'store' | 'deflate' = 'store') => ({ name, data: Buffer.from(data), method });

describe('openZip guards', () => {
  it.each(['..\\evil.txt', '../evil.txt', '/abs.txt', 'C:/x.txt', 'a/../../b.txt'])('rejects entry name %s (zip-slip)', async (name) => {
    await expect(openZip(buildZip([raw(name)]))).rejects.toBeInstanceOf(ZipSlipError);
  });

  it('rejects more entries than maxEntries (default 20000)', async () => {
    const entries = Array.from({ length: 20001 }, (_, i) => raw(`f${i}.txt`, ''));
    await expect(openZip(buildZip(entries))).rejects.toBeInstanceOf(ZipLimitError);
  });

  it('rejects a high compression ratio on read (zip bomb)', async () => {
    const zip = await openZip(buildZip([{ name: 'bomb.bin', data: Buffer.alloc(50 * 1024 * 1024), method: 'deflate' }]));
    await expect(zip.read('bomb.bin')).rejects.toBeInstanceOf(ZipLimitError);
    await zip.close();
  });

  it('rejects entries that differ only by case', async () => {
    await expect(openZip(buildZip([raw('Mods/A.jar'), raw('mods/a.jar')]))).rejects.toBeInstanceOf(CaseCollisionError);
  });

  it('rejects nesting deeper than maxDepth (3)', async () => {
    let inner = buildZip([raw('leaf.txt', 'ok')]);
    for (let i = 4; i >= 1; i--) inner = buildZip([raw(`l${i}.zip`, '')].map((e) => ({ ...e, data: inner })));
    const top = await openZip(inner);
    const l1 = await top.nested('l1.zip');
    const l2 = await l1.nested('l2.zip');
    const l3 = await l2.nested('l3.zip');
    await expect(l3.nested('l4.zip')).rejects.toBeInstanceOf(ZipLimitError);
  });
});

describe('openZip reading', () => {
  it('reads a jar nested in a zip from memory', async () => {
    const jar = await makeJar({ fileName: 'a-1.0.jar', loader: 'neoforge', mods: [{ modId: 'a', version: '1.0' }] });
    const zip = await openZip(await makeZip({ 'mods/a-1.0.jar': jar }));
    const nested = await zip.nested('mods/a-1.0.jar');
    expect((await nested.read('META-INF/neoforge.mods.toml')).toString()).toContain('modId = "a"');
    await zip.close();
  });

  it('lists names unchanged when the zip has a wrapper folder', async () => {
    const zip = await openZip(await makeZip({ 'mods/a.jar': 'x' }, { wrapperDir: 'Base-server' }));
    expect(zip.entries().map((e) => e.name)).toEqual(['Base-server/mods/a.jar']);
    await zip.close();
  });

  it('opens a zip from a file path', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-'));
    const file = path.join(dir, 'a.zip');
    fs.writeFileSync(file, await makeZip({ 'a.txt': 'hello' }));
    const zip = await openZip(file);
    expect((await zip.read('a.txt')).toString()).toBe('hello');
    await zip.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('read-only zip limits and entry names', () => {
  it('accepts case-colliding names and CP437 names under READ_ONLY_ZIP_LIMITS', async () => {
    const buf = buildZip([raw('Mods/A.jar'), raw('mods/a.jar')]);
    await expect(openZip(buf)).rejects.toBeInstanceOf(CaseCollisionError);
    const zip = await openZip(buf, READ_ONLY_ZIP_LIMITS);
    expect(zip.entries()).toHaveLength(2);
    await zip.close();
  });

  it('decodes names without the UTF-8 flag as CP437, keeping distinct names distinct', async () => {
    const buf = buildZip([
      { name: '', data: Buffer.from('1'), rawName: Buffer.from([0x63, 0x66, 0x67, 0x2f, 0x82, 0x2e, 0x74, 0x78, 0x74]) },
      { name: '', data: Buffer.from('2'), rawName: Buffer.from([0x63, 0x66, 0x67, 0x2f, 0x8a, 0x2e, 0x74, 0x78, 0x74]) },
    ]);
    const zip = await openZip(buf);
    expect(zip.entries().map((e) => e.name).sort()).toEqual(['cfg/é.txt', 'cfg/è.txt'].sort());
    await zip.close();
  });

  it('keeps valid UTF-8 names that lack the flag, and the CP437 table is complete', () => {
    expect(decodeEntryName(Buffer.from('cfg/é.txt', 'utf8'), 0)).toBe('cfg/é.txt');
    expect(decodeEntryName(Buffer.from(Array.from({ length: 128 }, (_, i) => 0x80 + i)), 0)).toHaveLength(128);
  });
});

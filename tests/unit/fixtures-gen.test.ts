import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yauzl from 'yauzl';
import { describe, expect, it } from 'vitest';
import { makeJar, makeZip } from '../fixtures-gen/jar.js';
import { writeAtmPack } from '../fixtures-gen/packs.js';

function readZip(buf: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      const out = new Map<string, Buffer>();
      zip.on('entry', (e: yauzl.Entry) => {
        zip.openReadStream(e, (err2, stream) => {
          if (err2 || !stream) return reject(err2);
          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(c));
          stream.on('end', () => { out.set(e.fileName, Buffer.concat(chunks)); zip.readEntry(); });
        });
      });
      zip.on('end', () => resolve(out));
      zip.readEntry();
    });
  });
}

describe('fixture generator', () => {
  it('makeJar writes a neoforge.mods.toml declaring the mod id', async () => {
    const jar = await makeJar({ fileName: 'a-1.0.jar', loader: 'neoforge', mods: [{ modId: 'a', version: '1.0' }] });
    const entries = await readZip(jar);
    expect(entries.get('META-INF/neoforge.mods.toml')?.toString()).toContain('modId = "a"');
  });

  it('makeJar nests jars with a jarjar metadata file', async () => {
    const inner = { fileName: 'lib-2.0.jar', loader: 'neoforge' as const, mods: [{ modId: 'lib', version: '2.0' }] };
    const jar = await makeJar({ fileName: 'outer-1.0.jar', loader: 'neoforge', mods: [{ modId: 'outer', version: '1.0' }], nested: [inner] });
    const entries = await readZip(jar);
    expect(entries.has('META-INF/jarjar/metadata.json')).toBe(true);
    expect(entries.has('META-INF/jarjar/lib-2.0.jar')).toBe(true);
  });

  it('a library jar has no mods toml but an Automatic-Module-Name', async () => {
    const jar = await makeJar({ fileName: 'guava-33.jar', loader: 'neoforge', mods: [], library: true });
    const entries = await readZip(jar);
    expect(entries.has('META-INF/neoforge.mods.toml')).toBe(false);
    expect(entries.get('META-INF/MANIFEST.MF')?.toString()).toContain('Automatic-Module-Name:');
  });

  it('makeZip can store hostile entry names untouched', async () => {
    // yauzl itself refuses such names when decoding, so assert on the raw bytes
    const zip = await makeZip({ '..\\evil.txt': 'x' });
    expect(zip.includes(Buffer.from('..\\evil.txt'))).toBe(true);
  });

  it('writeAtmPack writes a server zip and a client folder with loader info', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atm-'));
    const spec = { fileName: 'a-1.0.jar', loader: 'neoforge' as const, mods: [{ modId: 'a', version: '1.0' }] };
    const { serverZip, clientDir } = await writeAtmPack(dir, { atm: '8.3', neoforge: '21.1.259', mc: '1.21.1', serverMods: [spec], clientMods: [spec] });
    const entries = await readZip(fs.readFileSync(serverZip));
    expect(entries.has('mods/a-1.0.jar')).toBe(true);
    expect(entries.get('startserver.bat')?.toString()).toContain('NEOFORGE_VERSION=21.1.259');
    expect(entries.has('neoforge-21.1.259-installer.jar')).toBe(true);
    const inst = JSON.parse(fs.readFileSync(path.join(clientDir, 'minecraftinstance.json'), 'utf8'));
    expect(inst.baseModLoader.name).toBe('neoforge-21.1.259');
    expect(fs.existsSync(path.join(clientDir, 'mods', 'a-1.0.jar'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

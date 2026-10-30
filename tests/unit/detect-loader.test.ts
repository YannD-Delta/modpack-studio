import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LoaderConflictError, checkLoaderAgreement, detectLoader, detectLoaderForProfile } from '../../src/server/loader/detect-loader.js';
import { makeZip } from '../fixtures-gen/jar.js';
import { writeBasePack } from '../fixtures-gen/packs.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loader-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const zipWith = async (entries: Record<string, string>, wrapperDir?: string) => {
  const file = path.join(tmp, 'server.zip');
  fs.writeFileSync(file, await makeZip(entries, { wrapperDir }));
  return file;
};

describe('detectLoader from a server pack', () => {
  it('reads the NeoForge and Minecraft versions from the installer name and startserver script', async () => {
    const { serverZip } = await writeBasePack(tmp, { upstream: '8.3', neoforge: '21.1.259', mc: '1.21.1', serverMods: [], clientMods: [] });
    expect(await detectLoader({ kind: 'serverZip', path: serverZip })).toEqual({ loader: 'neoforge', loaderVersion: '21.1.259', mcVersion: '1.21.1' });
  });

  it('works inside a wrapper folder', async () => {
    const file = await zipWith({ 'neoforge-21.1.259-installer.jar': 'i', 'startserver.sh': 'NEOFORGE_VERSION="21.1.259"\nMINECRAFT_VERSION="1.21.1"\n' }, 'Base-Server');
    expect((await detectLoader({ kind: 'serverZip', path: file })).loaderVersion).toBe('21.1.259');
  });

  it('throws LoaderConflictError when the installer name and the script disagree', async () => {
    const file = await zipWith({ 'neoforge-21.1.259-installer.jar': 'i', 'startserver.bat': 'set NEOFORGE_VERSION=21.1.251\r\n' });
    await expect(detectLoader({ kind: 'serverZip', path: file })).rejects.toBeInstanceOf(LoaderConflictError);
  });

  it('derives the Minecraft version from the NeoForge version when the script does not state it', async () => {
    expect((await detectLoader({ kind: 'serverZip', path: await zipWith({ 'neoforge-21.1.259-installer.jar': 'i' }) })).mcVersion).toBe('1.21.1');
    expect((await detectLoader({ kind: 'serverZip', path: await zipWith({ 'neoforge-21.0.5-installer.jar': 'i' }) })).mcVersion).toBe('1.21');
  });
});

describe('detectLoader from a CurseForge instance', () => {
  it('reads baseModLoader from minecraftinstance.json', async () => {
    const dir = path.join(tmp, 'inst');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'minecraftinstance.json'), JSON.stringify({ gameVersion: '1.21.1', baseModLoader: { name: 'neoforge-21.1.209', forgeVersion: '21.1.209', minecraftVersion: '1.21.1' } }));
    expect(await detectLoader({ kind: 'curseforgeInstance', path: dir })).toEqual({ loader: 'neoforge', loaderVersion: '21.1.209', mcVersion: '1.21.1' });
  });

  it('throws a clear error when minecraftinstance.json is missing', async () => {
    await expect(detectLoader({ kind: 'curseforgeInstance', path: tmp })).rejects.toThrow(/minecraftinstance\.json/);
  });
});

describe('checkLoaderAgreement', () => {
  const info = (loaderVersion: string) => ({ loader: 'neoforge' as const, loaderVersion, mcVersion: '1.21.1' });

  it('flags a NeoForge version mismatch', () => {
    const r = checkLoaderAgreement({ server: info('21.1.259'), client: info('21.1.251'), own: info('21.1.259') });
    expect(r.ok).toBe(false);
    expect(r.mismatches).toContainEqual({ a: 'server', b: 'client', field: 'loaderVersion' });
    expect(r.mismatches).toContainEqual({ a: 'client', b: 'own', field: 'loaderVersion' });
  });

  it('is ok when every side agrees', () => {
    expect(checkLoaderAgreement({ a: info('21.1.259'), b: info('21.1.259') })).toEqual({ ok: true, mismatches: [] });
  });
});

describe('detectLoader from an unpacked server folder', () => {
  const folder = (files: Record<string, string>) => {
    const dir = path.join(tmp, 'srv');
    fs.mkdirSync(dir, { recursive: true });
    for (const [n, c] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, n)), { recursive: true });
      fs.writeFileSync(path.join(dir, n), c);
    }
    return { locationKind: 'folder', location: dir };
  };

  it('reads the start script and the installer name', async () => {
    const p = folder({ 'startserver.sh': 'NEOFORGE_VERSION="21.1.259"\nMINECRAFT_VERSION="1.21.1"\n' });
    expect(await detectLoader({ kind: 'serverFolder', path: p.location })).toEqual({ loader: 'neoforge', loaderVersion: '21.1.259', mcVersion: '1.21.1' });
  });

  it('falls back to the libraries folder of an installed server', async () => {
    const p = folder({ 'libraries/net/neoforged/neoforge/21.1.259/x.txt': '' });
    expect((await detectLoaderForProfile(p))?.loaderVersion).toBe('21.1.259');
  });

  it('reports unknown (null) instead of failing when nothing is readable', async () => {
    expect(await detectLoaderForProfile(folder({ 'readme.txt': 'x' }))).toBeNull();
    expect(await detectLoaderForProfile({ locationKind: 'folder', location: path.join(tmp, 'missing') })).toBeNull();
  });

  it('prefers minecraftinstance.json when present', async () => {
    const p = folder({ 'minecraftinstance.json': JSON.stringify({ gameVersion: '1.21.1', baseModLoader: { name: 'neoforge-21.1.1', minecraftVersion: '1.21.1' } }) });
    expect((await detectLoaderForProfile(p))?.loader).toBe('neoforge');
  });

  it('still reports a start script that contradicts the installer', async () => {
    const p = folder({ 'neoforge-21.1.259-installer.jar': 'i', 'startserver.sh': 'NEOFORGE_VERSION=21.1.251\n' });
    await expect(detectLoaderForProfile(p)).rejects.toBeInstanceOf(LoaderConflictError);
  });
});

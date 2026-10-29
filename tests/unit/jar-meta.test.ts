import { describe, expect, it } from 'vitest';
import { readJarInfo } from '../../src/server/mods/jar-meta.js';
import { openZip } from '../../src/server/zip/zip-reader.js';
import { makeJar, makeZip, type JarSpec } from '../fixtures-gen/jar.js';

const info = async (spec: JarSpec) => readJarInfo(await openZip(await makeJar(spec)), spec.fileName);
const one = (modId: string, version: string, dependencySide?: 'CLIENT' | 'SERVER' | 'BOTH') => ({ modId, version, dependencySide });
const toml = (id: string) => `[[mods]]\nmodId = "${id}"\nversion = "1.0"\n`;

describe('readJarInfo', () => {
  it('prefers neoforge.mods.toml over mods.toml', async () => {
    const zip = await openZip(await makeZip({ 'META-INF/neoforge.mods.toml': toml('neo'), 'META-INF/mods.toml': toml('legacy') }));
    const r = await readJarInfo(zip, 'x.jar');
    expect(r.mods.map((m) => m.modId)).toEqual(['neo']);
    expect(r.loader).toBe('neoforge');
  });

  it('returns every mod id of a jar with several [[mods]]', async () => {
    const r = await info({ fileName: 'multi-1.0.jar', loader: 'neoforge', mods: [one('first', '1.0'), one('second', '2.0')] });
    expect(r.mods.map((m) => [m.modId, m.version])).toEqual([['first', '1.0'], ['second', '2.0']]);
    expect(r.kind).toBe('mod');
  });

  it('resolves ${file.jarVersion} from the manifest, else from the file name', async () => {
    const withManifest = await info({ fileName: 'a-9.9.9.jar', loader: 'neoforge', mods: [one('a', 'x')], placeholderVersion: true, manifestVersion: '1.2.3' });
    expect(withManifest.mods[0]!.version).toBe('1.2.3');
    const fromName = await info({ fileName: 'allthemodium-2.1.8-1.19.2-43.1.1.jar', loader: 'neoforge', mods: [one('a', 'x')], placeholderVersion: true });
    expect(fromName.mods[0]!.version).toBe('2.1.8-1.19.2-43.1.1');
  });

  it('reads the declared side from the dependency on minecraft', async () => {
    expect((await info({ fileName: 'a-1.jar', loader: 'neoforge', mods: [one('a', '1', 'CLIENT')] })).mods[0]!.declaredSide).toBe('client');
    expect((await info({ fileName: 'a-1.jar', loader: 'neoforge', mods: [one('a', '1', 'BOTH')] })).mods[0]!.declaredSide).toBe('both');
    expect((await info({ fileName: 'a-1.jar', loader: 'neoforge', mods: [one('a', '1')] })).mods[0]!.declaredSide).toBe('both');
  });

  it('ignores a client side declared on a dependency on another mod', async () => {
    const zip = await openZip(await makeZip({
      'META-INF/neoforge.mods.toml': '[[mods]]\nmodId = "a"\nversion = "1"\n[[dependencies.a]]\nmodId = "jei"\ntype = "optional"\nside = "CLIENT"\n',
    }));
    expect((await readJarInfo(zip, 'a-1.jar')).mods[0]!.declaredSide).toBe('both');
  });

  it('reads a fabric jar from fabric.mod.json', async () => {
    const r = await info({ fileName: 'f-1.jar', loader: 'fabric', mods: [one('f', '1.5', 'CLIENT')] });
    expect(r).toMatchObject({ loader: 'fabric', kind: 'mod' });
    expect(r.mods[0]).toMatchObject({ modId: 'f', version: '1.5', declaredSide: 'client' });
  });

  it('treats a jar without mod metadata as a library keyed by module name', async () => {
    const r = await info({ fileName: 'guava-33.jar', loader: 'neoforge', mods: [], library: true });
    expect(r.kind).toBe('library');
    expect(r.mods).toEqual([]);
    expect(r.libraryKey).toMatch(/^guava:[0-9a-f]{40}$/);
  });

  it('lists jar-in-jar entries as nested, never as mods', async () => {
    const inner: JarSpec = { fileName: 'lib-2.0.jar', loader: 'neoforge', mods: [one('lib', '2.0')] };
    const r = await info({ fileName: 'outer-1.0.jar', loader: 'neoforge', mods: [one('outer', '1.0')], nested: [inner] });
    expect(r.mods.map((m) => m.modId)).toEqual(['outer']);
    expect(r.nested.map((n) => n.mods[0]!.modId)).toEqual(['lib']);
  });

  it('does not throw on a corrupt toml and falls back to a library', async () => {
    const zip = await openZip(await makeZip({ 'META-INF/neoforge.mods.toml': '\u0000\u0001 not toml [[[', 'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\r\n' }));
    const r = await readJarInfo(zip, 'broken-1.0.jar');
    expect(r.kind).toBe('library');
  });
});

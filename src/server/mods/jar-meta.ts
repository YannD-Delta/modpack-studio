import crypto from 'node:crypto';
import type { ZipHandle } from '../zip/zip-reader.js';

export type DeclaredSide = 'client' | 'server' | 'both' | 'unknown';
export type ModDecl = { modId: string; version: string; declaredSide: DeclaredSide };
export type JarInfo = {
  fileName: string;
  loader: 'neoforge' | 'forge' | 'fabric' | null;
  kind: 'mod' | 'library';
  mods: ModDecl[];
  libraryKey?: string;
  /** Set when the jar carries a mod metadata file but no mod could be read from it: reported as an import issue, never a library. */
  unparsed?: string;
  nested: JarInfo[];
};

const PLATFORM_DEPENDENCIES = new Set(['minecraft', 'neoforge', 'forge']);

/** Metadata files that mean "this jar is a mod" even though we cannot read a mod id out of them. */
const UNSUPPORTED_METADATA = ['quilt.mod.json', 'mcmod.info'];

async function readText(zip: ZipHandle, name: string): Promise<string | null> {
  return (await readTextState(zip, name)).text;
}

/** Like readText, but tells an absent entry from one that exists and cannot be read. A leading BOM is dropped. */
async function readTextState(zip: ZipHandle, name: string): Promise<{ present: boolean; text: string | null }> {
  if (!zip.entries().some((e) => e.name === name)) return { present: false, text: null };
  try {
    return { present: true, text: (await zip.read(name)).toString('utf8').replace(/^\uFEFF/, '') };
  } catch {
    return { present: true, text: null };
  }
}

function versionFromFileName(fileName: string): string {
  const m = /[-_](\d[^]*)\.jar$/i.exec(fileName);
  return m?.[1] ?? '';
}

function sideFromDeclared(sides: string[]): DeclaredSide {
  if (sides.length === 0) return 'both';
  const set = new Set(sides.map((s) => s.toUpperCase()));
  if (set.has('BOTH') || (set.has('CLIENT') && set.has('SERVER'))) return 'both';
  return set.has('CLIENT') ? 'client' : 'server';
}

// Only dependencies on the platform (minecraft / neoforge / forge) say anything about the mod itself:
// a client-side flag on a dependency on another mod is just an optional client integration.
function declaredSidesFor(toml: string, modId: string): string[] {
  const out: string[] = [];
  for (const m of toml.matchAll(/^\s*\[\[dependencies\.["']?([^\]"']+)["']?\]\]([\s\S]*?)(?=^\s*\[\[|$(?![\s\S]))/gm)) {
    if (m[1] !== modId) continue;
    const dep = /^\s*modId\s*=\s*["']([^"']+)["']/m.exec(m[2]!);
    const side = /^\s*side\s*=\s*["'](CLIENT|SERVER|BOTH)["']/im.exec(m[2]!);
    if (dep && PLATFORM_DEPENDENCIES.has(dep[1]!) && side) out.push(side[1]!);
  }
  return out;
}

function parseToml(toml: string): { modId: string; version: string | null }[] {
  const mods: { modId: string; version: string | null }[] = [];
  for (const b of toml.matchAll(/^\s*\[\[mods\]\]([\s\S]*?)(?=^\s*\[\[|$(?![\s\S]))/gm)) {
    const id = /^\s*modId\s*=\s*["']([^"']+)["']/m.exec(b[1]!);
    if (!id) continue;
    const v = /^\s*version\s*=\s*["']([^"']*)["']/m.exec(b[1]!);
    mods.push({ modId: id[1]!, version: v?.[1] ?? null });
  }
  return mods;
}

async function resolveVersion(zip: ZipHandle, declared: string | null, fileName: string): Promise<string> {
  if (declared && !declared.includes('${')) return declared;
  const mf = await readText(zip, 'META-INF/MANIFEST.MF');
  const impl = mf ? /^Implementation-Version:\s*(\S+)/m.exec(mf) : null;
  return impl?.[1] ?? versionFromFileName(fileName);
}

async function libraryKey(zip: ZipHandle, fileName: string): Promise<string> {
  const mf = await readText(zip, 'META-INF/MANIFEST.MF');
  const auto = mf ? /^Automatic-Module-Name:\s*(\S+)/m.exec(mf) : null;
  const module = auto?.[1] ?? fileName.replace(/[-_]?\d.*$/, '').replace(/\.jar$/i, '');
  const listing = zip.entries().map((e) => `${e.name}:${e.size}`).sort().join('\n');
  return `${module}:${crypto.createHash('sha1').update(listing).digest('hex')}`;
}

async function readNested(zip: ZipHandle): Promise<JarInfo[]> {
  const meta = await readText(zip, 'META-INF/jarjar/metadata.json');
  if (!meta) return [];
  let paths: string[] = [];
  try {
    paths = ((JSON.parse(meta).jars ?? []) as { path?: string }[]).map((j) => j.path).filter((p): p is string => !!p);
  } catch {
    return [];
  }
  const out: JarInfo[] = [];
  for (const p of paths) {
    try {
      const inner = await zip.nested(p);
      out.push(await readJarInfo(inner, p.split('/').pop() ?? p));
      await inner.close();
    } catch {
      // an unreadable nested jar is skipped: it is informational only
    }
  }
  return out;
}

export async function readJarInfo(zip: ZipHandle, fileName: string): Promise<JarInfo> {
  const nested = await readNested(zip);
  let mods: ModDecl[] = [];
  let loader: JarInfo['loader'] = null;
  const broken: string[] = []; // metadata files that exist but gave no mod

  for (const [entry, kind] of [['META-INF/neoforge.mods.toml', 'neoforge'], ['META-INF/mods.toml', 'forge']] as const) {
    const { present, text: toml } = await readTextState(zip, entry);
    if (!present) continue;
    const parsed = toml === null ? [] : parseToml(toml);
    if (toml === null || parsed.length === 0) {
      broken.push(`${entry} ${toml === null ? 'cannot be read' : 'declares no mod id'}`);
      continue;
    }
    loader = kind;
    mods = await Promise.all(
      parsed.map(async (m) => ({
        modId: m.modId,
        version: await resolveVersion(zip, m.version, fileName),
        declaredSide: sideFromDeclared(declaredSidesFor(toml, m.modId)),
      })),
    );
    break;
  }

  if (mods.length === 0) {
    const { present, text: fabric } = await readTextState(zip, 'fabric.mod.json');
    if (present) {
      try {
        const j = JSON.parse(fabric ?? '') as { id?: unknown; version?: unknown; environment?: unknown } | null;
        if (typeof j?.id === 'string' && j.id !== '') {
          loader = 'fabric';
          const side: DeclaredSide = j.environment === 'client' ? 'client' : j.environment === 'server' ? 'server' : 'both';
          mods = [{ modId: j.id, version: await resolveVersion(zip, typeof j.version === 'string' ? j.version : null, fileName), declaredSide: side }];
        } else broken.push('fabric.mod.json has no usable string "id"');
      } catch {
        broken.push(fabric === null ? 'fabric.mod.json cannot be read' : 'fabric.mod.json is not valid JSON');
      }
    }
  }

  if (mods.length === 0) {
    for (const name of UNSUPPORTED_METADATA) if (zip.entries().some((e) => e.name === name)) broken.push(`${name} is not supported`);
    if (broken.length > 0) return { fileName, loader: null, kind: 'library', mods: [], unparsed: `mod metadata could not be read: ${broken.join('; ')}`, nested };
  }

  if (mods.length === 0) return { fileName, loader: null, kind: 'library', mods: [], libraryKey: await libraryKey(zip, fileName), nested };
  return { fileName, loader, kind: 'mod', mods, nested };
}

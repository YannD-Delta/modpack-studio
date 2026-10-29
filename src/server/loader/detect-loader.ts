import fs from 'node:fs';
import path from 'node:path';
import { openZip } from '../zip/zip-reader.js';

export type LoaderInfo = { loader: 'neoforge' | 'forge' | 'fabric'; loaderVersion: string; mcVersion: string | null };
export type LoaderSource = { kind: 'serverZip'; path: string } | { kind: 'curseforgeInstance'; path: string };

export class LoaderConflictError extends Error {
  constructor(public readonly installer: string, public readonly script: string) {
    super(`installer says NeoForge ${installer} but the start script says ${script}`);
    this.name = 'LoaderConflictError';
  }
}

// NeoForge versions are "<mc minor>.<mc patch>.<build>": 21.1.x is Minecraft 1.21.1, 21.0.x is 1.21.
function mcFromNeoForge(version: string): string | null {
  const m = /^(\d+)\.(\d+)\./.exec(version);
  if (!m) return null;
  return m[2] === '0' ? `1.${m[1]}` : `1.${m[1]}.${m[2]}`;
}

const unquote = (s: string) => s.replace(/^["']|["']$/g, '');

async function detectFromServerZip(file: string): Promise<LoaderInfo> {
  const zip = await openZip(file);
  try {
    const names = zip.entries().map((e) => e.name);
    const installerName = names.map((n) => /(^|\/)neoforge-([^/]+?)-installer\.jar$/.exec(n)?.[2]).find((v): v is string => !!v);
    const scriptName = names.find((n) => /(^|\/)startserver\.(bat|sh)$/i.test(n));
    let scriptVersion: string | undefined;
    let scriptMc: string | undefined;
    if (scriptName) {
      const text = (await zip.read(scriptName)).toString('utf8');
      const nf = /NEOFORGE_VERSION=(\S+)/.exec(text);
      const mc = /MINECRAFT_VERSION=(\S+)/.exec(text);
      if (nf) scriptVersion = unquote(nf[1]!);
      if (mc) scriptMc = unquote(mc[1]!);
    }
    if (installerName && scriptVersion && installerName !== scriptVersion) throw new LoaderConflictError(installerName, scriptVersion);
    const loaderVersion = installerName ?? scriptVersion;
    if (!loaderVersion) throw new Error('no NeoForge installer or startserver script found in the server zip');
    return { loader: 'neoforge', loaderVersion, mcVersion: scriptMc ?? mcFromNeoForge(loaderVersion) };
  } finally {
    await zip.close();
  }
}

function detectFromInstance(dir: string): LoaderInfo {
  const file = path.join(dir, 'minecraftinstance.json');
  if (!fs.existsSync(file)) throw new Error(`minecraftinstance.json not found in ${dir}`);
  const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { gameVersion?: string; baseModLoader?: { name?: string; forgeVersion?: string; minecraftVersion?: string } };
  const base = j.baseModLoader;
  const m = /^(neoforge|forge|fabric)-(.+)$/.exec(base?.name ?? '');
  if (!m) throw new Error('baseModLoader is missing or not a known loader in minecraftinstance.json');
  return { loader: m[1] as LoaderInfo['loader'], loaderVersion: base?.forgeVersion ?? m[2]!, mcVersion: base?.minecraftVersion ?? j.gameVersion ?? null };
}

export async function detectLoader(source: LoaderSource): Promise<LoaderInfo> {
  return source.kind === 'serverZip' ? detectFromServerZip(source.path) : detectFromInstance(source.path);
}

export type LoaderMismatch = { a: string; b: string; field: 'loader' | 'loaderVersion' | 'mcVersion' };

/** Compares every pair of sides; a null Minecraft version is unknown, not a mismatch. */
export function checkLoaderAgreement(infos: Record<string, LoaderInfo>): { ok: boolean; mismatches: LoaderMismatch[] } {
  const keys = Object.keys(infos);
  const mismatches: LoaderMismatch[] = [];
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = infos[keys[i]!]!;
      const b = infos[keys[j]!]!;
      for (const field of ['loader', 'loaderVersion', 'mcVersion'] as const) {
        if (a[field] && b[field] && a[field] !== b[field]) mismatches.push({ a: keys[i]!, b: keys[j]!, field });
      }
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

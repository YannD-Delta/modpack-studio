import fs from 'node:fs';
import path from 'node:path';
import { READ_ONLY_ZIP_LIMITS, openZip } from '../zip/zip-reader.js';

export type LoaderInfo = { loader: 'neoforge' | 'forge' | 'fabric'; loaderVersion: string; mcVersion: string | null };
export type LoaderSource = { kind: 'serverZip'; path: string } | { kind: 'serverFolder'; path: string } | { kind: 'curseforgeInstance'; path: string };

/** The location holds no loader information we can read (not an error of the profile: the loader is simply unknown). */
export class LoaderUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoaderUnknownError';
  }
}

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

/** NeoForge facts from a server pack's file names and start script text; shared by the zip and the folder readers. */
function neoForgeFrom(installerName: string | undefined, scriptText: string | null): LoaderInfo {
  let scriptVersion: string | undefined;
  let scriptMc: string | undefined;
  if (scriptText) {
    const nf = /NEOFORGE_VERSION=(\S+)/.exec(scriptText);
    const mc = /MINECRAFT_VERSION=(\S+)/.exec(scriptText);
    if (nf) scriptVersion = unquote(nf[1]!);
    if (mc) scriptMc = unquote(mc[1]!);
  }
  if (installerName && scriptVersion && installerName !== scriptVersion) throw new LoaderConflictError(installerName, scriptVersion);
  const loaderVersion = installerName ?? scriptVersion;
  if (!loaderVersion) throw new LoaderUnknownError('no NeoForge installer or startserver script found');
  return { loader: 'neoforge', loaderVersion, mcVersion: scriptMc ?? mcFromNeoForge(loaderVersion) };
}

async function detectFromServerZip(file: string): Promise<LoaderInfo> {
  const zip = await openZip(file, READ_ONLY_ZIP_LIMITS);
  try {
    const names = zip.entries().map((e) => e.name);
    const installerName = names.map((n) => /(^|\/)neoforge-([^/]+?)-installer\.jar$/.exec(n)?.[2]).find((v): v is string => !!v);
    const scriptName = names.find((n) => /(^|\/)startserver\.(bat|sh)$/i.test(n));
    try {
      return neoForgeFrom(installerName, scriptName ? (await zip.read(scriptName)).toString('utf8') : null);
    } catch (err) {
      if (err instanceof LoaderUnknownError) throw new LoaderUnknownError('no NeoForge installer or startserver script found in the server zip');
      throw err;
    }
  } finally {
    await zip.close();
  }
}

/** An unpacked server folder: installer file name, start script, else the version folder NeoForge created under libraries/. */
function detectFromServerFolder(dir: string): LoaderInfo {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    throw new LoaderUnknownError(`cannot read the server folder ${dir}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const installerName = names.map((n) => /^neoforge-([^/]+?)-installer\.jar$/.exec(n)?.[1]).find((v): v is string => !!v);
  const scriptName = names.find((n) => /^startserver\.(bat|sh)$/i.test(n));
  let scriptText: string | null = null;
  if (scriptName) {
    try {
      scriptText = fs.readFileSync(path.join(dir, scriptName), 'utf8');
    } catch {
      // an unreadable script only removes one source of information
    }
  }
  let libVersion: string | undefined;
  try {
    libVersion = fs.readdirSync(path.join(dir, 'libraries', 'net', 'neoforged', 'neoforge')).sort().pop();
  } catch {
    // no libraries folder: the server was never installed
  }
  try {
    return neoForgeFrom(installerName ?? libVersion, scriptText);
  } catch (err) {
    if (err instanceof LoaderUnknownError) throw new LoaderUnknownError(`no NeoForge installer, startserver script or libraries folder found in ${dir}`);
    throw err;
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
  if (source.kind === 'serverZip') return detectFromServerZip(source.path);
  if (source.kind === 'serverFolder') return detectFromServerFolder(source.path);
  return detectFromInstance(source.path);
}

/**
 * The loader of a profile, from what its location offers: a server zip, a CurseForge instance
 * (minecraftinstance.json) or an unpacked server folder. null = unknown (nothing readable); real problems still throw.
 */
export async function detectLoaderForProfile(profile: { locationKind: string; location: string }): Promise<LoaderInfo | null> {
  try {
    if (profile.locationKind === 'zip') return await detectLoader({ kind: 'serverZip', path: profile.location });
    if (fs.existsSync(path.join(profile.location, 'minecraftinstance.json'))) return await detectLoader({ kind: 'curseforgeInstance', path: profile.location });
    return await detectLoader({ kind: 'serverFolder', path: profile.location });
  } catch (err) {
    if (err instanceof LoaderUnknownError) return null;
    throw err;
  }
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

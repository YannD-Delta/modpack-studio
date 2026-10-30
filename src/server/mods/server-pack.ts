import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Db } from '../db/open.js';
import { isIgnoredByUser } from '../configs/ignore.js';
import { trackedRoots } from '../configs/inventory.js';
import type { Profile } from '../profiles/profile-service.js';
import { effectiveBlacklist } from './blacklist-service.js';
import { loadModSet } from './modset-store.js';
import { isInside, utcStamp, writeZip } from './update-pack.js';

export type ServerPackErrorCode = 'not_a_server' | 'not_a_folder' | 'folder_missing' | 'not_imported' | 'inside_source';
export class ServerPackError extends Error {
  constructor(
    readonly code: ServerPackErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ServerPackError';
  }
}

export type LeftOut = { kind: 'mod' | 'path'; key: string; reason: string };
export type ServerPackResult = {
  name: string;
  folder: string;
  zipPath: string;
  zipBytes: number;
  createdAt: string;
  profile: string;
  /** Jars copied into mods/. */
  mods: number;
  /** Every file in the pack, mods and manifest included. */
  files: number;
  leftOut: LeftOut[];
  /** Jars of mods/ the imported mod set does not know: copied, but not checked against the blacklist. */
  unlisted: string[];
};

export type ServerPackOptions = {
  db: Db;
  profile: Profile;
  exportsDir: string;
  /** Only the `stale` flag of blacklist entries depends on it; every entry is applied whatever the value. */
  upstreamVersion?: string;
  now?: Date;
  progress?: (pct: number, msg: string) => void;
};

/** Root-level files copied when present (case-insensitive). Nothing else at the root is ever copied. */
const ROOT_FILE_ALLOW = [/^run\.bat$/i, /^run\.sh$/i, /^start[^/\\]*\.bat$/i, /^user_jvm_args\.txt$/i, /^server\.properties$/i];
/** Never copied, whichever folder they sit in: private or server specific. */
const DENIED_FILE = [/^eula\.txt$/i, /^ops\.json$/i, /^whitelist\.json$/i, /^banned-[^/\\]*\.json$/i, /^usercache\.json$/i];
const RUNTIME_DIRS = new Set(['world', 'logs', 'crash-reports', 'backups', 'cache', '.cache']);
/** Same noise the config scan skips inside a tracked folder. */
const NOISE_FILE = /\.(bak|tmp|log)$/i;
const NOISE_DIRS = new Set(['logs', '.cache', 'cache']);

const isDenied = (name: string) => DENIED_FILE.some((re) => re.test(name));

function leftOutReasonForRootEntry(name: string, isDir: boolean): string {
  if (isDenied(name)) return 'private or server specific file, never exported';
  if (isDir && RUNTIME_DIRS.has(name.toLowerCase())) return 'runtime data, never exported';
  if (isDir && /^world/i.test(name)) return 'runtime data, never exported';
  return 'not in the server pack allow-list';
}

const safeSegment = (s: string) => s !== '' && s !== '.' && s !== '..' && !/[\\/:\0]/.test(s);

/** server.properties is a template: the remote console password must not travel with it. */
const blankSecrets = (text: string) => text.replace(/^(rcon\.password\s*=).*$/gim, '$1');

type Plan = { copy: { src: string; rel: string }[]; leftOut: LeftOut[]; unlisted: string[]; mods: number };

async function walkTracked(source: string, root: string, plan: Plan): Promise<void> {
  let ignored = 0;
  const walk = async (rel: string): Promise<void> => {
    for (const e of await fsp.readdir(path.join(source, ...rel.split('/')), { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (NOISE_DIRS.has(e.name.toLowerCase())) continue;
        await walk(r);
      } else if (e.isFile()) {
        if (NOISE_FILE.test(e.name) || isDenied(e.name)) continue;
        if (isIgnoredByUser(r)) {
          ignored++;
          continue;
        }
        plan.copy.push({ src: path.join(source, ...r.split('/')), rel: r });
      }
    }
  };
  await walk(root);
  if (ignored) plan.leftOut.push({ kind: 'path', key: root, reason: `${ignored} file(s) ignored by the paths banned in Settings (configs.ignoredPaths)` });
}

async function planPack(opts: ServerPackOptions, source: string, blacklisted: Set<string>): Promise<Plan> {
  const { db, profile } = opts;
  const plan: Plan = { copy: [], leftOut: [], unlisted: [], mods: 0 };

  // mods/: jar file name (lower case) -> top-level mod ids the import found in it
  const rows = db.sqlite
    .prepare(
      `SELECT m.mod_id AS mod_id, COALESCE(m.file_name, j.filename) AS filename
       FROM jar_mod m JOIN jar j ON j.sha256 = m.jar_sha256
       WHERE m.profile_id = ? AND m.is_jij = 0 AND m.library_key IS NULL`,
    )
    .all(profile.id) as { mod_id: string; filename: string }[];
  const idsOf = new Map<string, string[]>();
  for (const r of rows) idsOf.set(r.filename.toLowerCase(), [...(idsOf.get(r.filename.toLowerCase()) ?? []), r.mod_id]);

  const modsDir = path.join(source, 'mods');
  if (fs.existsSync(modsDir)) {
    for (const e of (await fsp.readdir(modsDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isFile() || !/\.jar$/i.test(e.name)) {
        plan.leftOut.push({ kind: 'path', key: `mods/${e.name}`, reason: e.isDirectory() ? 'sub-folder of mods/, not a jar' : 'not a .jar file' });
        continue;
      }
      const ids = idsOf.get(e.name.toLowerCase());
      if (!ids) plan.unlisted.push(e.name);
      const hit = ids?.find((id) => blacklisted.has(id));
      if (hit) {
        plan.leftOut.push({ kind: 'mod', key: hit, reason: `on the server blacklist (${e.name})` });
        continue;
      }
      plan.copy.push({ src: path.join(modsDir, e.name), rel: `mods/${e.name}` });
      plan.mods++;
    }
  }

  const tracked = new Set<string>();
  for (const root of trackedRoots()) {
    if (!safeSegment(root) || RUNTIME_DIRS.has(root.toLowerCase()) || root.toLowerCase() === 'mods') continue;
    tracked.add(root.toLowerCase());
    const full = path.join(source, root);
    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) await walkTracked(source, root, plan);
  }

  for (const e of (await fsp.readdir(source, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const lower = e.name.toLowerCase();
    if (lower === 'mods' || tracked.has(lower)) continue;
    if (e.isFile() && !isDenied(e.name) && ROOT_FILE_ALLOW.some((re) => re.test(e.name))) {
      plan.copy.push({ src: path.join(source, e.name), rel: e.name });
    } else {
      plan.leftOut.push({ kind: 'path', key: e.name, reason: leftOutReasonForRootEntry(e.name, e.isDirectory()) });
    }
  }
  return plan;
}

const mdCell = (s: string) => s.replace(/\|/g, '\\|');
function manifest(name: string, profile: string, createdAt: string, plan: Plan, files: number): string {
  const lines = [`# Server pack ${name}`, '', `- Source: ${profile}`, `- Created: ${createdAt}`, `- Mods: ${plan.mods} jar(s); files in the pack: ${files}`, ''];
  lines.push('## Included', '', 'mods/ (without the blacklisted jars), the tracked config folders, and the start scripts and server.properties found at the root.', '`rcon.password` is blanked in server.properties.', '');
  lines.push('## Never included', '', 'The world, logs, crash-reports, backups, eula.txt, ops.json, whitelist.json, banned-*.json, usercache.json and anything outside the allow-list.', '');
  const mods = plan.leftOut.filter((l) => l.kind === 'mod');
  lines.push(`## Blacklisted mods left out (${mods.length})`, '');
  if (mods.length) lines.push('| Mod id | Why |', '| --- | --- |', ...mods.map((l) => `| ${mdCell(l.key)} | ${mdCell(l.reason)} |`));
  else lines.push('None.');
  const paths = plan.leftOut.filter((l) => l.kind === 'path');
  lines.push('', `## Other things left out (${paths.length})`, '');
  if (paths.length) lines.push('| Path | Why |', '| --- | --- |', ...paths.map((l) => `| ${mdCell(l.key)} | ${mdCell(l.reason)} |`));
  else lines.push('None.');
  if (plan.unlisted.length) lines.push('', `## Jars not in the imported mod set (${plan.unlisted.length})`, '', 'Copied, but not checked against the blacklist: import the profile again.', '', ...plan.unlisted.map((f) => `- ${f}`));
  return lines.join('\n') + '\n';
}

/**
 * Builds a server pack from a server profile folder into `<exportsDir>/<name>/` plus `<exportsDir>/<name>.zip`.
 * Only an allow-list is copied and the source folder is never written. Written as `.partial` first, renamed when complete.
 */
export async function buildServerPack(opts: ServerPackOptions): Promise<ServerPackResult> {
  const { db, profile } = opts;
  if (profile.side !== 'server') throw new ServerPackError('not_a_server', 'a server pack is built from a server profile');
  if (profile.locationKind !== 'folder' && profile.locationKind !== 'smb') throw new ServerPackError('not_a_folder', 'the profile must point at a server folder');
  const source = path.resolve(profile.location);
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) throw new ServerPackError('folder_missing', 'the server folder is not reachable');
  if (loadModSet(db, profile.id).size === 0) throw new ServerPackError('not_imported', 'import the mods of this profile first: the blacklist is matched by mod id');
  const exportsDir = path.resolve(opts.exportsDir);
  if (isInside(source, exportsDir)) throw new ServerPackError('inside_source', 'the exports folder is inside the server folder: refusing to write into an instance');

  const now = opts.now ?? new Date();
  const blacklisted = new Set(effectiveBlacklist(db, opts.upstreamVersion ?? '').map((e) => e.modId));
  opts.progress?.(5, 'listing the server folder');
  const plan = await planPack(opts, source, blacklisted);

  fs.mkdirSync(exportsDir, { recursive: true });
  const base = `server-pack-${profile.pack}-${profile.version}-${utcStamp(now)}`.replace(/[^A-Za-z0-9._-]/g, '_');
  let name = base;
  for (let n = 2; ['', '.partial', '.zip', '.zip.partial'].some((ext) => fs.existsSync(path.join(exportsDir, `${name}${ext}`))); n++) name = `${base}-${n}`;
  const staging = path.join(exportsDir, `${name}.partial`);
  const zipStaging = path.join(exportsDir, `${name}.zip.partial`);
  const folder = path.join(exportsDir, name);
  const zipPath = path.join(exportsDir, `${name}.zip`);
  const label = `${profile.pack} ${profile.version} (${profile.side}, ${profile.state})`;
  const createdAt = now.toISOString();
  fs.mkdirSync(staging);
  try {
    let done = 0;
    for (const f of plan.copy) {
      const dest = path.join(staging, ...f.rel.split('/'));
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      if (f.rel === 'server.properties') await fsp.writeFile(dest, blankSecrets(await fsp.readFile(f.src, 'utf8')));
      else await fsp.copyFile(f.src, dest);
      if (++done % 20 === 0) opts.progress?.(5 + Math.round((done / plan.copy.length) * 80), `copied ${done}/${plan.copy.length}`);
    }
    await fsp.writeFile(path.join(staging, 'SERVER-PACK.md'), manifest(name, label, createdAt, plan, plan.copy.length + 1));
    opts.progress?.(90, 'zipping');
    await writeZip(staging, name, zipStaging);
    fs.renameSync(staging, folder);
    fs.renameSync(zipStaging, zipPath);
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(zipStaging, { force: true });
    throw err;
  }
  const result: ServerPackResult = { name, folder, zipPath, zipBytes: fs.statSync(zipPath).size, createdAt, profile: label, mods: plan.mods, files: plan.copy.length + 1, leftOut: plan.leftOut, unlisted: plan.unlisted };
  opts.progress?.(100, `server pack ${name}: ${plan.mods} mod(s), ${plan.leftOut.filter((l) => l.kind === 'mod').length} left out`);
  return result;
}

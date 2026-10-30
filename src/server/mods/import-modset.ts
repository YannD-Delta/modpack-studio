import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Db } from '../db/open.js';
import { runInPool } from '../jobs/pool.js';
import type { JobContext } from '../jobs/runner.js';
import { READ_ONLY_ZIP_LIMITS, openZip } from '../zip/zip-reader.js';
import { countSources, readInstanceSourcesChecked, storeSources } from './curseforge-sources.js';
import { readJarInfo, type JarInfo } from './jar-meta.js';
import { defineLimit, getNumberLimit } from '../settings/limits.js';

export type ModSetSource = { kind: 'zip'; path: string } | { kind: 'folder'; path: string };
export type ImportResult = {
  imported: number;
  skipped: { file: string; reason: string }[];
  duplicateIds: { modId: string; files: string[] }[];
};

type Scanned = { fileName: string; sha256: string; size: number; info: JarInfo };

/** How many jars are read, hashed and parsed at the same time during an import (each one is held in memory while scanned). */
export const IMPORT_SCAN_CONCURRENCY = 4;
defineLimit({ key: 'import.scanConcurrency', kind: 'number', default: IMPORT_SCAN_CONCURRENCY, min: 1, max: 32, unit: 'count', group: 'import', label: 'Jars read at the same time' });

async function parseJar(fileName: string, buf: Buffer): Promise<JarInfo> {
  // Jars are only read, never extracted: tolerate case-colliding class names and large asset counts.
  const zip = await openZip(buf, READ_ONLY_ZIP_LIMITS);
  try {
    return await readJarInfo(zip, fileName);
  } finally {
    await zip.close();
  }
}

/** Hashes (once, in a worker thread) and parses the very same bytes, so the stored hash always matches the parsed content. */
async function scanBuffer(fileName: string, buf: Buffer): Promise<Scanned> {
  const [hash, info] = await Promise.all([runInPool<{ sha256: string; size: number }>('sha256-buffer', { buffer: buf }), parseJar(fileName, buf)]);
  return { fileName, sha256: hash.sha256, size: hash.size, info };
}

/** Runs fn over items with at most `limit` in flight; results keep the order of items. */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function listFolderJars(dir: string): Promise<string[]> {
  const modsDir = fs.existsSync(path.join(dir, 'mods')) ? path.join(dir, 'mods') : dir;
  if (!fs.existsSync(modsDir)) return [];
  return (await fsp.readdir(modsDir)).filter((f) => f.toLowerCase().endsWith('.jar')).map((f) => path.join(modsDir, f));
}

/** Scans every jar of a server-pack zip or a mods folder and stores jar + mod metadata for the profile (no jar bytes). */
export async function importModSet(db: Db, source: ModSetSource, profileId: number, ctx: JobContext): Promise<ImportResult> {
  const scanned: Scanned[] = [];
  const skipped: ImportResult['skipped'] = [];

  let done = 0;
  const scanAll = async (items: { name: string; load: () => Promise<Buffer> }[]) => {
    const results = await mapLimited(items, getNumberLimit('import.scanConcurrency'), async (item) => {
      if (ctx.signal.aborted) throw new Error('aborted');
      let result: Scanned | { file: string; reason: string };
      try {
        result = await scanBuffer(item.name, await item.load());
      } catch (err) {
        result = { file: item.name, reason: err instanceof Error ? err.message : String(err) };
      }
      ctx.progress(Math.round((++done / items.length) * 100), item.name);
      return result;
    });
    for (const r of results) {
      if ('reason' in r) skipped.push(r);
      // metadata present but unreadable: an import issue, not a silent library
      else if (r.info.unparsed) skipped.push({ file: r.fileName, reason: r.info.unparsed });
      else scanned.push(r);
    }
  };

  if (source.kind === 'zip') {
    const zip = await openZip(source.path, READ_ONLY_ZIP_LIMITS);
    try {
      const jars = zip.entries().filter((e) => /(^|\/)mods\/[^/]+\.jar$/i.test(e.name));
      if (jars.length === 0) skipped.push({ file: source.path, reason: 'no mods/*.jar found in the zip' });
      await scanAll(jars.map((e) => ({ name: e.name.split('/').pop()!, load: () => zip.read(e.name) })));
    } finally {
      await zip.close();
    }
  } else {
    const files = await listFolderJars(source.path);
    if (files.length === 0) skipped.push({ file: source.path, reason: 'no mods folder or no .jar found' });
    await scanAll(files.map((file) => ({ name: path.basename(file), load: () => fsp.readFile(file) })));
  }

  // Nothing could be scanned (missing folder, empty mods/, unreadable zip): keep whatever this profile already has.
  if (scanned.length === 0) return { imported: 0, skipped, duplicateIds: [] };

  // CurseForge instances also say which project and file each jar is: keep that for links (no API key needed).
  // An unreadable file (a launcher rewriting it, a share hiccup) must not wipe the links already stored: keep them and say so.
  let sources: ReturnType<typeof readInstanceSourcesChecked> = null;
  if (source.kind === 'folder') {
    sources = readInstanceSourcesChecked(source.path);
    if (sources === null && (fs.existsSync(path.join(source.path, 'minecraftinstance.json')) || countSources(db, profileId) > 0)) {
      skipped.push({ file: 'minecraftinstance.json', reason: 'cannot be read right now: the CurseForge links already stored were kept' });
    }
  }

  const insertIssue = db.sqlite.prepare('INSERT INTO import_issue (profile_id, file, reason) VALUES (?, ?, ?)');
  const insertJar = db.sqlite.prepare('INSERT INTO jar (sha256, filename, size) VALUES (?, ?, ?) ON CONFLICT(sha256) DO NOTHING');
  const insertMod = db.sqlite.prepare(
    'INSERT INTO jar_mod (jar_sha256, profile_id, mod_id, version, declared_side, is_jij, parent_jar, library_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const idToFiles = new Map<string, string[]>();

  db.sqlite.transaction(() => {
    db.sqlite.prepare('DELETE FROM jar_mod WHERE profile_id = ?').run(profileId); // idempotent re-import
    db.sqlite.prepare('DELETE FROM import_issue WHERE profile_id = ?').run(profileId);
    for (const s of skipped) insertIssue.run(profileId, s.file, s.reason);
    for (const s of scanned) {
      insertJar.run(s.sha256, s.fileName, s.size);
      if (s.info.kind === 'library') {
        insertMod.run(s.sha256, profileId, s.info.libraryKey!, '', 'unknown', 0, null, s.info.libraryKey);
        continue;
      }
      for (const m of s.info.mods) {
        insertMod.run(s.sha256, profileId, m.modId, m.version, m.declaredSide, 0, null, null);
        idToFiles.set(m.modId, [...(idToFiles.get(m.modId) ?? []), s.fileName]);
      }
      // jar-in-jar entries are informational: recorded, never counted as top-level mods
      for (const n of s.info.nested) {
        for (const m of n.mods) insertMod.run(s.sha256, profileId, m.modId, m.version, m.declaredSide, 1, s.sha256, null);
      }
    }
  })();

  if (sources !== null) storeSources(db, profileId, sources);

  const duplicateIds = [...idToFiles.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([modId, files]) => ({ modId, files: [...files].sort() }));
  return { imported: scanned.length, skipped, duplicateIds };
}

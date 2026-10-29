import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Db } from '../db/open.js';
import { runInPool } from '../jobs/pool.js';
import type { JobContext } from '../jobs/runner.js';
import { openZip } from '../zip/zip-reader.js';
import { readJarInfo, type JarInfo } from './jar-meta.js';

export type ModSetSource = { kind: 'zip'; path: string } | { kind: 'folder'; path: string };
export type ImportResult = {
  imported: number;
  skipped: { file: string; reason: string }[];
  duplicateIds: { modId: string; files: string[] }[];
};

type Scanned = { fileName: string; sha256: string; size: number; info: JarInfo };

async function scanBuffer(fileName: string, buf: Buffer): Promise<Scanned> {
  // Jars are only read, never extracted: tolerate case-colliding class names and large asset counts.
  const zip = await openZip(buf, { caseCollision: 'allow', maxEntries: 200000 });
  try {
    return { fileName, sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length, info: await readJarInfo(zip, fileName) };
  } finally {
    await zip.close();
  }
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

  if (source.kind === 'zip') {
    const zip = await openZip(source.path);
    try {
      const jars = zip.entries().filter((e) => /(^|\/)mods\/[^/]+\.jar$/i.test(e.name));
      if (jars.length === 0) skipped.push({ file: source.path, reason: 'no mods/*.jar found in the zip' });
      for (const [i, e] of jars.entries()) {
        if (ctx.signal.aborted) throw new Error('aborted');
        const name = e.name.split('/').pop()!;
        try {
          scanned.push(await scanBuffer(name, await zip.read(e.name)));
        } catch (err) {
          skipped.push({ file: name, reason: err instanceof Error ? err.message : String(err) });
        }
        ctx.progress(Math.round(((i + 1) / jars.length) * 100), name);
      }
    } finally {
      await zip.close();
    }
  } else {
    const files = await listFolderJars(source.path);
    if (files.length === 0) skipped.push({ file: source.path, reason: 'no mods folder or no .jar found' });
    for (const [i, file] of files.entries()) {
      if (ctx.signal.aborted) throw new Error('aborted');
      const name = path.basename(file);
      try {
        const { sha256, size } = await runInPool<{ sha256: string; size: number }>('sha256-file', { path: file });
        const buf = await fsp.readFile(file);
        const s = await scanBuffer(name, buf);
        scanned.push({ ...s, sha256, size });
      } catch (err) {
        skipped.push({ file: name, reason: err instanceof Error ? err.message : String(err) });
      }
      ctx.progress(Math.round(((i + 1) / files.length) * 100), name);
    }
  }

  // Nothing could be scanned (missing folder, empty mods/, unreadable zip): keep whatever this profile already has.
  if (scanned.length === 0) return { imported: 0, skipped, duplicateIds: [] };

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

  const duplicateIds = [...idToFiles.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([modId, files]) => ({ modId, files: [...files].sort() }));
  return { imported: scanned.length, skipped, duplicateIds };
}

import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/open.js';

export type CfSource = { fileName: string; projectId: number; fileId: number; name: string; url: string };

const CF_PAGE = /^https:\/\/www\.curseforge\.com\//;
const MAX_FILE_BYTES = 64 * 1024 * 1024;

/** A page address from the instance file is only trusted when it points at curseforge.com; otherwise the project-id redirect is used. */
const pageUrl = (projectId: number, webSiteURL: unknown): string =>
  typeof webSiteURL === 'string' && CF_PAGE.test(webSiteURL) ? webSiteURL : `https://www.curseforge.com/projects/${projectId}`;

/** The CurseForge identity of every jar of an instance: `installedAddons` of its minecraftinstance.json. */
export function parseMinecraftInstance(doc: unknown): CfSource[] {
  const addons = (doc as { installedAddons?: unknown } | null)?.installedAddons;
  if (!Array.isArray(addons)) return [];
  const out: CfSource[] = [];
  for (const a of addons as Record<string, unknown>[]) {
    const installed = a.installedFile as { id?: unknown; fileName?: unknown } | undefined;
    const fileName = typeof a.fileNameOnDisk === 'string' ? a.fileNameOnDisk : typeof installed?.fileName === 'string' ? installed.fileName : null;
    const projectId = a.addonID;
    const fileId = installed?.id;
    if (!fileName || typeof projectId !== 'number' || typeof fileId !== 'number') continue;
    out.push({ fileName, projectId, fileId, name: typeof a.name === 'string' ? a.name : fileName, url: pageUrl(projectId, a.webSiteURL) });
  }
  return out;
}

/** Reads `<dir>/minecraftinstance.json`; a missing, oversized or broken file gives no sources rather than an error. */
export function readInstanceSources(dir: string): CfSource[] {
  const file = path.join(dir, 'minecraftinstance.json');
  try {
    if (fs.statSync(file).size > MAX_FILE_BYTES) return [];
    return parseMinecraftInstance(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return [];
  }
}

export function storeSources(db: Db, profileId: number, sources: CfSource[]): void {
  const insert = db.sqlite.prepare('INSERT OR REPLACE INTO jar_source (profile_id, file_name, project_id, file_id, name, url) VALUES (?, ?, ?, ?, ?, ?)');
  db.sqlite.transaction(() => {
    db.sqlite.prepare('DELETE FROM jar_source WHERE profile_id = ?').run(profileId);
    for (const s of sources) insert.run(profileId, s.fileName, s.projectId, s.fileId, s.name, s.url);
  })();
}

export function getSources(db: Db, profileId: number): Map<string, CfSource> {
  const rows = db.sqlite.prepare('SELECT file_name, project_id, file_id, name, url FROM jar_source WHERE profile_id = ?').all(profileId) as {
    file_name: string; project_id: number; file_id: number; name: string; url: string;
  }[];
  return new Map(rows.map((r) => [r.file_name, { fileName: r.file_name, projectId: r.project_id, fileId: r.file_id, name: r.name, url: r.url }]));
}

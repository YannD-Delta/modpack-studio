import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BlobStore } from '../../src/server/blobs/blob-store.js';
import { openDb, type Db } from '../../src/server/db/open.js';
import { APPLY_PS1 } from '../../src/server/plan/apply-script.js';
import type { Profile } from '../../src/server/profiles/profile-service.js';
import { buildProjectExport } from '../../src/server/projects/export.js';
import { createProject, type Preview, type PreviewItem } from '../../src/server/projects/service.js';

let tmp: string;
let db: Db;
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

const profile = (id: number, location: string): Profile => ({ id, pack: 'Base', version: '8.5', side: 'client', state: 'clean', locationKind: 'folder', location, packVersionId: id, capturedAt: null, manifestHash: null, immutable: false }) as Profile;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pexp-'));
  db = openDb(':memory:');
});
afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function setup(content: string, stored = content) {
  const project = createProject(db, 'My pack 2026', '8.4');
  const blobs = new BlobStore(path.join(tmp, 'data', 'blobs'), db);
  const { sha256 } = await blobs.put(Buffer.from(stored));
  blobs.ref(sha256);
  const payload = { sha256: sha(Buffer.from(content)), size: content.length, status: 'modifiedShipped', base: null };
  // the blob is stored under its real hash; claim another content when testing corruption
  db.sqlite.prepare('INSERT INTO project_change (project_id, kind, key, action, payload, validated_at) VALUES (?, ?, ?, ?, ?, ?)').run(project.id, 'file', 'config/a.toml', 'file', JSON.stringify({ ...payload, sha256: stored === content ? sha256 : payload.sha256 }), 'now');
  const dir = path.join(tmp, 'new');
  fs.mkdirSync(path.join(dir, 'mods'), { recursive: true });
  const item: PreviewItem = { id: 1, kind: 'file', key: 'config/a.toml', action: 'file', status: 'safe', reason: 'base-unchanged', mine: { size: content.length }, newBase: { size: 3 }, choice: 'mine' };
  const preview: Preview = { project, newClean: { id: 1, label: 'x' }, missing: { scan: false, import: false }, summary: { safe: 1, already: 0, conflict: 0, warning: 0 }, items: [item], baseDiff: null };
  return { preview, dir, base: (over: Partial<Parameters<typeof buildProjectExport>[0]> = {}) => buildProjectExport({ db, dataDir: path.join(tmp, 'data'), exportsDir: path.join(tmp, 'exports'), preview, profileById: (id) => (id === 1 ? profile(1, dir) : null), now: new Date(Date.UTC(2026, 0, 2, 3, 4, 5)), ...over }) };
}

describe('buildProjectExport', () => {
  it('writes the stored file content with its sha256, the shared apply.ps1 and the project name', async () => {
    const { base } = await setup('a = 2\n');
    const r = await base();
    expect(r.name).toBe('update-project-My_pack_2026-8.5-20260102-030405');
    const folder = path.join(tmp, 'exports', r.name);
    expect(fs.readFileSync(path.join(folder, 'files-add/config/a.toml'), 'utf8')).toBe('a = 2\n');
    const ch = JSON.parse(fs.readFileSync(path.join(folder, 'changes.json'), 'utf8'));
    expect(ch.files).toEqual([{ path: 'config/a.toml', sha256: sha(Buffer.from('a = 2\n')), size: 6, how: 'copied' }]);
    expect(ch.items[0]).toMatchObject({ key: 'config/a.toml', choice: 'mine', outcome: 'replayed' });
    expect(fs.readFileSync(path.join(folder, 'apply.ps1'), 'ascii')).toBe(APPLY_PS1);
    expect(fs.readFileSync(path.join(folder, 'CHANGES.md'), 'utf8')).toContain('My pack 2026');
    expect(fs.existsSync(path.join(tmp, 'exports', `${r.name}.zip`))).toBe(true);
  });

  it('refuses to write inside an instance', async () => {
    const { base, dir } = await setup('a = 2\n');
    await expect(base({ exportsDir: path.join(dir, 'out') })).rejects.toThrow(/inside the profile folder/);
  });

  it('refuses an export where every retouch is skipped, and leaves no partial folder', async () => {
    const { base, preview } = await setup('b = 1');
    preview.items[0]!.choice = 'skip';
    await expect(base()).rejects.toMatchObject({ code: 'nothing_to_export' });
    expect(fs.readdirSync(path.join(tmp, 'exports')).filter((n) => n.includes('.partial'))).toEqual([]);
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/server/db/open.js';
import { getSources, parseMinecraftInstance, readInstanceSources, storeSources } from '../../src/server/mods/curseforge-sources.js';
import { createProfile } from '../../src/server/profiles/profile-service.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-src-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const instance = {
  installedAddons: [
    { addonID: 248787, name: 'AppleSkin', fileNameOnDisk: 'appleskin-neoforge-mc1.21-3.0.9.jar', webSiteURL: 'https://www.curseforge.com/minecraft/mc-mods/appleskin', installedFile: { id: 7854442, fileName: 'appleskin-neoforge-mc1.21-3.0.9.jar' } },
    { addonID: 111, name: 'No Url Mod', fileNameOnDisk: 'nourl-1.0.jar', installedFile: { id: 222 } },
    { addonID: 5, name: 'Broken', installedFile: { id: 6 } }, // no file name: unusable
    { name: 'No id', fileNameOnDisk: 'x.jar' },
  ],
};

describe('parseMinecraftInstance', () => {
  it('keeps the CurseForge ids and the page of every addon that has a jar name', () => {
    expect(parseMinecraftInstance(instance)).toEqual([
      { fileName: 'appleskin-neoforge-mc1.21-3.0.9.jar', projectId: 248787, fileId: 7854442, name: 'AppleSkin', url: 'https://www.curseforge.com/minecraft/mc-mods/appleskin' },
      { fileName: 'nourl-1.0.jar', projectId: 111, fileId: 222, name: 'No Url Mod', url: 'https://www.curseforge.com/projects/111' },
    ]);
  });

  it('returns nothing for a document of another shape', () => {
    expect(parseMinecraftInstance(null)).toEqual([]);
    expect(parseMinecraftInstance({ installedAddons: 'x' })).toEqual([]);
    expect(parseMinecraftInstance([])).toEqual([]);
  });

  it('refuses a page address that is not a CurseForge one', () => {
    const [s] = parseMinecraftInstance({ installedAddons: [{ addonID: 1, name: 'A', fileNameOnDisk: 'a.jar', webSiteURL: 'https://evil.example/x', installedFile: { id: 2 } }] });
    expect(s!.url).toBe('https://www.curseforge.com/projects/1');
  });
});

describe('readInstanceSources', () => {
  it('reads minecraftinstance.json from an instance folder, and tolerates a missing or broken file', () => {
    expect(readInstanceSources(tmp)).toEqual([]);
    fs.writeFileSync(path.join(tmp, 'minecraftinstance.json'), '{broken');
    expect(readInstanceSources(tmp)).toEqual([]);
    fs.writeFileSync(path.join(tmp, 'minecraftinstance.json'), JSON.stringify(instance));
    expect(readInstanceSources(tmp)).toHaveLength(2);
  });
});

describe('source store', () => {
  it('replaces the sources of a profile and looks them up by jar name', () => {
    const db = openDb(':memory:');
    const p = createProfile(db, { pack: 'Base', version: '8.3', side: 'client', state: 'launched', locationKind: 'folder', location: '/x/a' });
    const q = createProfile(db, { pack: 'Own', version: 'test', side: 'client', state: 'launched', locationKind: 'folder', location: '/x/b' });
    storeSources(db, p.id, parseMinecraftInstance(instance));
    storeSources(db, q.id, [{ fileName: 'other.jar', projectId: 9, fileId: 10, name: 'Other', url: 'https://www.curseforge.com/projects/9' }]);
    expect([...getSources(db, p.id).keys()].sort()).toEqual(['appleskin-neoforge-mc1.21-3.0.9.jar', 'nourl-1.0.jar']);
    storeSources(db, p.id, []);
    expect(getSources(db, p.id).size).toBe(0);
    expect(getSources(db, q.id).get('other.jar')!.projectId).toBe(9);
    db.close();
  });
});

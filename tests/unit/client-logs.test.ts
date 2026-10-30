import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/server/db/open.js';
import { closePool } from '../../src/server/jobs/pool.js';
import { importModSet } from '../../src/server/mods/import-modset.js';
import { compareModFiles, crashHeadline, readClientLogs, ClientLogsError, summarizeClientLog } from '../../src/server/testbench/client-logs.js';
import { createProfile } from '../../src/server/profiles/profile-service.js';
import { makeJar } from '../fixtures-gen/jar.js';

const LOG = [
  '[10:00:00] [main/INFO] [net.neoforged.fml.loading.FMLLoader/]: starting',
  '[10:00:01] [Render thread/INFO] [net.minecraft.client.Minecraft/]: Setting user: Player',
  '[10:00:02] [Render thread/WARN] [mixin/]: odd mixin',
  '[10:00:03] [Worker-Main-1/ERROR] [some.mod/]: failed to load thing',
  '[10:00:03] [Worker-Main-2/ERROR] [some.mod/]: failed to load thing',
  '[10:00:04] [Render thread/INFO] [net.minecraft.server.packs.resources.ReloadableResourceManager/]: Reloading ResourceManager: vanilla, mod_resources',
  '[10:00:09] [Render thread/FATAL] [x/]: boom',
].join('\n');

describe('summarizeClientLog', () => {
  it('counts levels, keeps distinct first errors and reports the markers used', () => {
    const s = summarizeClientLog(LOG);
    expect(s.errorLines).toBe(3);
    expect(s.warnLines).toBe(1);
    expect(s.firstErrors).toEqual(['[Worker-Main-1/ERROR] [some.mod/]: failed to load thing', '[Worker-Main-2/ERROR] [some.mod/]: failed to load thing', '[Render thread/FATAL] [x/]: boom']);
    const found = s.markers.filter((m) => m.line !== null).map((m) => m.pattern);
    expect(found.some((p) => p.includes('Setting user'))).toBe(true);
    expect(found.some((p) => p.includes('Reloading ResourceManager'))).toBe(true);
    expect(s.markers.length).toBeGreaterThan(found.length); // the atlas line is absent
    expect(s.reachedAllMarkers).toBe(false);
    // the marker report never repeats the log line (it can hold the player name)
    expect(JSON.stringify(s.markers)).not.toContain('Player');
  });

  it('reports every marker found on a complete log and none on an empty one', () => {
    const full = [LOG, '[10:00:05] [Render thread/INFO] [x/]: Created: 1024x512x4 minecraft:textures/atlas/blocks.png-atlas', '[10:00:05] [Render thread/INFO] [net.minecraft.client.Minecraft/]: Backend library: LWJGL version 3.3.3'].join('\n');
    expect(summarizeClientLog(full).reachedAllMarkers).toBe(true);
    const empty = summarizeClientLog('');
    expect(empty).toMatchObject({ errorLines: 0, warnLines: 0, reachedAllMarkers: false });
    expect(empty.markers.every((m) => m.line === null)).toBe(true);
  });

  it('caps the number of first errors', () => {
    const many = Array.from({ length: 30 }, (_, i) => `[10:00:00] [t/ERROR] [m/]: e${i}`).join('\n');
    const s = summarizeClientLog(many, { maxErrors: 5 });
    expect(s.errorLines).toBe(30);
    expect(s.firstErrors).toHaveLength(5);
  });
});

describe('crashHeadline', () => {
  const report = ['---- Minecraft Crash Report ----', '// Who set us up the TNT?', '', 'Time: 2026-10-29 10:00:00', 'Description: Initializing game', '', 'java.lang.IllegalStateException: Mixin apply failed', '\tat a.b.C(C.java:1)'].join('\n');
  it('joins the description and the exception line', () => {
    expect(crashHeadline(report)).toBe('Initializing game: java.lang.IllegalStateException: Mixin apply failed');
  });
  it('degrades gracefully', () => {
    expect(crashHeadline('Description: Rendering overlay\n')).toBe('Rendering overlay');
    expect(crashHeadline('garbage')).toBeNull();
  });
});

describe('compareModFiles', () => {
  it('lists the jars only on disk and only in the import, ignoring case', () => {
    expect(compareModFiles(['A-1.jar', 'b-1.jar', 'c.jar'], ['a-1.JAR', 'd.jar'])).toEqual({ onlyInInstance: ['b-1.jar', 'c.jar'], onlyInImport: ['d.jar'] });
  });
});

describe('readClientLogs', () => {
  let db: Db;
  let tmp: string;
  beforeEach(() => {
    db = openDb(':memory:');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'client-logs-'));
  });
  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  afterAll(() => closePool());
  const ctx = { params: null, signal: new AbortController().signal, progress: () => undefined };
  const put = (rel: string, content: string | Buffer) => {
    const full = path.join(tmp, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  const jar = async (id: string) => put(`mods/${id}-1.0.jar`, await makeJar({ fileName: `${id}-1.0.jar`, loader: 'neoforge', mods: [{ modId: id, version: '1.0' }] }));
  const profile = (state: 'candidate' | 'launched' | 'run' = 'candidate', side: 'client' | 'server' = 'client') =>
    createProfile(db, { pack: 'Own', version: 'My pack 2026', side, state, locationKind: 'folder', location: tmp });

  it('reads the log tail, the newest crash reports and compares the mods, without writing', async () => {
    await jar('alpha');
    await jar('beta');
    const p = profile();
    await importModSet(db, { kind: 'folder', path: tmp }, p.id, ctx);
    fs.rmSync(path.join(tmp, 'mods', 'beta-1.0.jar'));
    await jar('gamma');
    put('logs/latest.log', LOG);
    put('crash-reports/crash-old.txt', 'Description: Old\n\njava.lang.Error: old');
    put('crash-reports/crash-new.txt', 'Description: New one\n\njava.lang.Error: new');
    fs.utimesSync(path.join(tmp, 'crash-reports', 'crash-old.txt'), new Date(2020, 0, 1), new Date(2020, 0, 1));
    const before = fs.readdirSync(tmp, { recursive: true }).sort();
    const res = readClientLogs(db, p);
    expect(res.log).toMatchObject({ present: true, errorLines: 3, truncated: false });
    expect(res.crashReports[0]).toMatchObject({ name: 'crash-new.txt', headline: 'New one: java.lang.Error: new' });
    expect(res.mods).toMatchObject({ count: 2, onlyInInstance: ['gamma-1.0.jar'], onlyInImport: ['beta-1.0.jar'] });
    expect(fs.readdirSync(tmp, { recursive: true }).sort()).toEqual(before);
  });

  it('tells a missing log from an empty one and truncates an oversized one', () => {
    const p = profile('run');
    expect(readClientLogs(db, p).log.present).toBe(false);
    put('logs/latest.log', 'x'.repeat(3000) + '\n[10:00:00] [t/ERROR] [m/]: last\n');
    const res = readClientLogs(db, p, { tailBytes: 500 });
    expect(res.log).toMatchObject({ present: true, truncated: true, errorLines: 1 });
  });

  it('refuses a server profile and a profile that was not run by hand', () => {
    expect(() => readClientLogs(db, profile('candidate', 'server'))).toThrow(ClientLogsError);
    expect(() => readClientLogs(db, profile('launched'))).toThrowError(/candidate or run/);
  });
});

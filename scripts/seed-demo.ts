// Seeds a throwaway data directory with synthetic Base / Own packs so the UI can be looked at.
// Usage: tsx scripts/seed-demo.ts [dataDir] [port]   (login password: demo; default folder: studio-demo in the OS temp directory)
// The folder is wiped first, so it must not exist or must hold the marker of a previous seed (see seed-demo-guard.ts).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../src/server/api/auth.js';
import { openDb } from '../src/server/db/open.js';
import { closePool } from '../src/server/jobs/pool.js';
import { DEFAULT_DEMO_DIR, DEMO_MARKER, assertDemoDir } from './seed-demo-guard.js';
import { importModSet } from '../src/server/mods/import-modset.js';
import { createProfile, validateLocation, type LocationKind } from '../src/server/profiles/profile-service.js';
import type { JarSpec } from '../tests/fixtures-gen/jar.js';
import { writeAtmPack } from '../tests/fixtures-gen/packs.js';

const dataDir = assertDemoDir(process.argv[2] ?? DEFAULT_DEMO_DIR, { repoRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') });
const port = Number(process.argv[3] ?? 8481);
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, DEMO_MARKER), 'Created by scripts/seed-demo.ts; safe to wipe.');
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ port, passwordHash: hashPassword('demo') }));

const jar = (id: string, version = '1.0'): JarSpec => ({ fileName: `${id}-${version}.jar`, loader: 'neoforge', mods: [{ modId: id, version }] });
const shared = ['jei', 'mekanism', 'create', 'ae2', 'botania', 'thermal', 'farmersdelight', 'jade', 'curios', 'geckolib', 'supplementaries', 'chipped', 'waystones', 'ftbquests', 'ftbteams', 'sophisticatedbackpacks'];
const clientOnly = ['embeddium', 'xaerominimap', 'sodiumextras', 'journeymap'];
const serverOnly = ['spark', 'chunky'];

const base = await writeAtmPack(path.join(dataDir, 'packs', 'base'), {
  atm: '8.3', neoforge: '21.1.259', mc: '1.21.1',
  serverMods: [...shared, ...serverOnly].map((m) => jar(m)),
  clientMods: [...shared, ...clientOnly].map((m) => jar(m)),
});
const ownMods = [...shared.filter((m) => m !== 'waystones').map((m) => jar(m, m === 'mekanism' || m === 'create' ? '1.1' : '1.0')), ...clientOnly.map((m) => jar(m)), jar('own_core'), jar('own_decor'), jar('own_tweaks')];
const own = await writeAtmPack(path.join(dataDir, 'packs', 'own'), { atm: '1.0', neoforge: '21.1.259', mc: '1.21.1', serverMods: [], clientMods: ownMods });

const db = openDb(path.join(dataDir, 'studio.db'));
const ctx = { params: null, signal: new AbortController().signal, progress: () => undefined };
// Same location check as POST /profiles: the demo must not hold a profile the real API would refuse.
const mk = (pack: 'Base' | 'Own', version: string, side: 'client' | 'server', state: 'clean' | 'launched' | 'run', kind: LocationKind, location: string) => {
  validateLocation(kind, location);
  return createProfile(db, { pack, version, side, state, locationKind: kind, location });
};
const oldBase = await writeAtmPack(path.join(dataDir, 'packs', 'base-old'), { atm: '8.2', neoforge: '21.1.200', mc: '1.21.1', serverMods: shared.map((m) => jar(m)), clientMods: [] });
const ownServerDir = path.join(dataDir, 'packs', 'own-server');
fs.mkdirSync(ownServerDir, { recursive: true });
const s = mk('Base', '8.3', 'server', 'clean', 'zip', base.serverZip);
const c = mk('Base', '8.3', 'client', 'clean', 'folder', base.clientDir);
const l = mk('Own', '1.0', 'client', 'clean', 'folder', own.clientDir);
mk('Base', '8.2', 'server', 'clean', 'zip', oldBase.serverZip);
mk('Own', '1.0', 'server', 'run', 'folder', ownServerDir);
await importModSet(db, { kind: 'zip', path: base.serverZip }, s.id, ctx);
await importModSet(db, { kind: 'folder', path: base.clientDir }, c.id, ctx);
await importModSet(db, { kind: 'folder', path: own.clientDir }, l.id, ctx);
db.close();
await closePool();
console.log(`Demo data ready in ${dataDir} (password: demo, port ${port})`);

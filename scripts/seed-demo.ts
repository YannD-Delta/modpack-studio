// Seeds a throwaway data directory with synthetic Base / Own packs so the UI can be looked at.
// Usage: tsx scripts/seed-demo.ts <dataDir> [port]   (login password: demo)
import fs from 'node:fs';
import path from 'node:path';
import { hashPassword } from '../src/server/api/auth.js';
import { openDb } from '../src/server/db/open.js';
import { closePool } from '../src/server/jobs/pool.js';
import { importModSet } from '../src/server/mods/import-modset.js';
import { createProfile } from '../src/server/profiles/profile-service.js';
import type { JarSpec } from '../tests/fixtures-gen/jar.js';
import { writeAtmPack } from '../tests/fixtures-gen/packs.js';

const dataDir = path.resolve(process.argv[2] ?? 'data-demo');
const port = Number(process.argv[3] ?? 8481);
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ port, passwordHash: hashPassword('demo') }));

const jar = (id: string, version = '1.0'): JarSpec => ({ fileName: `${id}-${version}.jar`, loader: 'neoforge', mods: [{ modId: id, version }] });
const shared = ['jei', 'mekanism', 'create', 'ae2', 'botania', 'thermal', 'farmersdelight', 'jade', 'curios', 'geckolib', 'supplementaries', 'chipped', 'waystones', 'ftbquests', 'ftbteams', 'sophisticatedbackpacks'];
const clientOnly = ['embeddium', 'xaerominimap', 'sodiumextras', 'journeymap'];
const serverOnly = ['spark', 'chunky'];

const atm = await writeAtmPack(path.join(dataDir, 'packs', 'atm'), {
  atm: '8.3', neoforge: '21.1.259', mc: '1.21.1',
  serverMods: [...shared, ...serverOnly].map((m) => jar(m)),
  clientMods: [...shared, ...clientOnly].map((m) => jar(m)),
});
const lmpMods = [...shared.filter((m) => m !== 'waystones').map((m) => jar(m, m === 'mekanism' || m === 'create' ? '1.1' : '1.0')), ...clientOnly.map((m) => jar(m)), jar('lmp_core'), jar('lmp_decor'), jar('lmp_tweaks')];
const lmp = await writeAtmPack(path.join(dataDir, 'packs', 'lmp'), { atm: '1.0', neoforge: '21.1.259', mc: '1.21.1', serverMods: [], clientMods: lmpMods });

const db = openDb(path.join(dataDir, 'studio.db'));
const ctx = { params: null, signal: new AbortController().signal, progress: () => undefined };
const mk = (pack: 'Base' | 'Own', version: string, side: 'client' | 'server', state: 'clean' | 'launched' | 'run', kind: 'zip' | 'folder', location: string) =>
  createProfile(db, { pack, version, side, state, locationKind: kind, location });
const s = mk('Base', '8.3', 'server', 'clean', 'zip', atm.serverZip);
const c = mk('Base', '8.3', 'client', 'clean', 'folder', atm.clientDir);
const l = mk('Own', '1.0', 'client', 'clean', 'folder', lmp.clientDir);
mk('Base', '8.2', 'server', 'clean', 'zip', 'old-atm-8.2.zip');
mk('Own', '1.0', 'server', 'run', 'agent', 'server-pc');
await importModSet(db, { kind: 'zip', path: atm.serverZip }, s.id, ctx);
await importModSet(db, { kind: 'folder', path: atm.clientDir }, c.id, ctx);
await importModSet(db, { kind: 'folder', path: lmp.clientDir }, l.id, ctx);
db.close();
await closePool();
console.log(`Demo data ready in ${dataDir} (password: demo, port ${port})`);

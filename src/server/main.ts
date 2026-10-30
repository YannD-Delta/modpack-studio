import './threadpool.js';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { buildApp } from './api/app.js';
import { loadConfig } from './config.js';
import { openDb } from './db/open.js';
import { JobRunner } from './jobs/runner.js';
import { listenLan } from './lan.js';
import { removeStaleExportLeftovers } from './mods/update-pack.js';
import { markOrphanRuns } from './testbench/runs.js';

const dataDir = process.env.STUDIO_DATA ?? path.resolve('data');
fs.mkdirSync(dataDir, { recursive: true });

// A damaged settings file or database stops the start with one readable line, not a stack trace.
function startupFailure(err: unknown): never {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
let config: ReturnType<typeof loadConfig>;
let db: ReturnType<typeof openDb>;
try {
  config = loadConfig(dataDir);
  db = openDb(path.join(dataDir, 'studio.db'), { backupDir: path.join(dataDir, 'backups') });
} catch (err) {
  startupFailure(err);
}
const jobs = new JobRunner(db);
const app = buildApp({ db, jobs, config, dataDir });

// Serve the built SPA (npm run build:web) from the same process; any non-API path falls back to index.html.
const webRoot = path.resolve('dist/web');
if (fs.existsSync(path.join(webRoot, 'index.html'))) {
  await app.register(fastifyStatic, { root: webRoot });
  app.setNotFoundHandler((req, reply) => (req.url.startsWith('/api/') ? reply.code(404).send({ error: 'not found' }) : reply.sendFile('index.html')));
}

if (!config.passwordHash) console.warn('No password set: run `npm run set-password` first, login is impossible until then.');

await app.listen({ port: config.port, host: config.bindHost });
console.log(`Modpack Studio listening on ${config.bindHost}:${config.port}`);

// Only now that the port is ours: a second process that fails to bind above must not mark the first one's live jobs as interrupted.
const interrupted = jobs.recoverInterrupted();
const closedRuns = markOrphanRuns(dataDir);
if (interrupted || closedRuns) console.log(`Previous run cut short: ${interrupted} job(s) and ${closedRuns} test run(s) marked interrupted`);

// Interrupted exports leave .partial folders behind; no export job can be running right after start.
removeStaleExportLeftovers(path.join(dataDir, 'exports'));
if (config.lanIp) {
  await app.ready();
  listenLan((req, res) => app.routing(req, res), { ip: config.lanIp, port: config.port });
}

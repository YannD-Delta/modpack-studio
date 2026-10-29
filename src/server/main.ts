import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { buildApp } from './api/app.js';
import { loadConfig } from './config.js';
import { openDb } from './db/open.js';
import { JobRunner } from './jobs/runner.js';

const dataDir = process.env.STUDIO_DATA ?? path.resolve('data');
fs.mkdirSync(dataDir, { recursive: true });

const config = loadConfig(dataDir);
const db = openDb(path.join(dataDir, 'studio.db'), { backupDir: path.join(dataDir, 'backups') });
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
if (config.lanIp) {
  await app.ready();
  http.createServer((req, res) => app.routing(req, res)).listen(config.port, config.lanIp);
}
console.log(`Modpack Studio listening on ${config.bindHost}:${config.port}${config.lanIp ? ` and ${config.lanIp}` : ''}`);

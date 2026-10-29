import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { API_PREFIX } from '../../shared/constants.js';
import { audit } from '../db/audit.js';
import { getProfile } from '../profiles/profile-service.js';
import { listRuns, readLogTail, readRun, runDir, validRunId, writeMeta } from '../testbench/runs.js';
import { runServerTest } from '../testbench/server-test.js';
import type { AppDeps } from './app.js';
import { sendBadRequest } from './routes-profiles.js';

const StartBody = z.object({
  profile: z.number().int().positive(),
  acceptEula: z.boolean().default(false),
  memoryMb: z.number().int().min(1024).max(65536).default(8192),
  port: z.number().int().min(1024).max(65535).default(25570),
  timeoutMin: z.number().int().min(1).max(60).default(10),
});
const JobParams = StartBody.extend({ runId: z.string() });
const LogQuery = z.object({ tail: z.coerce.number().int().min(1).max(2000).default(300) });

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
const slug = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

/** Throwaway server tests: a copy of a server folder is started on another port, then stopped, and its logs are kept. */
export function registerTestbenchRoutes(api: FastifyInstance, deps: AppDeps): void {
  const { db, jobs } = deps;
  const dataDir = deps.dataDir ?? path.resolve('data');

  jobs.register('server-test', async (ctx) => {
    const p = JobParams.parse(ctx.params);
    const profile = getProfile(db, p.profile);
    const result = await runServerTest({
      sourceDir: profile.location,
      runDir: runDir(dataDir, p.runId),
      port: p.port,
      memoryMb: p.memoryMb,
      acceptEula: p.acceptEula,
      readyTimeoutMs: p.timeoutMin * 60_000,
      startCommand: deps.testBenchStartCommand,
      signal: ctx.signal,
      onStatus: (status, message) => ctx.progress(status === 'done' ? 100 : status === 'ready' || status === 'stopping' ? 80 : status === 'starting' ? 30 : 10, `${status}${message ? `: ${message}` : ''}`),
    });
    audit(db, 'testbench.server', p.runId, { status: result.status, bootSeconds: result.bootSeconds, errorLines: result.summary.errorLines, crashReports: result.crashReports.length });
    if (result.status === 'failed') throw new Error(result.message ?? 'server test failed');
  });

  api.post(`${API_PREFIX}/testbench/server`, async (req, reply) => {
    const body = StartBody.safeParse(req.body);
    if (!body.success) return sendBadRequest(reply, body.error);
    let profile;
    try {
      profile = getProfile(db, body.data.profile);
    } catch {
      return reply.code(404).send({ error: 'profile not found' });
    }
    if (profile.side !== 'server') return reply.code(409).send({ error: 'pick a server profile' });
    if (profile.locationKind !== 'folder' && profile.locationKind !== 'smb') return reply.code(409).send({ error: 'only a server folder can be tested for now (not a zip)' });
    if (!fs.existsSync(profile.location) || !fs.statSync(profile.location).isDirectory()) return reply.code(409).send({ error: 'the server folder of this profile cannot be read' });

    const id = slug(`${stamp()}_${profile.pack}-${profile.version}-${profile.state}`);
    writeMeta(dataDir, { id, profileId: profile.id, label: `${profile.pack} ${profile.version} · ${profile.side} · ${profile.state}`, memoryMb: body.data.memoryMb, port: body.data.port, createdAt: new Date().toISOString(), jobId: null });
    const jobId = jobs.enqueue('server-test', { ...body.data, runId: id }, { lockKey: 'testbench' });
    const meta = readRun(dataDir, id)!.meta;
    writeMeta(dataDir, { ...meta, jobId });
    audit(db, 'testbench.start', id, { profile: profile.id, memoryMb: body.data.memoryMb, port: body.data.port });
    return reply.code(202).send({ runId: id, jobId });
  });

  api.get(`${API_PREFIX}/testbench/runs`, async () => listRuns(dataDir));

  api.get(`${API_PREFIX}/testbench/runs/:id`, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const run = validRunId(id) ? readRun(dataDir, id) : null;
    return run ?? reply.code(404).send({ error: 'run not found' });
  });

  api.get(`${API_PREFIX}/testbench/runs/:id/log`, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const q = LogQuery.safeParse(req.query);
    if (!q.success) return sendBadRequest(reply, q.error);
    const log = validRunId(id) && readRun(dataDir, id) ? readLogTail(dataDir, id, q.data.tail) : null;
    return log ?? reply.code(404).send({ error: 'run not found' });
  });

  api.post(`${API_PREFIX}/testbench/runs/:id/cancel`, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const run = validRunId(id) ? readRun(dataDir, id) : null;
    if (!run) return reply.code(404).send({ error: 'run not found' });
    if (!run.meta.jobId) return reply.code(409).send({ error: 'this run has no job to cancel' });
    jobs.cancel(run.meta.jobId);
    audit(db, 'testbench.cancel', id, {});
    return { ok: true };
  });
}

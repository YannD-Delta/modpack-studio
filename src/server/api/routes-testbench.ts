import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { API_PREFIX } from '../../shared/constants.js';
import { audit } from '../db/audit.js';
import { getProfile } from '../profiles/profile-service.js';
import { listRuns, markRunInterrupted, readLogTail, readRun, runDir, validRunId, writeMeta, type RunDetail } from '../testbench/runs.js';
import { runServerTest } from '../testbench/server-test.js';
import type { AppDeps } from './app.js';
import { sendBadRequest } from './routes-profiles.js';
import { defineLimit, getNumberLimit } from '../settings/limits.js';

defineLimit({ key: 'testbench.defaultMemoryMb', kind: 'number', default: 8192, min: 1024, max: 65536, unit: 'megabytes', group: 'testbench', label: 'Default test server memory' });
defineLimit({ key: 'testbench.defaultPort', kind: 'number', default: 25570, min: 1024, max: 65535, unit: 'port', group: 'testbench', label: 'Default test server port' });
defineLimit({ key: 'testbench.defaultTimeoutMinutes', kind: 'number', default: 10, min: 1, max: 60, unit: 'minutes', group: 'testbench', label: 'Default wait for the server to start' });

const StartBody = z.object({
  profile: z.number().int().positive(),
  acceptEula: z.boolean().default(false),
  memoryMb: z.number().int().min(1024).max(65536).default(() => getNumberLimit('testbench.defaultMemoryMb')),
  port: z.number().int().min(1024).max(65535).default(() => getNumberLimit('testbench.defaultPort')),
  timeoutMin: z.number().int().min(1).max(60).default(() => getNumberLimit('testbench.defaultTimeoutMinutes')),
  /** Keep the full server copy after the run (default: remove it, only the small result and log files stay). */
  keepCopy: z.boolean().default(false),
});
const JobParams = StartBody.extend({ runId: z.string() });
const LogQuery = z.object({ tail: z.coerce.number().int().min(1).max(2000).default(300) });

/** Two identical start requests within this window (a double click) are one run. */
export const START_DEDUPE_WINDOW_MS = 3000;
const FINAL = new Set(['done', 'failed', 'timeout', 'crashed', 'interrupted']);
const LIVE_JOB = new Set(['queued', 'running']);

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
const slug = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

/** Throwaway server tests: a copy of a server folder is started on another port, then stopped, and its logs are kept. */
export function registerTestbenchRoutes(api: FastifyInstance, deps: AppDeps): void {
  const { db, jobs } = deps;
  const dataDir = deps.dataDir ?? path.resolve('data');
  const recentStarts = new Map<string, { runId: string; jobId: string; at: number }>();

  const jobRow = (jobId: string | null) => (jobId ? (db.sqlite.prepare('SELECT status, message FROM job WHERE id = ?').get(jobId) as { status: string; message: string | null } | undefined) : undefined);

  /** A run whose job ended without writing a result (cancelled while queued, restart, crash of the job) becomes `interrupted`; the job row is the truth. */
  const settle = (run: RunDetail): RunDetail => {
    if (run.result || !run.meta.jobId) return run;
    const job = jobRow(run.meta.jobId);
    if (!job || LIVE_JOB.has(job.status)) return run;
    const message = job.status === 'cancelled' ? 'cancelled' : job.status === 'interrupted' ? 'Studio was restarted before this test finished' : (job.message ?? 'the test job ended without a result');
    try {
      markRunInterrupted(dataDir, run.meta.id, message);
    } catch {
      // read-only run folder: the answer below still carries the interrupted state
    }
    return readRun(dataDir, run.meta.id) ?? run;
  };

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
      keepCopy: p.keepCopy,
      settleMs: deps.testBenchTimings?.settleMs,
      stopGraceMs: deps.testBenchTimings?.stopGraceMs,
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

    const dedupeKey = JSON.stringify(body.data);
    const recent = recentStarts.get(dedupeKey);
    if (recent && Date.now() - recent.at < START_DEDUPE_WINDOW_MS && LIVE_JOB.has(jobRow(recent.jobId)?.status ?? '')) return reply.code(202).send({ runId: recent.runId, jobId: recent.jobId, duplicate: true });

    // Unique on the server, synchronously (no await between the check and writeMeta): the stamp only has a one second resolution.
    const base = slug(`${stamp()}_${profile.pack}-${profile.version}-${profile.state}`);
    let id = base;
    for (let n = 2; fs.existsSync(runDir(dataDir, id)); n++) id = `${base}-${n}`;
    writeMeta(dataDir, { id, profileId: profile.id, label: `${profile.pack} ${profile.version} · ${profile.side} · ${profile.state}`, memoryMb: body.data.memoryMb, port: body.data.port, createdAt: new Date().toISOString(), jobId: null });
    const jobId = jobs.enqueue('server-test', { ...body.data, runId: id }, { lockKey: 'testbench' });
    const meta = readRun(dataDir, id)!.meta;
    writeMeta(dataDir, { ...meta, jobId });
    recentStarts.set(dedupeKey, { runId: id, jobId, at: Date.now() });
    audit(db, 'testbench.start', id, { profile: profile.id, memoryMb: body.data.memoryMb, port: body.data.port });
    return reply.code(202).send({ runId: id, jobId });
  });

  api.get(`${API_PREFIX}/testbench/runs`, async () => {
    const list = listRuns(dataDir);
    let changed = false;
    for (const r of list) {
      if (FINAL.has(r.status)) continue;
      const run = readRun(dataDir, r.id);
      if (run && settle(run) !== run) changed = true;
    }
    return changed ? listRuns(dataDir) : list;
  });

  api.get(`${API_PREFIX}/testbench/runs/:id`, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const run = validRunId(id) ? readRun(dataDir, id) : null;
    return run ? settle(run) : reply.code(404).send({ error: 'run not found', code: 'run-not-found' });
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
    const found = validRunId(id) ? readRun(dataDir, id) : null;
    if (!found) return reply.code(404).send({ error: 'run not found', code: 'run-not-found' });
    const run = settle(found);
    if (run.result) return reply.code(409).send({ error: 'this test is already finished', code: 'run-finished' });
    if (!run.meta.jobId) return reply.code(409).send({ error: 'this run has no job to cancel', code: 'no-job' });
    if (!LIVE_JOB.has(jobRow(run.meta.jobId)?.status ?? '')) return reply.code(409).send({ error: 'the job of this test is not running', code: 'job-not-live' });
    jobs.cancel(run.meta.jobId);
    settle(run); // a job cancelled while queued never runs: close the run now
    audit(db, 'testbench.cancel', id, {});
    return { ok: true };
  });
}

import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { API_PREFIX } from '../../shared/constants.js';
import { removeFromBlacklist, setBlacklistReason } from '../mods/blacklist-service.js';
import { DECISION_KINDS, debugInfo, JOB_STATUSES, listAudit, listJobs, listMemory, setDecisionReason, unsetDecision } from '../mods/decisions-service.js';
import type { AppDeps } from './app.js';
import { sendBadRequest } from './routes-profiles.js';

const modId = z.string().min(1).max(200);
const DecisionParams = z.object({ modId, kind: z.enum(DECISION_KINDS) });
const ReasonBody = z.object({ reason: z.string().max(500) });
const AuditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  before: z.coerce.number().int().positive().optional(),
  q: z.string().max(200).optional(),
});
const JobsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  status: z.enum(JOB_STATUSES).optional(),
});

/** Remembered decisions (list, undo, re-explain) and the read-only debug journal. Thin: the logic lives in decisions-service. */
export function registerDecisionsRoutes(api: FastifyInstance, deps: AppDeps): void {
  const { db } = deps;
  const dataDir = deps.dataDir ?? path.resolve('data');

  api.get(`${API_PREFIX}/decisions`, async () => listMemory(db));

  api.delete(`${API_PREFIX}/decisions/:modId/:kind`, async (req, reply) => {
    const p = DecisionParams.safeParse(req.params);
    if (!p.success) return sendBadRequest(reply, p.error);
    if (!unsetDecision(db, p.data.modId, p.data.kind)) return reply.code(404).send({ error: `no ${p.data.kind} decision for ${p.data.modId}` });
    return { ok: true };
  });

  api.put(`${API_PREFIX}/decisions/:modId/:kind/reason`, async (req, reply) => {
    const p = DecisionParams.safeParse(req.params);
    if (!p.success) return sendBadRequest(reply, p.error);
    const body = ReasonBody.safeParse(req.body);
    if (!body.success) return sendBadRequest(reply, body.error);
    if (!setDecisionReason(db, p.data.modId, p.data.kind, body.data.reason)) return reply.code(404).send({ error: `no ${p.data.kind} decision for ${p.data.modId}` });
    return { ok: true };
  });

  api.delete(`${API_PREFIX}/blacklist/entry/:modId`, async (req, reply) => {
    const p = z.object({ modId }).safeParse(req.params);
    if (!p.success) return sendBadRequest(reply, p.error);
    const result = removeFromBlacklist(db, p.data.modId);
    if (result === 'absent') return reply.code(404).send({ error: `${p.data.modId} is not on your blacklist` });
    if (result === 'atm_derived') return reply.code(409).send({ error: `${p.data.modId} comes from ATM10 (client-only), it is recomputed and cannot be removed here` });
    return { ok: true };
  });

  api.put(`${API_PREFIX}/blacklist/entry/:modId/reason`, async (req, reply) => {
    const p = z.object({ modId }).safeParse(req.params);
    if (!p.success) return sendBadRequest(reply, p.error);
    const body = ReasonBody.safeParse(req.body);
    if (!body.success) return sendBadRequest(reply, body.error);
    const result = setBlacklistReason(db, p.data.modId, body.data.reason);
    if (result === 'absent') return reply.code(404).send({ error: `${p.data.modId} is not on your blacklist` });
    if (result === 'atm_derived') return reply.code(409).send({ error: `${p.data.modId} comes from ATM10 (client-only), its reason is computed` });
    return { ok: true };
  });

  api.get(`${API_PREFIX}/debug/audit`, async (req, reply) => {
    const q = AuditQuery.safeParse(req.query);
    if (!q.success) return sendBadRequest(reply, q.error);
    return listAudit(db, q.data);
  });

  api.get(`${API_PREFIX}/debug/jobs`, async (req, reply) => {
    const q = JobsQuery.safeParse(req.query);
    if (!q.success) return sendBadRequest(reply, q.error);
    return { jobs: listJobs(db, q.data) };
  });

  api.get(`${API_PREFIX}/debug/info`, async () => debugInfo(db, { dataDir }));
}

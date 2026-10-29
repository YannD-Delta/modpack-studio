import { api } from './api.js';

export type DecisionKind = 'pin' | 'ignore' | 'side';
export type Side = 'client' | 'server' | 'both';
export type DecisionRow = { modId: string; kind: DecisionKind; side: Side | null; reason: string; createdAt: string };
export type UserBlacklistRow = { modId: string; origin: 'yann'; reason: string; createdAt: string | null };
export type Memory = { decisions: DecisionRow[]; blacklist: UserBlacklistRow[]; atmDerivedCount: number };

export type AuditEntry = { id: number; at: string; actor: string; action: string; target: string | null; payload: unknown; payloadValid: boolean };
export type AuditPage = { entries: AuditEntry[]; nextBefore: number | null };

export const JOB_STATUSES = ['queued', 'running', 'done', 'failed', 'cancelled', 'interrupted'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export type JobRow = {
  id: string;
  type: string;
  status: JobStatus;
  progress: number | null;
  message: string | null;
  lockKey: string | null;
  params: string;
  paramsTruncated: boolean;
  createdAt: string;
  updatedAt: string;
};

export type DebugInfo = {
  studioVersion: string;
  node: string;
  platform: string;
  uptimeSeconds: number;
  dataDir: string;
  db: { file: string | null; sizeBytes: number | null; migrations: number };
  counts: {
    profiles: number;
    jars: number;
    modRows: number;
    decisions: Record<DecisionKind, number>;
    blacklist: { yann: number; atmDerived: number };
    jobs: Record<JobStatus, number>;
    auditEntries: number;
  };
};

const enc = encodeURIComponent;

export const getMemory = () => api<Memory>('/decisions');
export const unsetDecision = (modId: string, kind: DecisionKind) => api(`/decisions/${enc(modId)}/${kind}`, { method: 'DELETE' });
export const setDecisionReason = (modId: string, kind: DecisionKind, reason: string) => api(`/decisions/${enc(modId)}/${kind}/reason`, { method: 'PUT', body: { reason } });
export const setBlacklistReason = (modId: string, reason: string) => api(`/blacklist/entry/${enc(modId)}/reason`, { method: 'PUT', body: { reason } });
export const removeBlacklistEntry =(modId: string) => api(`/blacklist/entry/${enc(modId)}`, { method: 'DELETE' });

export function getAudit(opts: { limit?: number; before?: number; q?: string } = {}): Promise<AuditPage> {
  const params = new URLSearchParams();
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.before) params.set('before', String(opts.before));
  if (opts.q) params.set('q', opts.q);
  const qs = params.toString();
  return api<AuditPage>(`/debug/audit${qs ? `?${qs}` : ''}`);
}

export const getJobs = (status?: JobStatus) => api<{ jobs: JobRow[] }>(`/debug/jobs${status ? `?status=${status}` : ''}`);
export const getDebugInfo = () => api<DebugInfo>('/debug/info');

import { api } from './api.js';

export type RunState = 'queued' | 'copying' | 'starting' | 'ready' | 'stopping' | 'done' | 'failed' | 'timeout' | 'crashed' | 'interrupted';
export const FINAL_STATES: RunState[] = ['done', 'failed', 'timeout', 'crashed', 'interrupted'];

export type RunSummary = {
  id: string;
  profileId: number;
  label: string;
  memoryMb: number;
  port: number;
  createdAt: string;
  jobId: string | null;
  status: RunState;
  message: string | null;
  bootSeconds: number | null;
  errorLines: number | null;
  warnLines: number | null;
  crashReports: number;
};
/** How the test server went down: asked nicely, killed after the grace period, or gone before Studio stopped it. */
export type StopOutcome = 'clean' | 'forced' | 'exited-early';
export type RunResult = {
  status: RunState;
  bootSeconds: number | null;
  exitCode: number | null;
  startedAt: string;
  endedAt: string;
  summary: { bootSeconds: number | null; errorLines: number; warnLines: number; firstErrors: string[] };
  crashReports: string[];
  modJars: number;
  disabledMods: string[];
  message?: string;
  stopOutcome?: StopOutcome;
};
export type RunDetail = { meta: Omit<RunSummary, 'status' | 'message' | 'bootSeconds' | 'errorLines' | 'warnLines' | 'crashReports'>; status: RunState; message: string | null; result: RunResult | null };
export type StartOptions = { profile: number; acceptEula: boolean; memoryMb: number; port: number; timeoutMin: number };

export const testbenchApi = {
  runs: () => api<RunSummary[]>('/testbench/runs'),
  run: (id: string) => api<RunDetail>(`/testbench/runs/${encodeURIComponent(id)}`),
  log: (id: string, tail = 200) => api<{ lines: string[]; total: number }>(`/testbench/runs/${encodeURIComponent(id)}/log?tail=${tail}`),
  start: (o: StartOptions) => api<{ runId: string; jobId: string }>('/testbench/server', { method: 'POST', body: o }),
  cancel: (id: string) => api(`/testbench/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: {} }),
};

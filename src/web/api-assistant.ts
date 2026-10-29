import { api } from './api.js';

export type ActionId = 'review-updates' | 'review-added' | 'review-missing' | 'migrate-old-pack' | 'analyze-test-run';
export type ActionInfo = { id: ActionId; label: string; tip: string };
export type BuiltPrompt = { action: ActionId; title: string; prompt: string; rows: number; shown: number };
export type RunResult = { text: string; model: string; effort: string; inputTokens: number; outputTokens: number; rows: number; shown: number };

export const assistantApi = {
  actions: () => api<ActionInfo[]>('/assistant/actions'),
  prompt: (action: ActionId, base: number, other: number) => api<BuiltPrompt>('/assistant/prompt', { method: 'POST', body: { action, base, other, mode: 'chat' } }),
  run: (action: ActionId, base: number, other: number) => api<RunResult>('/assistant/run', { method: 'POST', body: { action, base, other } }),
  promptRun: (runId: string) => api<BuiltPrompt>('/assistant/prompt', { method: 'POST', body: { action: 'analyze-test-run', runId, mode: 'chat' } }),
  runRun: (runId: string) => api<RunResult>('/assistant/run', { method: 'POST', body: { action: 'analyze-test-run', runId } }),
};

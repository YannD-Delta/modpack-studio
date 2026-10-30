import { api } from './api.js';

export type LeftOut = { kind: 'mod' | 'path'; key: string; reason: string };
export type ServerPackResult = { name: string; folder: string; zip: string; zipBytes: number; mods: number; files: number; leftOut: LeftOut[]; unlisted: string[] };
export type MarkerHit = { pattern: string; line: number | null };
export type ClientLogs = {
  profile: { id: number; label: string };
  log: { present: boolean; truncated: boolean; bytesRead: number; lines: number; errorLines: number; warnLines: number; firstErrors: string[]; markers: MarkerHit[]; reachedAllMarkers: boolean };
  crashReports: { name: string; modified: string; headline: string | null; head: string }[];
  mods: { count: number; onlyInInstance: string[]; onlyInImport: string[]; imported: boolean };
  markersUsed: string[];
};

export const buildApi = {
  serverPack: (profile: number) => api<ServerPackResult>('/build/server-pack', { method: 'POST', body: { profile } }),
  clientLogs: (profile: number) => api<ClientLogs>(`/testbench/client-logs?profile=${profile}`),
  clientPrompt: (profile: number) => api<{ prompt: string }>('/testbench/client-logs/prompt', { method: 'POST', body: { profile, mode: 'chat' } }),
};

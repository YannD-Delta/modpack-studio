import { api, ApiError } from './api.js';

export type LeftOut = { kind: 'mod' | 'path'; key: string; reason: string };
export type UndecidedMod = { modId: string; file: string };
export type ServerPackResult = { name: string; folder: string; zip: string; zipBytes: number; mods: number; files: number; leftOut: LeftOut[]; unlisted: string[]; undecided: UndecidedMod[] };
export type PackSide = 'server' | 'client' | 'both';

/** The mods to decide when a build was refused with `sides_undecided`, else null. */
export const undecidedOf = (err: unknown): UndecidedMod[] | null =>
  err instanceof ApiError && err.code === 'sides_undecided' && Array.isArray(err.body?.undecided) ? (err.body.undecided as UndecidedMod[]) : null;
export type MarkerHit = { pattern: string; line: number | null };
export type ClientLogs = {
  profile: { id: number; label: string };
  log: { present: boolean; truncated: boolean; bytesRead: number; lines: number; errorLines: number; warnLines: number; firstErrors: string[]; markers: MarkerHit[]; reachedAllMarkers: boolean };
  crashReports: { name: string; modified: string; headline: string | null; head: string }[];
  mods: { count: number; onlyInInstance: string[]; onlyInImport: string[]; imported: boolean };
  markersUsed: string[];
};

export const buildApi = {
  serverPack: (profile: number, includeUnknown?: boolean) => api<ServerPackResult>('/build/server-pack', { method: 'POST', body: includeUnknown === undefined ? { profile } : { profile, includeUnknown } }),
  decideSide: (modId: string, side: PackSide, reason: string) => api(`/mods/${encodeURIComponent(modId)}/decision`, { method: 'PUT', body: { kind: 'side', side, reason } }),
  clientLogs: (profile: number) => api<ClientLogs>(`/testbench/client-logs?profile=${profile}`),
  clientPrompt: (profile: number) => api<{ prompt: string }>('/testbench/client-logs/prompt', { method: 'POST', body: { profile, mode: 'chat' } }),
};

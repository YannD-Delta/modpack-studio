import { api } from './api.js';

export type Project = { id: number; name: string; baseVersion: string | null; createdAt: string; changes?: number };
export type StoredChange = { id: number; kind: 'file' | 'mod'; key: string; action: string; validatedAt: string; payload: Record<string, unknown> };
export type ProposedFile = { path: string; status: string; validated: boolean; playedSize: number | null };
export type ProposedMod = { modId: string; action: 'add' | 'update' | 'remove'; version: string | null; baseVersion: string | null; file: string | null; validated: boolean };
export type Proposal = { files: ProposedFile[]; mods: ProposedMod[] };
export type ReplayStatus = 'safe' | 'already' | 'conflict' | 'warning';
export type PreviewItem = {
  id: number;
  kind: 'file' | 'mod';
  key: string;
  action: string;
  status: ReplayStatus;
  reason: string;
  mine: { version?: string | null; size?: number };
  newBase: { version?: string; size?: number } | null;
};
export type Preview = {
  project: Project;
  newClean: { id: number; label: string };
  missing: { scan: boolean; import: boolean };
  summary: Record<ReplayStatus, number>;
  items: PreviewItem[];
  baseDiff: { added: number; removed: number; updated: number } | null;
};
export type Triad = { clean: number; launched: number; candidate: number };

const triadQuery = (t: Triad) => `clean=${t.clean}&launched=${t.launched}&candidate=${t.candidate}`;

export const projectsApi = {
  list: () => api<{ projects: Project[] }>('/projects'),
  create: (name: string) => api<Project>('/projects', { method: 'POST', body: { name } }),
  get: (id: number) => api<{ project: Project; changes: StoredChange[] }>(`/projects/${id}`),
  proposal: (id: number, t: Triad) => api<Proposal>(`/projects/${id}/proposal?${triadQuery(t)}`),
  save: (id: number, t: Triad, files: string[], mods: string[]) => api<{ ok: boolean; files: number; mods: number; changes: StoredChange[] }>(`/projects/${id}/changes`, { method: 'POST', body: { ...t, files, mods } }),
  removeChange: (id: number, changeId: number) => api(`/projects/${id}/changes/${changeId}`, { method: 'DELETE' }),
  preview: (id: number, newClean: number, oldClean?: number) => api<Preview>(`/projects/${id}/preview?newClean=${newClean}${oldClean ? `&oldClean=${oldClean}` : ''}`),
};

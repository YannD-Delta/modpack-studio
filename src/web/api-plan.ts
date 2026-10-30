import { api, type ModEntry } from './api.js';

export type PlanKind = 'mod' | 'file';
export type PlanItem = { kind: PlanKind; key: string; action: 'take_ref' };
export type PlanDecisions = { pins: string[]; ignored: string[]; clientOnly: string[] };
export type PlanState = { items: PlanItem[]; decisions: PlanDecisions };

export type ExportFailure = { kind: PlanKind; key: string; reason: string };
export type ExportCounts = { modsUpdated: number; modsRestored: number; jarsToRemove: number; files: number; failures: number };
export type ExportResult = {
  name: string;
  folder: string;
  zipPath: string;
  zipBytes: number;
  createdAt: string;
  base: { id: number; label: string };
  other: { id: number; label: string };
  counts: ExportCounts;
  failures: ExportFailure[];
  warnings: string[];
};
export type ExportJob = { id: string; status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted'; progress: number | null; message: string | null; name: string | null };

export type VersionOrder = 'newer' | 'older' | 'equal' | 'incomparable';
type DebugSide = { profile: { id: number; label: string; pack: string; version: string; side: string; state: string; locationKind: string; location: string }; entry: ModEntry | null };
type DecisionInfo = { side: string | null; reason: string; createdAt: string } | null;
export type ModDebug = {
  modId: string;
  generatedAt: string;
  status: string;
  base: DebugSide;
  other: DebugSide;
  comparison: {
    comparedAs: string;
    a: { raw: string; tokens: string[]; hashLike: boolean; unparsable: boolean };
    b: { raw: string; tokens: string[]; hashLike: boolean; unparsable: boolean };
    result: VersionOrder;
    deciding: { index: number; tokenA: string | null; tokenB: string | null } | null;
    note: string;
  } | null;
  decisions: { pin: DecisionInfo; ignore: DecisionInfo; side: DecisionInfo; blacklisted: { origin: string; stale: boolean; upstreamVersion: string } | null };
  plan: { planned: boolean; actionable: boolean; action: 'update' | 'restore' | null };
  duplicates: { base: string[] | null; other: string[] | null };
  sourceJar: { side: 'base'; locationKind: string; path: string | null; exists: boolean; size: number | null; sha256Recorded: string; sha256Actual: string | null; matches: boolean; error: string | null } | null;
};

const pair = (base: string | number, other: string | number) => `base=${encodeURIComponent(String(base))}&other=${encodeURIComponent(String(other))}`;

export const getPlan = (base: string, other: string) => api<PlanState>(`/plan?${pair(base, other)}`);
export const putPlan = (body: { base: number; other: number; kind: PlanKind; keys: string[]; selected: boolean }) =>
  api<{ ok: boolean; items?: PlanItem[] }>('/plan', { method: 'PUT', body });
export const clearModPlan = (base: string, other: string) => api<{ ok: boolean }>(`/plan?${pair(base, other)}&kind=mod`, { method: 'DELETE' });
export const startExport = (base: number, other: number) => api<{ jobId: string }>('/plan/export', { method: 'POST', body: { base, other } });
export const getExportJob = (jobId: string) => api<ExportJob>(`/plan/jobs/${encodeURIComponent(jobId)}`);
export const getExport = (name: string) => api<{ result: ExportResult; folder: string }>(`/plan/exports/${encodeURIComponent(name)}`);
export const exportDownloadUrl = (name: string) => `/api/v1/plan/exports/${encodeURIComponent(name)}/download`;
export const getModDebug = (modId: string, base: string, other: string) => api<ModDebug>(`/mods/${encodeURIComponent(modId)}/debug?${pair(base, other)}`);

/** Clipboard API when available (secure context), else the old hidden-textarea trick. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // falls through to the textarea fallback (plain http on the LAN is not a secure context)
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

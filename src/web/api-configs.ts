import { api } from './api.js';

export type FileStatus = 'onlyInBase' | 'modified' | 'binaryDiffers' | 'tooLarge' | 'onlyInOther' | 'cosmetic' | 'identical';

/** Most serious first, same order as the server sort. */
export const FILE_STATUSES: FileStatus[] = ['onlyInBase', 'modified', 'binaryDiffers', 'tooLarge', 'onlyInOther', 'cosmetic', 'identical'];
/** Statuses the update plan accepts ("take the reference's version"). */
export const PLANNABLE_STATUSES: ReadonlySet<FileStatus> = new Set<FileStatus>(['modified', 'onlyInBase']);
export const TRACKED_ROOTS = ['config', 'defaultconfigs', 'kubejs', 'scripts', 'datapacks', 'global_packs'] as const;

export type ConfigProfileInfo = { id: number; pack: string; version: string; side: string; state: string; immutable: boolean; scannedAt: string | null };
export type ConfigInventory = {
  profile: ConfigProfileInfo;
  scannedAt: string;
  total: number;
  bytes: number;
  perRoot: Record<string, { files: number; bytes: number }>;
  issueCount: number;
  issues: { path: string; reason: string }[];
};
export type ConfigDiffFile = { path: string; root: string; ext: string; kind: 'text' | 'binary'; status: FileStatus; baseSize: number | null; otherSize: number | null };
export type ConfigDiff = {
  base: ConfigProfileInfo;
  other: ConfigProfileInfo;
  summary: { perStatus: Record<FileStatus, number>; perRoot: Record<string, Record<FileStatus, number>> };
  files: ConfigDiffFile[];
  total: number;
  truncated: boolean;
};
export type DiffLine = { type: 'equal' | 'add' | 'del'; text: string; oldNo: number | null; newNo: number | null };
export type FileDiff = {
  path: string;
  status: FileStatus;
  kind: 'text' | 'binary';
  baseSize: number | null;
  otherSize: number | null;
  binary: boolean;
  tooLarge: boolean;
  truncated: boolean;
  coarse: boolean;
  stale: boolean;
  added: number;
  removed: number;
  lines: DiffLine[];
};
export type ScanStart = { jobId: string | null; cached?: boolean; scannedAt?: string };
export type ScanJob = { status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted'; progress: number | null; message: string | null };

export const configsApi = {
  inventory: (profile: number | string) => api<ConfigInventory>(`/configs/inventory?profile=${profile}`),
  diff: (base: number | string, other: number | string) => api<ConfigDiff>(`/configs/diff?base=${base}&other=${other}`),
  fileDiff: (base: number | string, other: number | string, path: string) =>
    api<FileDiff>(`/configs/filediff?base=${base}&other=${other}&path=${encodeURIComponent(path)}`),
  scan: (profile: number, force: boolean, deep = false) => api<ScanStart>('/configs/scan', { method: 'POST', body: { profile, force, deep } }),
  job: (jobId: string) => api<ScanJob>(`/configs/scan/${jobId}`),
  plan: (base: number | string, other: number | string) => api<{ paths: string[] }>(`/configs/plan?base=${base}&other=${other}`),
  setPlan: (base: number, other: number, paths: string[], selected: boolean) =>
    api<{ ok: true; paths: string[] }>('/configs/plan', { method: 'PUT', body: { base, other, paths, selected } }),
};

export type CustomStatus = 'modifiedGenerated' | 'modifiedShipped' | 'added' | 'removed' | 'untouched';
export const CUSTOM_STATUSES: CustomStatus[] = ['modifiedGenerated', 'modifiedShipped', 'added', 'removed', 'untouched'];
export type CustomFile = {
  path: string;
  root: string;
  ext: string;
  kind: 'text' | 'binary';
  status: CustomStatus;
  include: boolean;
  inClean: boolean;
  launchedSize: number | null;
  playedSize: number | null;
};
export type Customizations = {
  files: CustomFile[];
  summary: { perStatus: Record<CustomStatus, number>; include: number; perRoot: Record<string, Record<CustomStatus, number>> };
  total: number;
};
export const customizationsApi = {
  get: (clean: string, launched: string, played: string) => api<Customizations>(`/configs/customizations?clean=${clean}&launched=${launched}&played=${played}`),
  setPlan: (clean: number, launched: number, played: number, paths: string[], selected: boolean) =>
    api<{ ok: boolean; paths: string[] }>('/configs/customizations/plan', { method: 'PUT', body: { clean, launched, played, paths, selected } }),
};

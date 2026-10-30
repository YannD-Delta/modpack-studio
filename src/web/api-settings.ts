import { api } from './api.js';

export type Provider = 'claude' | 'curseforge';
export type KeyStatus = { configured: boolean; last4: string | null };
export type Effort = 'low' | 'medium' | 'high';
export type LimitView = {
  key: string;
  kind: 'number' | 'list' | 'pattern';
  group: string;
  label: string;
  default: number | string | string[];
  value: number | string | string[];
  overridden: boolean;
  min?: number;
  max?: number;
  maxItems?: number;
};
export type SettingsData = {
  keys: Record<Provider, KeyStatus>;
  assistant: { model: string; effort: Effort };
  packs: { upstream: string; own: string };
  limits?: LimitView[];
  models: { id: string; label: string }[];
  efforts: Effort[];
};
export type KeyTest = { ok: boolean; code: 'ok' | 'rejected' | 'unexpected' | 'unreachable' | 'not_configured'; status?: number };

export const settingsApi = {
  get: () => api<SettingsData>('/settings'),
  setKey: (provider: Provider, key: string) => api('/settings/keys', { method: 'PUT', body: { provider, key } }),
  removeKey: (provider: Provider) => api(`/settings/keys/${provider}`, { method: 'DELETE' }),
  testKey: (provider: Provider) => api<KeyTest>('/settings/keys/test', { method: 'POST', body: { provider } }),
  setPacks: (upstream: string, own: string) => api<{ ok: boolean; packs: { upstream: string; own: string } }>('/settings/packs', { method: 'PUT', body: { upstream, own } }),
  setLimits: (values: Record<string, unknown>) => api<{ ok: boolean; limits: LimitView[] }>('/settings/limits', { method: 'PUT', body: { values } }),
  setAssistant: (model: string, effort: Effort) => api('/settings/assistant', { method: 'PUT', body: { model, effort } }),
};

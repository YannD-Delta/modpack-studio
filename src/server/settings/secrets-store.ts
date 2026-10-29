import fs from 'node:fs';
import path from 'node:path';

export const PROVIDERS = ['claude', 'curseforge'] as const;
export type Provider = (typeof PROVIDERS)[number];

export const MODELS = [
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
] as const;
export const EFFORTS = ['low', 'medium', 'high'] as const;
export type Effort = (typeof EFFORTS)[number];
export type AssistantPrefs = { model: string; effort: Effort };
export const DEFAULT_PREFS: AssistantPrefs = { model: 'claude-sonnet-5-5', effort: 'medium' };

/** Printable ASCII without spaces, 8 to 400 characters: every API key format in use fits, a pasted sentence or newline does not. */
const KEY_SHAPE = /^[\x21-\x7E]{8,400}$/;
export const isValidKey = (key: string): boolean => KEY_SHAPE.test(key);

const secretsFile = (dataDir: string) => path.join(dataDir, 'secrets.json');
const prefsFile = (dataDir: string) => path.join(dataDir, 'preferences.json');

function readJson(file: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Writes atomically (temp file + rename) so a crash never leaves a truncated file. */
function writeJson(file: string, data: unknown, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.part`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

export function getSecret(dataDir: string, provider: Provider): string | null {
  const v = readJson(secretsFile(dataDir))[provider];
  return typeof v === 'string' && isValidKey(v) ? v : null;
}

/** Stores (or removes, with `null`) one key. The value lives only in `<dataDir>/secrets.json`, which git ignores. */
export function setSecret(dataDir: string, provider: Provider, key: string | null): void {
  const all = readJson(secretsFile(dataDir));
  if (key === null) delete all[provider];
  else all[provider] = key;
  writeJson(secretsFile(dataDir), all, 0o600);
}

export type KeyStatus = { configured: boolean; last4: string | null };

/** What the UI may know about a key: whether it exists and its last 4 characters, never the value. */
export function keyStatus(dataDir: string, provider: Provider): KeyStatus {
  const key = getSecret(dataDir, provider);
  return key ? { configured: true, last4: key.slice(-4) } : { configured: false, last4: null };
}

export function readPrefs(dataDir: string): AssistantPrefs {
  const a = readJson(prefsFile(dataDir)).assistant as Partial<AssistantPrefs> | undefined;
  const model = MODELS.some((m) => m.id === a?.model) ? (a!.model as string) : DEFAULT_PREFS.model;
  const effort = EFFORTS.includes(a?.effort as Effort) ? (a!.effort as Effort) : DEFAULT_PREFS.effort;
  return { model, effort };
}

export function writePrefs(dataDir: string, prefs: AssistantPrefs): void {
  writeJson(prefsFile(dataDir), { ...readJson(prefsFile(dataDir)), assistant: prefs });
}

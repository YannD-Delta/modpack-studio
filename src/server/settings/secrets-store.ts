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

/** A settings file exists but cannot be used. Saving over it would lose its content, so every write is refused. */
export class SettingsFileError extends Error {
  readonly code = 'settings_unreadable';
  constructor(file: string, reason: string, readonly aside: string | null) {
    super(`${path.basename(file)} cannot be read (${reason}); nothing was saved. ${aside ? `A copy was kept as ${path.basename(aside)}. ` : ''}Fix or delete the file, then try again.`);
    this.name = 'SettingsFileError';
  }
}

/** Strict read: a missing file is empty, anything else that fails (parse error, wrong shape, locked file) throws. A leading BOM is ignored. */
export function readJsonStrict(file: string): Record<string, unknown> {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new SettingsFileError(file, (err as NodeJS.ErrnoException).code ?? 'read error', null);
  }
  try {
    const parsed: unknown = JSON.parse(text.replace(/^﻿/, ''));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    throw new Error('not a JSON object');
  } catch (err) {
    throw new SettingsFileError(file, err instanceof SyntaxError ? 'invalid JSON' : (err as Error).message, keepAside(file));
  }
}

/** Copies a broken file next to itself as `<name>.corrupt-<timestamp>` so a hand edit is never lost. */
function keepAside(file: string): string | null {
  try {
    const aside = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(file, aside);
    return aside;
  } catch {
    return null;
  }
}

/** Lenient read for display: a damaged file reads as empty (defaults), but is never written over (see writers). */
function readJson(file: string): Record<string, unknown> {
  try {
    return readJsonStrict(file);
  } catch {
    return {};
  }
}

/** Writes atomically (temp file + rename) so a crash never leaves a truncated file. */
export function writeJsonAtomic(file: string, data: unknown, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.part`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), mode ? { mode } : undefined);
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** Read-modify-write that refuses to start from an unreadable file. */
function update(file: string, change: (current: Record<string, unknown>) => Record<string, unknown>, mode?: number): void {
  writeJsonAtomic(file, change(readJsonStrict(file)), mode);
}

/**
 * Replaces the password hash in settings.json, only when the file still holds `expected` (a password changed out of band
 * is never reverted). Best effort: returns false instead of throwing.
 */
export function rewritePasswordHash(dataDir: string, expected: string, next: string): boolean {
  try {
    const file = path.join(dataDir, 'settings.json');
    const current = readJsonStrict(file);
    if (current.passwordHash !== expected) return false;
    writeJsonAtomic(file, { ...current, passwordHash: next });
    return true;
  } catch {
    return false;
  }
}

export function getSecret(dataDir: string, provider: Provider): string | null {
  const v = readJson(secretsFile(dataDir))[provider];
  return typeof v === 'string' && isValidKey(v) ? v : null;
}

/** Stores (or removes, with `null`) one key. The value lives only in `<dataDir>/secrets.json`, which git ignores. */
export function setSecret(dataDir: string, provider: Provider, key: string | null): void {
  update(secretsFile(dataDir), (all) => {
    const next = { ...all };
    if (key === null) delete next[provider];
    else next[provider] = key;
    return next;
  }, 0o600);
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
  update(prefsFile(dataDir), (all) => ({ ...all, assistant: prefs }));
}

/** The whole preferences file, for settings that live beside the assistant ones (pack names). */
export const readPrefsFile = (dataDir: string): Record<string, unknown> => readJson(prefsFile(dataDir));
/** Throws SettingsFileError when the preferences file exists but is unusable. */
export const checkPrefsFile = (dataDir: string): void => void readJsonStrict(prefsFile(dataDir));

/** Merges one section into the preferences file; refuses to write when the file is unreadable. */
export const updatePrefsFile = (dataDir: string, change: (current: Record<string, unknown>) => Record<string, unknown>): void => update(prefsFile(dataDir), change);

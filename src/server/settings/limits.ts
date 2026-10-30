import { readPrefsFile, updatePrefsFile } from './secrets-store.js';

/**
 * Tunable limits, lists and patterns. Each module registers its own with a neutral default (the value that used to be a constant);
 * the Settings tab edits them and they are stored in the `limits` section of data/preferences.json.
 */
export type LimitUnit = 'bytes' | 'count' | 'ms' | 'lines' | 'port' | 'seconds' | 'minutes' | 'megabytes' | 'kilobytes' | 'hours';

type Common = { key: string; group: string; label: string };
export type NumberLimit = Common & { kind: 'number'; default: number; min: number; max: number; unit: LimitUnit };
export type ListLimit = Common & { kind: 'list'; default: readonly string[]; maxItems: number };
export type PatternLimit = Common & { kind: 'pattern'; default: string };
export type LimitDef = NumberLimit | ListLimit | PatternLimit;
export type LimitValue = number | string[] | string;

export class LimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LimitError';
  }
}

const registry = new Map<string, LimitDef>();
let overrides: Record<string, LimitValue> = {};

/** Registers a limit (idempotent for the same key) and returns its key. */
export function defineLimit(def: LimitDef): string {
  registry.set(def.key, def);
  return def.key;
}

const ITEM_MAX_LENGTH = 200;

/** Returns the cleaned value, or throws LimitError. */
function check(def: LimitDef, value: unknown): LimitValue {
  if (def.kind === 'number') {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < def.min || value > def.max) throw new LimitError(`${def.key} must be a whole number from ${def.min} to ${def.max}`);
    return value;
  }
  if (def.kind === 'list') {
    if (!Array.isArray(value) || value.length > def.maxItems || value.some((v) => typeof v !== 'string' || !v.trim() || v.length > ITEM_MAX_LENGTH)) {
      throw new LimitError(`${def.key} must be a list of at most ${def.maxItems} non-empty texts`);
    }
    return value.map((v) => (v as string).trim());
  }
  if (typeof value !== 'string' || !value.trim() || value.length > ITEM_MAX_LENGTH) throw new LimitError(`${def.key} must be a non-empty pattern`);
  try {
    new RegExp(value);
  } catch {
    throw new LimitError(`${def.key} is not a valid regular expression`);
  }
  return value;
}

/** Loads the saved values; anything damaged or out of range silently falls back to the default. */
export function configureLimits(dataDir: string): void {
  overrides = {};
  const saved = readPrefsFile(dataDir).limits;
  if (typeof saved !== 'object' || saved === null) return;
  for (const [key, value] of Object.entries(saved as Record<string, unknown>)) {
    const def = registry.get(key);
    if (!def) continue;
    try {
      overrides[key] = check(def, value);
    } catch {
      // keep the default
    }
  }
}

export function getLimit(key: string): LimitValue {
  const def = registry.get(key);
  if (!def) throw new LimitError(`unknown limit ${key}`);
  return (key in overrides ? overrides[key] : def.default) as LimitValue;
}

export const getNumberLimit = (key: string): number => getLimit(key) as number;
export const getListLimit = (key: string): string[] => [...(getLimit(key) as string[])];

export type LimitView = LimitDef & { value: LimitValue; overridden: boolean };

export function listLimits(): LimitView[] {
  return [...registry.values()]
    .sort((a, b) => a.group.localeCompare(b.group) || a.key.localeCompare(b.key))
    .map((def) => ({ ...def, value: (def.key in overrides ? overrides[def.key] : def.default) as LimitValue, overridden: def.key in overrides }));
}

/** Validates every entry first, then saves them together; null resets a limit to its default. Nothing is written when one entry is refused. */
export function setLimits(dataDir: string, patch: Record<string, unknown>): void {
  const next = { ...overrides };
  for (const [key, value] of Object.entries(patch)) {
    const def = registry.get(key);
    if (!def) throw new LimitError(`unknown limit ${key}`);
    if (value === null) delete next[key];
    else next[key] = check(def, value);
  }
  updatePrefsFile(dataDir, (all) => ({ ...all, limits: next }));
  overrides = next;
}

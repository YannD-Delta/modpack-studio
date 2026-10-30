import { api } from './api.js';

export type KeyDiffData = {
  path: string;
  format: 'toml' | 'json' | 'properties' | null;
  /** False: show the line diff instead (`reason` says why). */
  parsable: boolean;
  reason?: 'unsupported' | 'tooLarge' | 'unparsable';
  detail?: string;
  baseSize: number | null;
  otherSize: number | null;
  stale: boolean;
  diff: {
    added: { key: string; value: string }[];
    removed: { key: string; value: string }[];
    changed: { key: string; old: string; new: string }[];
    moved: { from: string; to: string; value: string }[];
  };
  counts: { added: number; removed: number; changed: number; moved: number };
};

/** Extensions the key comparison understands (kept in step with `formatOf` on the server). */
export const KEY_EXTENSIONS = /\.(toml|json|json5|jsonc|mcmeta|properties|cfg|conf)$/i;

export const keysApi = {
  keyDiff: (base: number | string, other: number | string, path: string) =>
    api<KeyDiffData>(`/configs/keydiff?base=${base}&other=${other}&path=${encodeURIComponent(path)}`),
};

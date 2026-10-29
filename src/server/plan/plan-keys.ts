import type { ModDiff } from '../mods/diff.js';

export const MAX_FILE_KEY_LENGTH = 512;

const DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * A plan 'file' key is a path relative to the instance root, written with forward slashes only:
 * no absolute or drive path, no backslash, no `.`/`..`/empty segment, no `:` (drive or alternate stream),
 * no Windows device name, no trailing dot or space, no control character.
 */
export function isSafePlanFileKey(key: string): boolean {
  if (!key || key.length > MAX_FILE_KEY_LENGTH) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\\:*?"<>|]/.test(key)) return false;
  if (key.startsWith('/')) return false;
  return key.split('/').every((s) => s !== '' && s !== '.' && s !== '..' && !DEVICE_NAME.test(s) && !/[. ]$/.test(s));
}

export type ModPlanAction = 'update' | 'restore';

/**
 * Mods of a comparison that can be put in the plan: taking the reference (base) jar makes sense when the compared
 * profile is older, different without order, rebuilt, or missing the mod. Newer and added mods are Yann's own choices.
 */
export function actionableMods(diff: ModDiff): Map<string, ModPlanAction> {
  const out = new Map<string, ModPlanAction>();
  for (const u of diff.updated) if (u.direction === 'older' || u.direction === 'different') out.set(u.modId, 'update');
  for (const e of diff.rebuilt) out.set(e.modId, 'update');
  for (const e of diff.removed) out.set(e.modId, 'restore');
  return out;
}

import type { Profile } from '../profiles/profile-service.js';
import { inventoryOrThrow, pairLoader } from './compare.js';
import { diffInventories, type InventoryFiles } from './diff.js';
import { extOf, rootOf, type FileKind } from './inventory.js';

/**
 * What the player changed, read from three copies of the same pack:
 *  - clean: the files the pack ships, never started;
 *  - launched: the clean pack started once, so the game and the mods have generated their own config files;
 *  - played: the instance that is really used.
 * A file that is identical (up to formatting) between launched and played was not touched. A file that differs was.
 */
export type CustomStatus = 'modifiedGenerated' | 'modifiedShipped' | 'added' | 'removed' | 'untouched';
export const CUSTOM_ORDER: CustomStatus[] = ['modifiedGenerated', 'modifiedShipped', 'added', 'removed', 'untouched'];
/** The statuses whose played version has to travel with the pack, because the pack alone would not reproduce it. */
export const INCLUDE_STATUSES = new Set<CustomStatus>(['modifiedGenerated', 'modifiedShipped', 'added']);

export type CustomFile = {
  path: string;
  root: string;
  ext: string;
  kind: FileKind;
  status: CustomStatus;
  include: boolean;
  inClean: boolean;
  launchedSize: number | null;
  playedSize: number | null;
};
export type CustomSummary = { perStatus: Record<CustomStatus, number>; include: number; perRoot: Record<string, Record<CustomStatus, number>> };
export type Customizations = { files: CustomFile[]; summary: CustomSummary; total: number };

const counts = (): Record<CustomStatus, number> => Object.fromEntries(CUSTOM_ORDER.map((s) => [s, 0])) as Record<CustomStatus, number>;
const same = (s: string) => s === 'identical' || s === 'cosmetic';
const sub = (files: InventoryFiles, keys: Iterable<string>): InventoryFiles => {
  const out: InventoryFiles = {};
  for (const k of keys) if (files[k]) out[k] = files[k]!;
  return out;
};

/**
 * Classifies every file of the played instance against the launched one.
 * A file that is not in the clean pack but exists in the launched one and differs when played is a generated file that the player
 * changed: regenerating it from defaults would lose the change, so it must be part of the pack. A file the played instance has
 * but the launched one does not is an addition, or a modified shipped file when the clean pack ships it (the first launch removed it). A played file that went back to the clean content is not a customization.
 */
export async function analyzeCustomizations(
  dataDir: string,
  profiles: { clean: Profile; launched: Profile; played: Profile },
  opts: { includeUntouched?: boolean } = {},
): Promise<Customizations> {
  const cInv = inventoryOrThrow(dataDir, profiles.clean);
  const lInv = inventoryOrThrow(dataDir, profiles.launched);
  const pInv = inventoryOrThrow(dataDir, profiles.played);

  const lp = pairLoader({ profile: profiles.launched, inv: lInv }, { profile: profiles.played, inv: pInv });
  const cp = pairLoader({ profile: profiles.clean, inv: cInv }, { profile: profiles.played, inv: pInv });
  try {
    const cleanKeys = new Map(Object.keys(cInv.files).map((p) => [p.toLowerCase(), p]));
    const d = await diffInventories(lInv.files, pInv.files, { load: (side, p) => lp.load(side, p), maxFiles: Number.MAX_SAFE_INTEGER });

    // Files that look touched, or that exist only when played but also ship with the clean pack: check them against the clean one.
    const againstClean: string[] = [];
    for (const f of d.files) {
      const inClean = cleanKeys.has(f.path.toLowerCase());
      if (inClean && (f.status === 'modified' || f.status === 'binaryDiffers' || f.status === 'tooLarge' || f.status === 'onlyInOther')) againstClean.push(cleanKeys.get(f.path.toLowerCase())!);
    }
    const reverted = new Set<string>();
    if (againstClean.length > 0) {
      const playedKey = new Map(Object.keys(pInv.files).map((p) => [p.toLowerCase(), p]));
      const cleanSub = sub(cInv.files, againstClean);
      const playedSub = sub(pInv.files, againstClean.map((p) => playedKey.get(p.toLowerCase()) ?? p));
      const back = await diffInventories(cleanSub, playedSub, { load: (side, p) => cp.load(side, p), maxFiles: Number.MAX_SAFE_INTEGER });
      for (const f of back.files) if (same(f.status)) reverted.add(f.path.toLowerCase());
    }

    const files: CustomFile[] = [];
    const perStatus = counts();
    const perRoot: Record<string, Record<CustomStatus, number>> = {};
    for (const f of d.files) {
      const inClean = cleanKeys.has(f.path.toLowerCase());
      let status: CustomStatus;
      if (same(f.status) || reverted.has(f.path.toLowerCase())) status = 'untouched';
      else if (f.status === 'onlyInBase') status = 'removed';
      else if (f.status === 'onlyInOther') status = inClean ? 'modifiedShipped' : 'added'; // a shipped file the first launch removed, edited when played
      else status = inClean ? 'modifiedShipped' : 'modifiedGenerated';
      const root = rootOf(f.path) ?? f.path.split('/')[0]!;
      perStatus[status]++;
      (perRoot[root] ??= counts())[status]++;
      if (status === 'untouched' && !opts.includeUntouched) continue;
      files.push({ path: f.path, root, ext: extOf(f.path), kind: f.kind, status, include: INCLUDE_STATUSES.has(status), inClean, launchedSize: f.baseSize, playedSize: f.otherSize });
    }
    files.sort((a, b) => CUSTOM_ORDER.indexOf(a.status) - CUSTOM_ORDER.indexOf(b.status) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const include = perStatus.modifiedGenerated + perStatus.modifiedShipped + perStatus.added;
    return { files, summary: { perStatus, include, perRoot }, total: d.total };
  } finally {
    await Promise.all([lp.close(), cp.close()]);
  }
}

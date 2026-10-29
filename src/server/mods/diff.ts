import { compareVersions } from '../../shared/versions.js';

export type ModEntry = { modId: string; version: string; sha256: string; file: string };
export type ModSet = Map<string, ModEntry>;

export type ModUpdate = { modId: string; from: ModEntry; to: ModEntry; direction: 'newer' | 'older' | 'different' };
export type ModDiff = { added: ModEntry[]; removed: ModEntry[]; updated: ModUpdate[]; rebuilt: ModEntry[]; unchanged: number };

export class AtmVersionMismatchError extends Error {
  constructor(server: string, client: string) {
    super(`the followed pack's server pack is ${server} but its client is ${client}: sides cannot be derived`);
    this.name = 'AtmVersionMismatchError';
  }
}

const byId = (a: ModEntry, b: ModEntry) => a.modId.localeCompare(b.modId);

/** Compares two mod sets by mod id: `base` is the older/reference side, `other` the newer one. Pinned ids are ignored. */
export function diffModSets(base: ModSet, other: ModSet, opts: { pins?: Set<string> } = {}): ModDiff {
  const pins = opts.pins ?? new Set<string>();
  const diff: ModDiff = { added: [], removed: [], updated: [], rebuilt: [], unchanged: 0 };

  for (const [id, to] of other) {
    const from = base.get(id);
    if (!from) {
      diff.added.push(to);
      continue;
    }
    const order = compareVersions(to.version, from.version);
    if (order === 'equal' || (from.version === to.version)) {
      if (from.sha256 === to.sha256) diff.unchanged++;
      else diff.rebuilt.push(to);
    } else if (order === 'older' && pins.has(id)) {
      diff.unchanged++; // a pin only silences an intentional downgrade
    } else {
      diff.updated.push({ modId: id, from, to, direction: order === 'newer' ? 'newer' : order === 'older' ? 'older' : 'different' });
    }
  }
  for (const [id, from] of base) {
    if (!other.has(id)) diff.removed.push(from);
  }

  diff.added.sort(byId);
  diff.removed.sort(byId);
  diff.rebuilt.sort(byId);
  diff.updated.sort((a, b) => a.modId.localeCompare(b.modId));
  return diff;
}

/** ATM's own choices: what its client has and its server pack lacks is client-only, and the reverse is server-only. */
export function deriveAtmSides(
  atmS: ModSet,
  atmC: ModSet,
  versions: { server: string; client: string },
): { clientOnly: string[]; serverOnly: string[]; both: string[] } {
  if (versions.server !== versions.client) throw new AtmVersionMismatchError(versions.server, versions.client);
  const clientOnly = [...atmC.keys()].filter((id) => !atmS.has(id)).sort();
  const serverOnly = [...atmS.keys()].filter((id) => !atmC.has(id)).sort();
  const both = [...atmS.keys()].filter((id) => atmC.has(id)).sort();
  return { clientOnly, serverOnly, both };
}

/** Yann's layer on top of ATM, client against client. */
export function yannLayer(lmpC: ModSet, atmC: ModSet): ModDiff {
  return diffModSets(atmC, lmpC);
}

/** Mods the followed pack's client has that the player's pack lacks (the player does not remove mods), minus the ones already resolved. */
export function anomalies(atmC: ModSet, lmpC: ModSet, resolved: Set<string> = new Set()): ModEntry[] {
  return [...atmC.values()].filter((e) => !lmpC.has(e.modId) && !resolved.has(e.modId)).sort(byId);
}

export type Blocker = { code: 'ANOMALY' | 'DUPLICATE_ID' | 'SKIPPED_JAR'; modId: string };

export function buildBlockers(input: { anomalies: ModEntry[]; duplicateIds: { modId: string; files: string[] }[]; skippedJars?: string[] }): Blocker[] {
  return [
    ...input.anomalies.map((a) => ({ code: 'ANOMALY' as const, modId: a.modId })),
    ...input.duplicateIds.map((d) => ({ code: 'DUPLICATE_ID' as const, modId: d.modId })),
    ...(input.skippedJars ?? []).map((file) => ({ code: 'SKIPPED_JAR' as const, modId: file })),
  ];
}

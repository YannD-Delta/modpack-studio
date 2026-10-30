import { defineLimit, getNumberLimit } from '../settings/limits.js';

/**
 * Client of the CurseForge REST API (https://docs.curseforge.com/rest-api/): base URL https://api.curseforge.com, key in the `x-api-key` header.
 * Confirmed in the official docs: the endpoints used below, the request and response field names, the ModLoaderType numbers and the paging
 * limit (50 per page). Confirmed from two community sources, not from the official docs: the fingerprint algorithm (see `fingerprint`).
 * Not confirmed: the Minecraft game id (432 is the widely used value), hence the setting.
 */
export const CURSEFORGE_API_URL = 'https://api.curseforge.com';
export const CURSEFORGE_GAME_ID = 432;
export const CURSEFORGE_CONCURRENCY = 4;

defineLimit({ key: 'curseforge.gameId', kind: 'number', default: CURSEFORGE_GAME_ID, min: 1, max: 1_000_000, unit: 'count', group: 'curseforge', label: 'CurseForge game id of Minecraft' });
defineLimit({ key: 'curseforge.concurrency', kind: 'number', default: CURSEFORGE_CONCURRENCY, min: 1, max: 16, unit: 'count', group: 'curseforge', label: 'Parallel CurseForge requests' });

/** ModLoaderType numbers of the official docs (0 Any, 1 Forge, 2 Cauldron, 3 LiteLoader, 4 Fabric, 5 Quilt, 6 NeoForge). */
export const LOADER_TYPE = { forge: 1, fabric: 4, neoforge: 6 } as const;

export type CurseForgeFile = {
  id: number;
  modId: number;
  displayName: string;
  fileName: string;
  fileDate: string;
  releaseType: number; // 1 release, 2 beta, 3 alpha
  isAvailable?: boolean;
  gameVersions?: string[];
  fileFingerprint?: number;
};

export type CurseForgeErrorCode = 'rejected' | 'rate_limited' | 'unreachable' | 'unexpected';
export class CurseForgeError extends Error {
  constructor(
    public readonly code: CurseForgeErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'CurseForgeError';
  }
}

const WHITESPACE = new Set([0x09, 0x0a, 0x0d, 0x20]);

/**
 * CurseForge file fingerprint: 32-bit MurmurHash2 with seed 1 over the file bytes with the four whitespace bytes
 * (tab, line feed, carriage return, space) left out; the length used by the hash excludes them too.
 */
export function fingerprint(buf: Uint8Array): number {
  const data: number[] = [];
  for (const b of buf) if (!WHITESPACE.has(b)) data.push(b);
  const m = 0x5bd1e995;
  let len = data.length;
  let h = (1 ^ len) >>> 0;
  let i = 0;
  while (len >= 4) {
    let k = (data[i]! | (data[i + 1]! << 8) | (data[i + 2]! << 16) | (data[i + 3]! << 24)) >>> 0;
    k = Math.imul(k, m) >>> 0;
    k = (k ^ (k >>> 24)) >>> 0;
    k = Math.imul(k, m) >>> 0;
    h = Math.imul(h, m) >>> 0;
    h = (h ^ k) >>> 0;
    i += 4;
    len -= 4;
  }
  if (len === 3) h = (h ^ (data[i + 2]! << 16)) >>> 0;
  if (len >= 2) h = (h ^ (data[i + 1]! << 8)) >>> 0;
  if (len >= 1) {
    h = (h ^ data[i]!) >>> 0;
    h = Math.imul(h, m) >>> 0;
  }
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, m) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return h;
}

export type FingerprintMatch = { fingerprint: number; modId: number; file: CurseForgeFile; latestFiles: CurseForgeFile[] };

export class CurseForgeClient {
  private readonly doFetch: typeof fetch;
  constructor(
    private readonly apiKey: string,
    opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
  ) {
    this.doFetch = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }
  private readonly timeoutMs: number;

  private async request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    let res: Response;
    try {
      res = await this.doFetch(`${CURSEFORGE_API_URL}${path}`, {
        method: init.method ?? 'GET',
        headers: { 'x-api-key': this.apiKey, accept: 'application/json', ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new CurseForgeError('unreachable', `CurseForge is unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.status === 401 || res.status === 403) throw new CurseForgeError('rejected', 'CurseForge refused the key', res.status);
    if (res.status === 429) throw new CurseForgeError('rate_limited', 'CurseForge rate limit reached, try again in a moment', res.status);
    if (!res.ok) throw new CurseForgeError('unexpected', `CurseForge answered ${res.status}`, res.status);
    return (await res.json()) as T;
  }

  /** Files of a project for one Minecraft version and loader (first page of 50, the API maximum). */
  async files(modId: number, filter: { gameVersion?: string | null; loaderType?: number | null } = {}): Promise<CurseForgeFile[]> {
    const q = new URLSearchParams({ pageSize: '50', index: '0' });
    if (filter.gameVersion) q.set('gameVersion', filter.gameVersion);
    if (filter.loaderType) q.set('modLoaderType', String(filter.loaderType));
    return (await this.request<{ data: CurseForgeFile[] }>(`/v1/mods/${modId}/files?${q}`)).data ?? [];
  }

  /** Which CurseForge files these fingerprints are: batches of 500, only the exact matches are returned. */
  async matchFingerprints(fingerprints: number[], gameId = getNumberLimit('curseforge.gameId')): Promise<{ matches: FingerprintMatch[]; unmatched: number[] }> {
    const matches: FingerprintMatch[] = [];
    const unmatched: number[] = [];
    for (let i = 0; i < fingerprints.length; i += 500) {
      const batch = fingerprints.slice(i, i + 500);
      const res = await this.request<{ data: { exactMatches?: { id: number; file: CurseForgeFile; latestFiles?: CurseForgeFile[] }[]; unmatchedFingerprints?: number[] } }>(
        `/v1/fingerprints/${gameId}`,
        { method: 'POST', body: { fingerprints: batch } },
      );
      for (const m of res.data.exactMatches ?? []) matches.push({ fingerprint: m.file.fileFingerprint ?? 0, modId: m.id, file: m.file, latestFiles: m.latestFiles ?? [] });
      unmatched.push(...(res.data.unmatchedFingerprints ?? []));
    }
    return { matches, unmatched };
  }
}

/** The newest available release among the files (beta and alpha only when asked), by file date. */
export function newestFile(files: CurseForgeFile[], opts: { allowPreRelease?: boolean } = {}): CurseForgeFile | null {
  const usable = files.filter((f) => f.isAvailable !== false && (opts.allowPreRelease || f.releaseType === 1));
  usable.sort((a, b) => Date.parse(b.fileDate) - Date.parse(a.fileDate) || b.id - a.id);
  return usable[0] ?? null;
}

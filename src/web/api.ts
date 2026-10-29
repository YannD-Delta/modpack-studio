export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method: init.method ?? 'GET',
    credentials: 'include',
    headers: init.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? res.statusText);
  return data as T;
}

export type Profile = { id: number; pack: string; version: string; side: string; state: string; locationKind: string; location: string; immutable: boolean };
export type MatrixRow = { pack: string; version: string; cells: Record<string, Profile | null> };
export type ModEntry = { modId: string; version: string; sha256: string; file: string };
export type ModDiff = {
  added: ModEntry[];
  removed: ModEntry[];
  updated: { modId: string; from: ModEntry; to: ModEntry; direction: 'newer' | 'older' | 'different' }[];
  rebuilt: ModEntry[];
  unchanged: number;
};
export type BlacklistEntry = { modId: string; origin: 'atm_derived' | 'yann'; stale: boolean };

export const CELL_KEYS = ['client-clean', 'client-launched', 'client-run', 'server-clean', 'server-launched', 'server-run'] as const;

export const profileLabel = (p: Profile) => `${p.pack} ${p.version} · ${p.side} · ${p.state}`;

export function flattenProfiles(matrix: MatrixRow[]): Profile[] {
  return matrix.flatMap((r) => Object.values(r.cells).filter((c): c is Profile => c !== null));
}

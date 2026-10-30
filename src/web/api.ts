export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** Stable machine-readable slug sent by the server next to `error`, when there is one. */
    public readonly code?: string,
    /** The whole JSON body of the failed answer (extra fields such as `artifacts` or `notScanned`). */
    public readonly body?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Window event fired when an answer says the session is gone (401); App listens and falls back to the login form. */
export const UNAUTHORIZED_EVENT = 'studio:unauthorized';

/** Queries retry transient failures a few times but never a client error (401, 404, 400...): the same call would fail again. */
export const QUERY_RETRY_LIMIT = 2;
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return failureCount < QUERY_RETRY_LIMIT;
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method: init.method ?? 'GET',
    credentials: 'include',
    headers: init.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // /auth/* answers 401 for a wrong password or no session yet: only a call made while logged in means the session was lost.
    if (res.status === 401 && !path.startsWith('/auth/') && typeof window !== 'undefined') window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    const body = data as Record<string, unknown>;
    const error = typeof body.error === 'string' ? body.error : res.statusText;
    throw new ApiError(res.status, error, typeof body.code === 'string' ? body.code : undefined, body);
  }
  return data as T;
}

export type Profile = { id: number; pack: string; version: string; side: string; state: string; locationKind: string; location: string; immutable: boolean;
  /** When the profile's mods were last imported (null = never imported); absent on servers that do not send it. */
  importedAt?: string | null;
  /** Jars skipped by the last import because they could not be read. */
  importIssueCount?: number;
};
export type MatrixRow = { pack: string; version: string; cells: Record<string, Profile | null> };
export type ModEntry = { modId: string; version: string; sha256: string; file: string };
export type ModDiff = {
  added: ModEntry[];
  removed: ModEntry[];
  updated: { modId: string; from: ModEntry; to: ModEntry; direction: 'newer' | 'older' | 'different' }[];
  rebuilt: ModEntry[];
  unchanged: number;
};
export type BlacklistEntry = { modId: string; origin: 'upstream_derived' | 'user'; stale: boolean };

export const CELL_KEYS = ['client-clean', 'client-launched', 'client-run', 'server-clean', 'server-launched', 'server-run'] as const;

export const profileLabel = (p: Profile) => `${p.pack} ${p.version} · ${p.side} · ${p.state}`;

export function flattenProfiles(matrix: MatrixRow[]): Profile[] {
  return matrix.flatMap((r) => Object.values(r.cells).filter((c): c is Profile => c !== null));
}

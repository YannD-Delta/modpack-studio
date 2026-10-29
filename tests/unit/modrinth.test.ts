import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModrinthClient, environmentToSide } from '../../src/server/mods/modrinth.js';

afterEach(() => vi.useRealTimers());

const hashes = (n: number) => Array.from({ length: n }, (_, i) => i.toString(16).padStart(40, '0'));
const okFetch = (env = 'client_only') =>
  vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body)) as { hashes: string[] };
    return new Response(JSON.stringify(Object.fromEntries(body.hashes.map((h) => [h, { environment: env }]))), { status: 200 });
  });

describe('environmentToSide', () => {
  it.each([['client_only', 'client'], ['server_only', 'server'], ['client_and_server', 'both'], ['client_or_server', 'both'], ['weird', null]] as const)('%s -> %s', (env, side) => {
    expect(environmentToSide(env)).toBe(side);
  });
});

describe('ModrinthClient', () => {
  it('sends hashes in bulk chunks of at most 100 with a User-Agent and the sha1 algorithm', async () => {
    const f = okFetch();
    const client = new ModrinthClient({ fetch: f as unknown as typeof fetch, userAgent: 'modpack-studio/0.1 (test)' });
    const result = await client.lookupByHashes(hashes(250));
    expect(f).toHaveBeenCalledTimes(3);
    const sizes = f.mock.calls.map((c) => (JSON.parse(String(c[1]!.body)) as { hashes: string[] }).hashes.length);
    expect(sizes).toEqual([100, 100, 50]);
    const init = f.mock.calls[0]![1]!;
    expect((init.headers as Record<string, string>)['User-Agent']).toBe('modpack-studio/0.1 (test)');
    expect(JSON.parse(String(init.body)).algorithm).toBe('sha1');
    expect(result.size).toBe(250);
    expect(result.get(hashes(1)[0]!)).toEqual({ environment: 'client_only' });
  });

  it('waits when maxPerMinute is exceeded', async () => {
    vi.useFakeTimers();
    const f = okFetch();
    const client = new ModrinthClient({ fetch: f as unknown as typeof fetch, userAgent: 'x', maxPerMinute: 2 });
    const pending = client.lookupByHashes(hashes(300));
    await vi.advanceTimersByTimeAsync(0);
    expect(f).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_100);
    await pending;
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('skips hashes Modrinth does not know and survives a non-200 chunk', async () => {
    const f = vi.fn(async () => new Response('nope', { status: 500 }));
    const client = new ModrinthClient({ fetch: f as unknown as typeof fetch, userAgent: 'x' });
    expect((await client.lookupByHashes(hashes(3))).size).toBe(0);
  });
});

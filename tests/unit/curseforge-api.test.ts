import { describe, expect, it } from 'vitest';
import { CurseForgeClient, CurseForgeError, fingerprint, newestFile, type CurseForgeFile } from '../../src/server/mods/curseforge-api.js';

/** Independent BigInt version of MurmurHash2 (seed 1) over bytes already stripped of whitespace, to cross-check the 32-bit one. */
function reference(bytes: number[]): number {
  const M = 0x5bd1e995n;
  const mask = 0xffffffffn;
  let h = (1n ^ BigInt(bytes.length)) & mask;
  let i = 0;
  for (; i + 4 <= bytes.length; i += 4) {
    let k = BigInt(bytes[i]!) | (BigInt(bytes[i + 1]!) << 8n) | (BigInt(bytes[i + 2]!) << 16n) | (BigInt(bytes[i + 3]!) << 24n);
    k = (k * M) & mask;
    k ^= k >> 24n;
    k = (k * M) & mask;
    h = ((h * M) & mask) ^ k;
  }
  const rest = bytes.length - i;
  if (rest === 3) h ^= BigInt(bytes[i + 2]!) << 16n;
  if (rest >= 2) h ^= BigInt(bytes[i + 1]!) << 8n;
  if (rest >= 1) {
    h ^= BigInt(bytes[i]!);
    h = (h * M) & mask;
  }
  h ^= h >> 13n;
  h = (h * M) & mask;
  h ^= h >> 15n;
  return Number(h & mask);
}

describe('fingerprint', () => {
  it('matches an independent implementation for every length and byte pattern', () => {
    for (let len = 0; len < 40; len++) {
      const bytes = Array.from({ length: len }, (_, i) => (i * 37 + len * 11) % 251).filter((b) => ![9, 10, 13, 32].includes(b));
      expect(fingerprint(Uint8Array.from(bytes))).toBe(reference(bytes));
    }
  });

  it('ignores tab, line feed, carriage return and space, and nothing else', () => {
    const plain = Buffer.from('level=1;mods=[a,b]');
    const spaced = Buffer.from('level=1;\r\n\tmods = [a, b]\n');
    expect(fingerprint(spaced)).toBe(fingerprint(plain));
    expect(fingerprint(Buffer.from('level=2;mods=[a,b]'))).not.toBe(fingerprint(plain));
  });

  it('is an unsigned 32-bit number', () => {
    for (const s of ['', 'a', 'abcd', 'a long enough text to go through the main loop several times']) {
      const f = fingerprint(Buffer.from(s));
      expect(Number.isInteger(f) && f >= 0 && f <= 0xffffffff).toBe(true);
    }
  });
});

const file = (id: number, date: string, releaseType = 1, extra: Partial<CurseForgeFile> = {}): CurseForgeFile => ({ id, modId: 7, displayName: `f${id}`, fileName: `f${id}.jar`, fileDate: date, releaseType, ...extra });

describe('newestFile', () => {
  it('picks the newest release by date and skips betas, alphas and unavailable files unless asked', () => {
    const files = [file(1, '2026-01-01T00:00:00Z'), file(3, '2026-03-01T00:00:00Z', 2), file(2, '2026-02-01T00:00:00Z'), file(4, '2026-04-01T00:00:00Z', 1, { isAvailable: false })];
    expect(newestFile(files)?.id).toBe(2);
    expect(newestFile(files, { allowPreRelease: true })?.id).toBe(3);
    expect(newestFile([])).toBeNull();
  });
});

describe('CurseForgeClient', () => {
  const stub = (status: number, body: unknown, seen: { url: string; init?: RequestInit }[] = []) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init });
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

  it('asks for the files of a project with the game version and loader, sending the key in x-api-key', async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const client = new CurseForgeClient('KEY', { fetchImpl: stub(200, { data: [file(1, '2026-01-01T00:00:00Z')] }, seen) });
    const files = await client.files(7, { gameVersion: '1.21.1', loaderType: 6 });
    expect(files).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://api.curseforge.com/v1/mods/7/files?pageSize=50&index=0&gameVersion=1.21.1&modLoaderType=6');
    expect((seen[0]!.init!.headers as Record<string, string>)['x-api-key']).toBe('KEY');
  });

  it('sends fingerprints in batches of 500 and gathers the exact matches', async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init });
      const sent = JSON.parse(String(init!.body)).fingerprints as number[];
      return new Response(JSON.stringify({ data: { exactMatches: [{ id: 9, file: file(5, '2026-01-01T00:00:00Z', 1, { fileFingerprint: sent[0] }), latestFiles: [] }], unmatchedFingerprints: [sent[1]] } }), { status: 200 });
    }) as typeof fetch;
    const res = await new CurseForgeClient('KEY', { fetchImpl }).matchFingerprints(Array.from({ length: 1001 }, (_, i) => i + 1), 432);
    expect(seen.map((s) => JSON.parse(String(s.init!.body)).fingerprints.length)).toEqual([500, 500, 1]);
    expect(seen[0]!.url).toBe('https://api.curseforge.com/v1/fingerprints/432');
    expect(res.matches.map((m) => m.fingerprint)).toEqual([1, 501, 1001]);
    expect(res.unmatched).toEqual([2, 502, null]); // the last batch has one fingerprint, so the stub's second entry is absent
  });

  it('turns HTTP and network failures into typed errors without echoing the key', async () => {
    const code = async (fetchImpl: typeof fetch) => (await new CurseForgeClient('SECRET-KEY', { fetchImpl }).files(1).catch((e: unknown) => e)) as CurseForgeError;
    expect(await code(stub(403, {}))).toMatchObject({ code: 'rejected' });
    expect(await code(stub(429, {}))).toMatchObject({ code: 'rate_limited' });
    expect(await code(stub(500, {}))).toMatchObject({ code: 'unexpected', status: 500 });
    const down = await code((async () => { throw new Error('connect ECONNREFUSED'); }) as typeof fetch);
    expect(down).toMatchObject({ code: 'unreachable' });
    expect(down.message).not.toContain('SECRET-KEY');
  });
});

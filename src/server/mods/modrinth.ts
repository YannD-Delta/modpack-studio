import type { Side } from './side-classifier.js';

const BASE_URL = 'https://api.modrinth.com';
const CHUNK = 100;

export function environmentToSide(env: string): Side | null {
  switch (env) {
    case 'client_only':
      return 'client';
    case 'server_only':
      return 'server';
    case 'client_and_server':
    case 'client_or_server':
      return 'both';
    default:
      return null;
  }
}

export type ModrinthOptions = { fetch: typeof fetch; userAgent: string; maxPerMinute?: number; baseUrl?: string };

/** Bulk lookup of file hashes on Modrinth (no API key; a unique User-Agent is required; 300 requests/min per IP). */
export class ModrinthClient {
  private stamps: number[] = [];

  constructor(private readonly opts: ModrinthOptions) {}

  private async waitForSlot(): Promise<void> {
    const max = this.opts.maxPerMinute ?? 300;
    for (;;) {
      const now = Date.now();
      this.stamps = this.stamps.filter((t) => now - t < 60_000);
      if (this.stamps.length < max) {
        this.stamps.push(now);
        return;
      }
      await new Promise((r) => setTimeout(r, 60_000 - (now - this.stamps[0]!) + 1));
    }
  }

  /** Maps each known sha1 to its Modrinth `environment`; unknown hashes and failed chunks are simply absent. */
  async lookupByHashes(sha1s: string[]): Promise<Map<string, { environment: string }>> {
    const out = new Map<string, { environment: string }>();
    for (let i = 0; i < sha1s.length; i += CHUNK) {
      await this.waitForSlot();
      const res = await this.opts.fetch(`${this.opts.baseUrl ?? BASE_URL}/v2/version_files`, {
        method: 'POST',
        headers: { 'User-Agent': this.opts.userAgent, 'Content-Type': 'application/json' },
        body: JSON.stringify({ hashes: sha1s.slice(i, i + CHUNK), algorithm: 'sha1' }),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as Record<string, { environment?: string }>;
      for (const [hash, version] of Object.entries(body)) {
        if (version.environment) out.set(hash, { environment: version.environment });
      }
    }
    return out;
  }
}

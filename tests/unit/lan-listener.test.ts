import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { listenLan } from '../../src/server/lan.js';

const servers: http.Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

const handler: http.RequestListener = (_req, res) => res.end('ok');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('listenLan', () => {
  it('does not crash when the address is not assigned, logs the failure and announces nothing', async () => {
    const info: string[] = [];
    const warn: string[] = [];
    // TEST-NET-3 (RFC 5737): never assigned to a local interface
    const s = listenLan(handler, { ip: '203.0.113.77', port: 0, retryMs: 60_000, log: { info: (m) => info.push(m), warn: (m) => warn.push(m) } });
    servers.push(s);
    await wait(300);
    expect(s.listening).toBe(false);
    expect(info).toEqual([]);
    expect(warn.join(' ')).toMatch(/failed \(EADDRNOTAVAIL\)/);
  });

  it('announces the address only once it is bound, and serves requests', async () => {
    const info: string[] = [];
    const s = listenLan(handler, { ip: '127.0.0.1', port: 0, log: { info: (m) => info.push(m), warn: () => undefined } });
    servers.push(s);
    await new Promise<void>((r) => s.once('listening', () => r()));
    expect(info.join(' ')).toContain('also listening on 127.0.0.1:');
    const port = (s.address() as AddressInfo).port;
    const body = await new Promise<string>((resolve, reject) => http.get({ host: '127.0.0.1', port }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(d)); }).on('error', reject));
    expect(body).toBe('ok');
  });
});

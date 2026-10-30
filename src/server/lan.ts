import http from 'node:http';

/** Delay before the LAN listener retries after a failed bind (the address may not be assigned yet at logon: Wi-Fi, DHCP, VPN). */
export const LAN_RETRY_MS = 30_000;

export type LanLog = { info(msg: string): void; warn(msg: string): void };

/**
 * Serves `handler` on a second address (the LAN IP) next to the loopback listener.
 * A failed bind never crashes the app: it is logged and retried, and the "listening" line only comes from the real bind.
 */
export function listenLan(handler: http.RequestListener, opts: { ip: string; port: number; retryMs?: number; log?: LanLog }): http.Server {
  const log = opts.log ?? { info: (m) => console.log(m), warn: (m) => console.warn(m) };
  const server = http.createServer(handler);
  let retry: NodeJS.Timeout | undefined;
  server.on('error', (err: NodeJS.ErrnoException) => {
    log.warn(`LAN listener ${opts.ip}:${opts.port} failed (${err.code ?? err.message}); loopback keeps serving, retrying in ${Math.round((opts.retryMs ?? LAN_RETRY_MS) / 1000)} s`);
    clearTimeout(retry);
    retry = setTimeout(() => server.listen(opts.port, opts.ip), opts.retryMs ?? LAN_RETRY_MS);
    retry.unref();
  });
  server.on('listening', () => log.info(`Modpack Studio also listening on ${opts.ip}:${opts.port}`));
  server.on('close', () => clearTimeout(retry));
  server.listen(opts.port, opts.ip);
  return server;
}

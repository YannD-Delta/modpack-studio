import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { JobRunner } from '../jobs/runner.js';
import { defineLimit, getNumberLimit } from '../settings/limits.js';

/** How often an open stream re-checks that its session is still valid (also the heartbeat). */
export const SSE_RECHECK_MS = 15000;
defineLimit({ key: 'sse.recheckSeconds', kind: 'number', default: SSE_RECHECK_MS / 1000, min: 1, max: 600, unit: 'seconds', group: 'security', label: 'Live stream session re-check' });

/**
 * One SSE stream carrying every job event; reconnecting browsers resume on the live stream.
 * `stillValid` is asked before every write and at every heartbeat: after logout or session expiry the stream is closed.
 */
export function registerEvents(app: FastifyInstance, jobs: JobRunner, stillValid: (req: FastifyRequest) => boolean = () => true): void {
  app.get('/api/v1/events', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': connected\n\n');
    let seq = 0;
    let off = (): void => undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    const stop = () => {
      clearInterval(heartbeat);
      off();
    };
    const alive = (): boolean => {
      if (stillValid(req)) return true;
      stop();
      res.end();
      return false;
    };
    off = jobs.on((e) => {
      if (alive()) res.write(`id: ${++seq}\nevent: job\ndata: ${JSON.stringify(e)}\n\n`);
    });
    heartbeat = setInterval(() => {
      if (alive()) res.write(': ping\n\n');
    }, getNumberLimit('sse.recheckSeconds') * 1000);
    req.raw.on('close', stop);
  });
}

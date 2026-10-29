import type { FastifyInstance } from 'fastify';
import type { JobRunner } from '../jobs/runner.js';

/** One SSE stream carrying every job event; reconnecting browsers resume on the live stream. */
export function registerEvents(app: FastifyInstance, jobs: JobRunner): void {
  app.get('/api/v1/events', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': connected\n\n');
    let seq = 0;
    const off = jobs.on((e) => {
      res.write(`id: ${++seq}\nevent: job\ndata: ${JSON.stringify(e)}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      off();
    });
  });
}

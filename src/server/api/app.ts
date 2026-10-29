import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { API_PREFIX, APP_NAME } from '../../shared/constants.js';
import type { Config } from '../config.js';
import type { Db } from '../db/open.js';
import type { JobRunner } from '../jobs/runner.js';
import { SessionStore, verifyPassword } from './auth.js';
import { registerEvents } from './events.js';
import { registerModRoutes } from './routes-mods.js';
import { registerProfileRoutes } from './routes-profiles.js';

export type AppDeps = { db: Db; jobs: JobRunner; config: Config };

const PUBLIC_ROUTES = new Set([`${API_PREFIX}/health`, `${API_PREFIX}/auth/login`]);
const COOKIE = 'studio_session';

function hostName(hostHeader: string | undefined): string {
  if (!hostHeader) return '';
  const h = hostHeader.trim().toLowerCase();
  return h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0]!;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const { config } = deps;
  const app = fastify({ logger: false });
  const sessions = new SessionStore();
  const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]', ...(config.lanIp ? [config.lanIp.toLowerCase()] : []), ...config.allowedHosts.map((h) => h.toLowerCase())]);

  void app.register(cookie);
  void app.register(rateLimit, { global: false });

  // DNS-rebinding and cross-site guard: known Host only, and Origin (when sent) must match Host.
  app.addHook('onRequest', async (req, reply) => {
    if (!allowedHosts.has(hostName(req.headers.host))) return reply.code(403).send({ error: 'forbidden host' });
    const origin = req.headers.origin;
    if (origin) {
      let originHost = '';
      try {
        originHost = new URL(origin).host.toLowerCase();
      } catch {
        return reply.code(403).send({ error: 'bad origin' });
      }
      if (originHost !== (req.headers.host ?? '').toLowerCase()) return reply.code(403).send({ error: 'origin mismatch' });
    }
  });

  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0]!;
    if (PUBLIC_ROUTES.has(url)) return;
    if (!sessions.isValid(req.cookies[COOKIE])) return reply.code(401).send({ error: 'unauthorized' });
  });

  // Routes live in a child plugin so they are registered after the rate-limit plugin has loaded.
  void app.register(async (api) => {
    api.get(`${API_PREFIX}/health`, async () => ({ ok: true, name: APP_NAME }));

    api.post(
      `${API_PREFIX}/auth/login`,
      { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
      async (req, reply) => {
        const body = z.object({ password: z.string() }).safeParse(req.body);
        if (!body.success || !config.passwordHash || !verifyPassword(body.data.password, config.passwordHash)) {
          return reply.code(401).send({ error: 'invalid credentials' });
        }
        reply.setCookie(COOKIE, sessions.create(), { httpOnly: true, sameSite: 'strict', path: '/' });
        return { ok: true };
      },
    );

    api.post(`${API_PREFIX}/auth/logout`, async (req, reply) => {
      sessions.destroy(req.cookies[COOKIE]);
      reply.clearCookie(COOKIE, { path: '/' });
      return { ok: true };
    });

    api.get(`${API_PREFIX}/auth/me`, async () => ({ ok: true }));

    registerEvents(api, deps.jobs);
    registerProfileRoutes(api, deps);
    registerModRoutes(api, deps);
  });
  return app;
}

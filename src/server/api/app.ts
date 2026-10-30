import path from 'node:path';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { API_PREFIX, APP_NAME } from '../../shared/constants.js';
import type { Config } from '../config.js';
import type { Db } from '../db/open.js';
import { rewritePasswordHash, SettingsFileError } from '../settings/secrets-store.js';
import type { JobRunner } from '../jobs/runner.js';
import { hashPassword, needsRehash, SessionStore, verifyPassword } from './auth.js';
import { registerEvents } from './events.js';
import { registerAssistantRoutes } from './routes-assistant.js';
import { registerConfigsRoutes } from './routes-configs.js';
import { registerDecisionsRoutes } from './routes-decisions.js';
import { registerModRoutes } from './routes-mods.js';
import { registerPlanRoutes } from './routes-plan.js';
import { configureLimits } from '../settings/limits.js';
import { registerCurseForgeRoutes } from './routes-curseforge.js';
import { registerProjectRoutes } from './routes-projects.js';
import { registerSettingsRoutes } from './routes-settings.js';
import { registerTestbenchRoutes } from './routes-testbench.js';
import { registerProfileRoutes } from './routes-profiles.js';

/** `dataDir` is where exports and other files written by Studio go; it defaults to $STUDIO_DATA, else ./data, when a caller (tests) omits it. */
export type AppDeps = {
  db: Db;
  jobs: JobRunner;
  config: Config;
  dataDir?: string;
  fetchImpl?: typeof fetch;
  testBenchStartCommand?: { command: string; args: string[] };
  /** Test seam: shortens the pause after Done and the stop grace period of server tests (read when a test starts). */
  testBenchTimings?: { settleMs?: number; stopGraceMs?: number };
};

const PUBLIC_ROUTES = new Set([`${API_PREFIX}/health`, `${API_PREFIX}/auth/login`]);

function hostName(hostHeader: string | undefined): string {
  if (!hostHeader) return '';
  const h = hostHeader.trim().toLowerCase();
  return h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0]!;
}

export function buildApp(given: AppDeps): FastifyInstance {
  const deps: AppDeps = { ...given, dataDir: given.dataDir ?? path.resolve(process.env.STUDIO_DATA ?? 'data') };
  configureLimits(deps.dataDir!);
  const { config } = deps;
  // Browsers share cookies across ports of one host: the port keeps two instances (real and demo) apart.
  const COOKIE = `studio_session_${config.port}`;
  const app = fastify({ logger: false });
  const sessions = new SessionStore();
  const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]', ...(config.lanIp ? [config.lanIp.toLowerCase()] : []), ...config.allowedHosts.map((h) => h.toLowerCase())]);

  // A damaged settings file is a readable 500 with a stable code; every other error keeps Fastify's own handling.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof SettingsFileError) return reply.code(500).send({ error: err.message, code: err.code });
    return reply.send(err);
  });

  void app.register(cookie);
  void app.register(rateLimit, { global: false });

  // DNS-rebinding and cross-site guard: known Host only, and Origin (when sent) must match Host.
  app.addHook('onRequest', async (req, reply) => {
    if (!allowedHosts.has(hostName(req.headers.host))) return reply.code(403).send({ error: 'forbidden host', code: 'forbidden_host' });
    const origin = req.headers.origin;
    if (origin) {
      let originHost = '';
      try {
        originHost = new URL(origin).host.toLowerCase();
      } catch {
        return reply.code(403).send({ error: 'bad origin', code: 'bad_origin' });
      }
      if (originHost !== (req.headers.host ?? '').toLowerCase()) return reply.code(403).send({ error: 'origin mismatch', code: 'origin_mismatch' });
    }
  });

  app.addHook('onRequest', async (req, reply) => {
    // Fastify decodes the path before routing, so decide on the matched route (or the decoded path for a 404), never on the raw URL.
    const raw = req.url.split('?')[0]!;
    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      // an undecodable path matches no route and falls through to the raw check below
    }
    const route = req.routeOptions?.url ?? decoded;
    const isApi = route.startsWith(`${API_PREFIX}/`) || decoded.startsWith(`${API_PREFIX}/`) || raw.startsWith(`${API_PREFIX}/`);
    if (!isApi) return; // the SPA shell (login page, assets) must load before a session exists
    if (PUBLIC_ROUTES.has(route)) return;
    if (!sessions.isValid(req.cookies[COOKIE])) return reply.code(401).send({ error: 'unauthorized', code: 'unauthorized' });
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
          return reply.code(401).send({ error: 'invalid credentials', code: 'invalid_credentials' });
        }
        // Old cost parameters: upgrade the stored hash now that the password is known (best effort, never blocks the login).
        if (needsRehash(config.passwordHash)) {
          const upgraded = hashPassword(body.data.password);
          if (rewritePasswordHash(deps.dataDir!, config.passwordHash, upgraded)) config.passwordHash = upgraded;
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

    registerEvents(api, deps.jobs, (req) => sessions.isValid(req.cookies[COOKIE]));
    registerProfileRoutes(api, deps);
    registerModRoutes(api, deps);
    registerPlanRoutes(api, deps);
    registerConfigsRoutes(api, deps);
    registerDecisionsRoutes(api, deps);
    registerSettingsRoutes(api, deps);
    registerCurseForgeRoutes(api, deps);
    registerProjectRoutes(api, deps);
    registerAssistantRoutes(api, deps);
    registerTestbenchRoutes(api, deps);
  });
  return app;
}

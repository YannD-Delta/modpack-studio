import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { API_PREFIX } from '../../shared/constants.js';
import { NotScannedError } from '../configs/compare.js';
import { audit } from '../db/audit.js';
import { getProfile, type Profile } from '../profiles/profile-service.js';
import { buildProjectExport } from '../projects/export.js';
import { createProject, deleteChange, getProject, listChanges, listProjects, preview, proposal, ProjectError, saveChanges, setChoices, withoutChoice, type TriadProfiles } from '../projects/service.js';
import type { AppDeps } from './app.js';
import { sendBadRequest } from './routes-profiles.js';

const id = z.coerce.number().int().positive();
const TriadQuery = z.object({ clean: id, launched: id, candidate: id });
const CreateBody = z.object({ name: z.string().min(1).max(60), baseVersion: z.string().max(40).optional() });
const SaveBody = z.object({ clean: id, launched: id, candidate: id, files: z.array(z.string().min(1).max(1024)).max(5000).default([]), mods: z.array(z.string().min(1).max(200)).max(5000).default([]) });
const ChoicesBody = z.object({ newClean: id, picks: z.record(z.string().min(3).max(1100), z.record(z.string().min(1).max(1000), z.enum(['mine', 'base']))).default({}), choices: z.record(z.string().min(3).max(1100), z.enum(['mine', 'base', 'skip'] as [string, ...string[]])).refine((c) => Object.keys(c).length <= 5000) });
const ExportBody = z.object({ newClean: id, target: id.optional(), candidate: id.optional() });
const PreviewQuery = z.object({ newClean: id, oldClean: id.optional() });

function profileOr404(deps: AppDeps, profileId: number): Profile {
  try {
    return getProfile(deps.db, profileId);
  } catch (err) {
    if (err instanceof Error && /not found$/.test(err.message)) throw new ProjectError(404, `profile ${profileId} not found`, 'profile_not_found');
    throw err;
  }
}

/** The three copies behind a validation: your pack's clean and launched copies and the candidate (your custom test copy, or the instance in use). */
function triad(deps: AppDeps, q: { clean: number; launched: number; candidate: number }): TriadProfiles {
  if (new Set([q.clean, q.launched, q.candidate]).size !== 3) throw new ProjectError(400, 'pick three different profiles', 'triad_distinct');
  const p = { clean: profileOr404(deps, q.clean), launched: profileOr404(deps, q.launched), candidate: profileOr404(deps, q.candidate) };
  if (p.clean.state !== 'clean') throw new ProjectError(400, `the clean copy must be in state clean, not ${p.clean.state}`, 'triad_state', { role: 'clean' });
  if (p.launched.state !== 'launched') throw new ProjectError(400, `the launched copy must be in state launched, not ${p.launched.state}`, 'triad_state', { role: 'launched' });
  if (p.candidate.state !== 'candidate' && p.candidate.state !== 'run') throw new ProjectError(400, `the candidate must be in state candidate or run, not ${p.candidate.state}`, 'triad_state', { role: 'candidate' });
  if (p.clean.pack !== p.launched.pack || p.clean.version !== p.launched.version || new Set([p.clean.side, p.launched.side, p.candidate.side]).size !== 1) {
    throw new ProjectError(400, 'the clean and launched copies must be the same pack and version, and all three the same side', 'triad_mismatch');
  }
  return p;
}

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof ProjectError) return reply.code(err.status).send({ error: err.message, code: err.code, ...err.extra });
  if (err instanceof NotScannedError) return reply.code(409).send({ error: err.message, code: 'not_scanned', profileId: err.profileId });
  throw err;
}

/** Projects: a release line (for example "My pack 2026") that keeps the retouches you validated and shows what replaying them on a new base version would do. */
export function registerProjectRoutes(api: FastifyInstance, deps: AppDeps): void {
  const { db } = deps;
  const dataDir = deps.dataDir ?? path.resolve('data');

  api.get(`${API_PREFIX}/projects`, async () => ({ projects: listProjects(db) }));

  api.post(`${API_PREFIX}/projects`, async (req, reply) => {
    const body = CreateBody.safeParse(req.body);
    if (!body.success) return sendBadRequest(reply, body.error);
    try {
      const project = createProject(db, body.data.name, body.data.baseVersion ?? null);
      audit(db, 'project.create', String(project.id), { name: project.name });
      return reply.code(201).send(project);
    } catch (err) {
      return fail(reply, err);
    }
  });

  api.get(`${API_PREFIX}/projects/:id`, async (req, reply) => {
    const p = z.object({ id }).safeParse(req.params);
    if (!p.success) return sendBadRequest(reply, p.error);
    try {
      return { project: getProject(db, p.data.id), changes: listChanges(db, p.data.id) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  api.get(`${API_PREFIX}/projects/:id/proposal`, async (req, reply) => {
    const p = z.object({ id }).safeParse(req.params);
    const q = TriadQuery.safeParse(req.query);
    if (!p.success) return sendBadRequest(reply, p.error);
    if (!q.success) return sendBadRequest(reply, q.error);
    try {
      return await proposal(db, dataDir, p.data.id, triad(deps, q.data));
    } catch (err) {
      return fail(reply, err);
    }
  });

  api.post(`${API_PREFIX}/projects/:id/changes`, async (req, reply) => {
    const p = z.object({ id }).safeParse(req.params);
    const body = SaveBody.safeParse(req.body);
    if (!p.success) return sendBadRequest(reply, p.error);
    if (!body.success) return sendBadRequest(reply, body.error);
    try {
      const saved = await saveChanges(db, dataDir, p.data.id, triad(deps, body.data), { files: body.data.files, mods: body.data.mods });
      audit(db, 'project.validate', String(p.data.id), saved);
      return { ok: true, ...saved, changes: listChanges(db, p.data.id) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  api.delete(`${API_PREFIX}/projects/:id/changes/:changeId`, async (req, reply) => {
    const p = z.object({ id, changeId: id }).safeParse(req.params);
    if (!p.success) return sendBadRequest(reply, p.error);
    try {
      deleteChange(db, dataDir, p.data.id, p.data.changeId);
      audit(db, 'project.change_removed', String(p.data.id), { changeId: p.data.changeId });
      return reply.code(204).send();
    } catch (err) {
      return fail(reply, err);
    }
  });

  api.get(`${API_PREFIX}/projects/:id/preview`, async (req, reply) => {
    const p = z.object({ id }).safeParse(req.params);
    const q = PreviewQuery.safeParse(req.query);
    if (!p.success) return sendBadRequest(reply, p.error);
    if (!q.success) return sendBadRequest(reply, q.error);
    try {
      const newClean = profileOr404(deps, q.data.newClean);
      if (newClean.state !== 'clean') throw new ProjectError(400, `the new base must be a clean profile, not ${newClean.state}`, 'triad_state', { role: 'newClean' });
      const oldClean = q.data.oldClean ? profileOr404(deps, q.data.oldClean) : null;
      return await preview(db, dataDir, p.data.id, newClean, oldClean);
    } catch (err) {
      return fail(reply, err);
    }
  });

  api.put(`${API_PREFIX}/projects/:id/choices`, async (req, reply) => {
    const p = z.object({ id }).safeParse(req.params);
    const body = ChoicesBody.safeParse(req.body);
    if (!p.success) return sendBadRequest(reply, p.error);
    if (!body.success) return sendBadRequest(reply, body.error);
    try {
      const newClean = newCleanOr400(body.data.newClean);
      const saved = setChoices(db, p.data.id, newClean.id, body.data.choices as Record<string, 'mine' | 'base' | 'skip'>, body.data.picks);
      audit(db, 'project.choices', String(p.data.id), { newClean: newClean.id, saved });
      return await preview(db, dataDir, p.data.id, newClean, null);
    } catch (err) {
      return fail(reply, err);
    }
  });

  api.post(`${API_PREFIX}/projects/:id/export`, async (req, reply) => {
    const p = z.object({ id }).safeParse(req.params);
    const body = ExportBody.safeParse(req.body);
    if (!p.success) return sendBadRequest(reply, p.error);
    if (!body.success) return sendBadRequest(reply, body.error);
    try {
      const newClean = newCleanOr400(body.data.newClean);
      const pv = await preview(db, dataDir, p.data.id, newClean, null);
      if (pv.missing.scan) throw new ProjectError(409, 'the new version has not been scanned yet: scan it in Configs first', 'not_scanned', { profileId: newClean.id });
      if (pv.missing.import) throw new ProjectError(409, 'the mods of the new version are not imported yet: import them in Profiles first', 'not_imported', { profileId: newClean.id });
      const missing = withoutChoice(pv.items);
      if (missing.length) throw new ProjectError(400, `${missing.length} retouch(es) need a choice before exporting`, 'choice_missing', { missing: missing.map((i) => ({ kind: i.kind, key: i.key, status: i.status })) });
      const lookup = (pid: number): Profile | null => {
        try {
          return getProfile(db, pid);
        } catch {
          return null;
        }
      };
      const target = body.data.target ? profileOr404(deps, body.data.target) : null;
      const result = await buildProjectExport({
        db,
        dataDir,
        exportsDir: path.join(dataDir, 'exports'),
        preview: pv,
        target,
        profileById: lookup,
        candidateFallback: body.data.candidate ? profileOr404(deps, body.data.candidate) : null,
      });
      audit(db, 'project.export', result.name, { project: p.data.id, counts: result.counts });
      return { result, name: result.name, folder: result.folder, zip: path.basename(result.zipPath) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  function newCleanOr400(pid: number): Profile {
    const newClean = profileOr404(deps, pid);
    if (newClean.state !== 'clean') throw new ProjectError(400, `the new base must be a clean profile, not ${newClean.state}`, 'triad_state', { role: 'newClean' });
    return newClean;
  }
}

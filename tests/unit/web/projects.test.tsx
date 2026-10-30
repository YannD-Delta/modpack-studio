// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Projects } from '../../../src/web/pages/Projects.js';

type Call = { url: string; method: string; body?: string };
let calls: Call[] = [];

const profile = (id: number, pack: string, version: string, state: string) => ({ id, packVersionId: 1, pack, version, side: 'client', state, locationKind: 'folder', location: 'x', immutable: state !== 'candidate' });
const matrix = [
  { pack: 'Base', version: '8.4', cells: { 'client-clean': profile(1, 'Base', '8.4', 'clean'), 'client-launched': profile(2, 'Base', '8.4', 'launched') } },
  { pack: 'Own', version: 'test-1', cells: { 'client-candidate': profile(3, 'Own', 'test-1', 'candidate') } },
  { pack: 'Base', version: '8.5', cells: { 'client-clean': profile(4, 'Base', '8.5', 'clean') } },
];

function mockApi() {
  calls = [];
  let validated = false;
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body as string | undefined });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/profiles/matrix')) return json(matrix);
    if (url.endsWith('/projects') && method === 'GET') return json({ projects: [{ id: 7, name: 'LMP 2026', baseVersion: null, createdAt: 'x', changes: validated ? 2 : 0 }] });
    if (url.includes('/projects/7/proposal')) {
      return json({
        files: [{ path: 'config/a.toml', status: 'modifiedShipped', validated: false, playedSize: 5 }, { path: 'config/mine.toml', status: 'added', validated: false, playedSize: 9 }],
        mods: [{ modId: 'x', action: 'update', version: '2.0', baseVersion: '1.0', file: 'x-2.0.jar', validated: false }],
      });
    }
    if (url.endsWith('/projects/7/changes') && method === 'POST') {
      validated = true;
      return json({ ok: true, files: 1, mods: 1, changes: [] });
    }
    if (url.endsWith('/projects/7') && method === 'GET') return json({ project: { id: 7, name: 'LMP 2026', baseVersion: validated ? '8.4' : null, createdAt: 'x' }, changes: [] });
    if (url.includes('/projects/7/preview')) {
      return json({
        project: { id: 7, name: 'LMP 2026', baseVersion: '8.4', createdAt: 'x' },
        newClean: { id: 4, label: 'Base 8.5' },
        missing: { scan: false, import: false },
        summary: { safe: 1, already: 0, conflict: 1, warning: 0 },
        baseDiff: { added: 3, removed: 1, updated: 2 },
        items: [
          { id: 1, kind: 'file', key: 'config/a.toml', action: 'file', status: 'safe', reason: 'base-unchanged', mine: { size: 5 }, newBase: { size: 5 } },
          { id: 2, kind: 'mod', key: 'x', action: 'update', status: 'conflict', reason: 'base-updated', mine: { version: '2.0' }, newBase: { version: '1.5' } },
        ],
      });
    }
    return json({});
  });
}

const wrap = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Projects /></QueryClientProvider>);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Projects page', () => {
  it('validates the retouches of the candidate: lists them, saves the checked ones with the three copies', async () => {
    mockApi();
    wrap();
    await userEvent.selectOptions(await screen.findByLabelText('Clean (base d\'origine)'), '1');
    await userEvent.selectOptions(screen.getByLabelText('Lancé (clean démarré une fois)'), '2');
    await userEvent.selectOptions(screen.getByLabelText('Candidat (ta copie custom)'), '3');
    await userEvent.click(screen.getByRole('button', { name: 'Voir mes retouches' }));
    expect(await screen.findByText('config/a.toml')).toBeTruthy();
    expect(screen.getByText('1.0 → 2.0')).toBeTruthy();
    await userEvent.click(screen.getByLabelText('config/mine.toml')); // uncheck one
    await userEvent.click(screen.getByRole('button', { name: 'Valider la sélection' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/projects/7/changes'))).toBe(true));
    expect(JSON.parse(calls.find((c) => c.method === 'POST' && c.url.endsWith('/changes'))!.body!)).toEqual({ clean: 1, launched: 2, candidate: 3, files: ['config/a.toml'], mods: ['x'] });
    expect(await screen.findByText('1 fichiers et 1 mods validés.')).toBeTruthy();
  });

  it('previews a new base version with a verdict per retouch', async () => {
    mockApi();
    wrap();
    await userEvent.selectOptions(await screen.findByLabelText('Nouvelle version clean'), '4');
    await userEvent.selectOptions(screen.getByLabelText('Ancienne version clean (facultatif)'), '1');
    await userEvent.click(screen.getByRole('button', { name: "Voir l'aperçu" }));
    expect((await screen.findByTestId('preview-summary')).textContent).toBe('1 à rejouer sans risque · 0 déjà en place · 1 en conflit · 0 à vérifier');
    const rows = screen.getAllByTestId('preview-row');
    expect(within(rows[0]!).getByText('sans risque')).toBeTruthy();
    expect(within(rows[1]!).getByText('conflit')).toBeTruthy();
    expect(within(rows[1]!).getByText('le pack de base a mis ce mod à jour (version 1.5)')).toBeTruthy();
    expect(screen.getByText('Le pack de base a changé : 3 mods ajoutés, 1 retirés, 2 mis à jour.')).toBeTruthy();
    expect(calls.find((c) => c.url.includes('/preview'))!.url).toBe('/api/v1/projects/7/preview?newClean=4&oldClean=1');
  });
});

// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Mods } from '../../../src/web/pages/Mods.js';

type Call = { url: string; method: string; body?: unknown };
let calls: Call[] = [];
let planned: Set<string>;
let files: string[];
let decisions: { pins: string[]; ignored: string[]; clientOnly: string[] };

const profile = (id: number, pack: string, version: string, side: string, state: string, kind = 'folder') => ({ id, packVersionId: 1, pack, version, side, state, locationKind: kind, location: 'x', immutable: true });
const matrix = [
  { pack: 'Base', version: '8.3', cells: { 'client-clean': profile(2, 'Base', '8.3', 'client', 'clean'), 'server-clean': null, 'client-launched': null, 'client-run': null, 'server-launched': null, 'server-run': null } },
  { pack: 'Own', version: '1.0', cells: { 'client-clean': profile(3, 'Own', '1.0', 'client', 'clean'), 'client-launched': null, 'client-run': null, 'server-clean': null, 'server-launched': null, 'server-run': null } },
];
const e = (modId: string, version: string, file = `${modId}-${version}.jar`, sha256 = `${modId}${version}`) => ({ modId, version, sha256, file });
const diff = {
  added: [e('mine', '1.0')],
  removed: [e('b', '1.0')],
  updated: [
    { modId: 'a', from: e('a', '1.1'), to: e('a', '1.0'), direction: 'older' },
    { modId: 'n', from: e('n', '1.0'), to: e('n', '2.0'), direction: 'newer' },
  ],
  rebuilt: [e('r', '1.0')],
  unchanged: 4,
};
const exportResult = {
  name: 'update-Own-1.0-from-Base-8.3-20261029-130509',
  folder: 'D:/studio/data/exports/update-Own-1.0-from-Base-8.3-20261029-130509',
  zipPath: 'x.zip',
  zipBytes: 1234,
  createdAt: '2026-10-29T13:05:09.000Z',
  base: { id: 2, label: 'Base 8.3 (client, clean)' },
  other: { id: 3, label: 'Own 1.0 (client, clean)' },
  counts: { modsUpdated: 1, modsRestored: 0, jarsToRemove: 1, files: 0, failures: 1 },
  failures: [{ kind: 'mod', key: 'b', reason: 'reference jar b-1.0.jar: not found: D:/upstream/mods/b-1.0.jar' }],
  warnings: [],
};
const debugDoc = {
  modId: 'a',
  generatedAt: '2026-10-29T13:00:00.000Z',
  status: 'older',
  base: { profile: { id: 2, label: 'Base 8.3 (client, clean)', pack: 'Base', version: '8.3', side: 'client', state: 'clean', locationKind: 'folder', location: 'D:/upstream' }, entry: e('a', '1.1', 'a-1.1.jar', 'f'.repeat(64)) },
  other: { profile: { id: 3, label: 'Own 1.0 (client, clean)', pack: 'Own', version: '1.0', side: 'client', state: 'clean', locationKind: 'folder', location: 'D:/own' }, entry: e('a', '1.0', 'a-1.0.jar', 'e'.repeat(64)) },
  comparison: { comparedAs: 'x', a: { raw: '1.0', tokens: ['1', '0'], hashLike: false, unparsable: false }, b: { raw: '1.1', tokens: ['1', '1'], hashLike: false, unparsable: false }, result: 'older', deciding: { index: 1, tokenA: '0', tokenB: '1' }, note: 'Token 1 decides' },
  decisions: { pin: null, ignore: null, side: null, blacklisted: null },
  plan: { planned: false, actionable: true, action: 'update' },
  duplicates: { base: null, other: null },
  sourceJar: { side: 'base', locationKind: 'folder', path: 'D:/upstream/mods/a-1.1.jar', exists: true, size: 2048, sha256Recorded: 'f'.repeat(64), sha256Actual: 'f'.repeat(64), matches: true, error: null },
};

const items = () => [...[...planned].sort().map((key) => ({ kind: 'mod', key, action: 'take_ref' })), ...files.map((key) => ({ kind: 'file', key, action: 'take_ref' }))];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls = [];
  planned = new Set();
  files = [];
  decisions = { pins: [], ignored: [], clientOnly: [] };
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method, body });
    if (url.includes('/profiles/matrix')) return json(matrix);
    if (url.includes('/mods/diff')) return json(diff);
    if (url.includes('/debug?')) return json(debugDoc);
    if (url.startsWith('/api/v1/plan?') && method === 'GET') return json({ items: items(), decisions });
    if (url.startsWith('/api/v1/plan?') && method === 'DELETE') {
      planned.clear();
      return json({ ok: true });
    }
    if (url === '/api/v1/plan' && method === 'PUT') {
      for (const k of body.keys as string[]) {
        if (body.selected) planned.add(k);
        else planned.delete(k);
      }
      return json({ ok: true, items: items() });
    }
    if (url === '/api/v1/plan/export') return json({ jobId: 'job-1' }, 202);
    if (url.includes('/plan/jobs/job-1')) return json({ id: 'job-1', status: 'done', progress: 100, message: `export ${exportResult.name}: ok`, name: exportResult.name });
    if (url.includes(`/plan/exports/${exportResult.name}`)) return json({ result: exportResult, folder: exportResult.folder });
    return json({});
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function open() {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Mods /></QueryClientProvider>);
  await userEvent.selectOptions(await screen.findByLabelText('Référence'), '2');
  await userEvent.selectOptions(screen.getByLabelText('Comparé à'), '3');
  await screen.findByText('pas à jour');
}

const puts = () => calls.filter((c) => c.method === 'PUT' && c.url === '/api/v1/plan').map((c) => c.body);

describe('Mods page: update plan', () => {
  it('offers "Mettre à jour" on older/different/rebuilt rows and "Remettre le mod" on missing ones, never on newer or added', async () => {
    await open();
    expect(screen.getByRole('button', { name: 'Mettre à jour a' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Mettre à jour r' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remettre le mod b' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Mettre à jour n' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mettre à jour mine' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Mettre à jour a' }).getAttribute('title')).toMatch(/Ne modifie aucun fichier/);
    // the existing decisions are still there
    expect(screen.getByRole('button', { name: 'Épingler a' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Accepter le retrait b' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Client uniquement mine' })).toBeTruthy();
  });

  it('persists the toggle through PUT /plan and shows the planned state', async () => {
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Mettre à jour a' }));
    const toggle = await screen.findByRole('button', { name: '✓ Prévu a' });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(puts()[0]).toEqual({ base: 2, other: 3, kind: 'mod', keys: ['a'], selected: true });
    await userEvent.click(toggle);
    expect(await screen.findByRole('button', { name: 'Mettre à jour a' })).toBeTruthy();
    expect(puts()[1]).toMatchObject({ keys: ['a'], selected: false });
  });

  it('shows the decisions in force as badges', async () => {
    decisions = { pins: ['a'], ignored: ['b'], clientOnly: ['mine'] };
    await open();
    expect(await screen.findByText('retrait accepté')).toBeTruthy();
    expect(screen.getByText('épinglé')).toBeTruthy();
    expect(screen.getByText('client uniquement')).toBeTruthy();
  });

  it('selects every updatable row of the current filter, and clears the plan', async () => {
    await open();
    await userEvent.click(screen.getByRole('button', { name: /Pas à jour · 1/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Tout sélectionner' }));
    await waitFor(() => expect(puts()[0]).toMatchObject({ keys: ['a'], selected: true }));
    await userEvent.click(screen.getByRole('button', { name: /Tout · / }));
    await userEvent.click(screen.getByRole('button', { name: 'Tout sélectionner' }));
    await waitFor(() => expect(puts()[1]).toMatchObject({ keys: ['b', 'r'], selected: true }));
    await userEvent.click(screen.getByRole('button', { name: 'Vider le plan' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('kind=mod'))).toBe(true));
  });

  it('shows a bottom bar with counts, prepares the pack and explains how to apply it', async () => {
    planned = new Set(['a', 'b']);
    files = ['config/x.toml'];
    await open();
    const bar = await screen.findByRole('region', { name: 'Plan de mise à jour' });
    expect(within(bar).getByText(/1 mises à jour/)).toBeTruthy();
    expect(within(bar).getByText(/1 remises/)).toBeTruthy();
    expect(within(bar).getByText(/1 fichiers de config/)).toBeTruthy();
    const go = within(bar).getByRole('button', { name: 'Préparer le pack de mise à jour' });
    expect(go.getAttribute('title')).toMatch(/N’écrit dans aucune instance/);
    await userEvent.click(go);

    expect(await screen.findByText('Pack de mise à jour prêt')).toBeTruthy();
    expect(calls.find((c) => c.url === '/api/v1/plan/export')!.body).toEqual({ base: 2, other: 3 });
    expect(screen.getByText(exportResult.folder)).toBeTruthy();
    expect(screen.getByText(/not found: D:\/upstream\/mods\/b-1.0.jar/)).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Télécharger le zip' });
    expect(link.getAttribute('href')).toBe(`/api/v1/plan/exports/${exportResult.name}/download`);
    expect(screen.getAllByText(/apply\.ps1 -InstanceDir/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Rien n’est supprimé/)).toBeTruthy();
  });

  it('expands a debug panel under the row and copies the JSON', async () => {
    await open();
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const toggle = screen.getByRole('button', { name: '🐞 Détails a' });
    expect(toggle.getAttribute('title')).toMatch(/Ne modifie rien/);
    await userEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(await screen.findByText('✓ trouvé, identique à l’import')).toBeTruthy();
    expect(screen.getByText(/la version comparée est plus ancienne/)).toBeTruthy();
    expect(screen.getByText(/élément n°1 décisif : « 0 » contre « 1 »/)).toBeTruthy();
    expect(screen.getByText('D:/upstream/mods/a-1.1.jar')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Copier le debug (JSON)' }));
    expect(await screen.findByText('Copié ✓')).toBeTruthy();
    expect(JSON.parse(writeText.mock.calls[0]![0]).modId).toBe('a');
  });
});

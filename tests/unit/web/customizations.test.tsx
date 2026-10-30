// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Customizations } from '../../../src/web/api-configs.js';
import { CustomizationsView } from '../../../src/web/pages/ConfigsCustomizations.js';

type Reply = { status?: number; body: unknown };
let calls: { url: string; method: string; body?: string }[] = [];
let plan: string[] = [];

function mockApi(handler: (url: string, init?: RequestInit) => Reply | undefined) {
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined });
    const r = handler(url, init) ?? { body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  });
}
const wrap = (ui: ReactElement) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);

const profile = (id: number, state: string) => ({ id, packVersionId: 1, pack: 'Own', version: '8.3', side: 'client', state, locationKind: 'folder', location: `/x/${id}`, immutable: state !== 'run' });
const matrix = [
  { pack: 'Own', version: '8.3', cells: { 'client-clean': profile(1, 'clean'), 'client-launched': profile(2, 'launched'), 'client-run': profile(3, 'run'), 'server-clean': null, 'server-launched': null, 'server-run': null } },
];
const inventory = (id: number) => ({ profile: { id }, scannedAt: '2026-10-29T10:00:00.000Z', total: 5, bytes: 100, perRoot: {}, issueCount: 0, issues: [] });
const empty = { modifiedGenerated: 0, modifiedShipped: 0, added: 0, removed: 0, untouched: 0 };
const custom: Customizations = {
  files: [
    { path: 'config/generated-edited.toml', root: 'config', ext: 'toml', kind: 'text', status: 'modifiedGenerated', include: true, inClean: false, launchedSize: 22, playedSize: 20 },
    { path: 'config/shipped-edited.toml', root: 'config', ext: 'toml', kind: 'text', status: 'modifiedShipped', include: true, inClean: true, launchedSize: 12, playedSize: 12 },
    { path: 'config/mine.toml', root: 'config', ext: 'toml', kind: 'text', status: 'added', include: true, inClean: false, launchedSize: null, playedSize: 14 },
    { path: 'config/gone.toml', root: 'config', ext: 'toml', kind: 'text', status: 'removed', include: false, inClean: false, launchedSize: 6, playedSize: null },
  ],
  summary: { perStatus: { ...empty, modifiedGenerated: 1, modifiedShipped: 1, added: 1, removed: 1, untouched: 40 }, include: 3, perRoot: {} },
  total: 44,
};

beforeEach(() => {
  plan = [];
  mockApi((url, init) => {
    if (url.includes('/profiles/matrix')) return { body: matrix };
    if (url.includes('/configs/inventory')) return { body: inventory(Number(/profile=(\d+)/.exec(url)![1])) };
    if (url.includes('/configs/customizations/plan') && init?.method === 'PUT') {
      const b = JSON.parse(init.body as string) as { paths: string[]; selected: boolean };
      plan = b.selected ? [...new Set([...plan, ...b.paths])].sort() : plan.filter((p) => !b.paths.includes(p));
      return { body: { ok: true, paths: plan } };
    }
    if (url.includes('/configs/customizations')) return { body: custom };
    if (url.includes('/configs/plan')) return { body: { paths: plan } };
    if (url.endsWith('/plan/export') && init?.method === 'POST') return { status: 202, body: { jobId: 'job-1' } };
    if (url.includes('/plan/jobs/job-1')) return { body: { id: 'job-1', status: 'done', progress: 100, message: null, name: 'update-pack-1' } };
    if (url.includes('/plan/exports/update-pack-1')) return { body: { result: { name: 'update-pack-1' }, folder: 'C:\\data\\exports\\update-pack-1' } };
    return undefined;
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function pickThree() {
  const selects = await screen.findAllByRole('combobox');
  await waitFor(() => expect(within(selects[0]!).getAllByRole('option').length).toBeGreaterThan(1));
  await userEvent.selectOptions(selects[0]!, '1');
  await userEvent.selectOptions(selects[1]!, '2');
  await userEvent.selectOptions(selects[2]!, '3');
}

describe('CustomizationsView', () => {
  it('explains the logic in plain French and asks for the three profiles first', async () => {
    wrap(<CustomizationsView />);
    expect(await screen.findByText('EN CLAIR')).toBeTruthy();
    expect(screen.getByText(/Choisis et analyse les trois profils/)).toBeTruthy();
  });

  it('shows what was changed, told apart as generated, shipped, added or removed, and hides the untouched ones', async () => {
    wrap(<CustomizationsView />);
    await pickThree();
    expect(await screen.findByText('config/generated-edited.toml')).toBeTruthy();
    expect(screen.getByText('config/mine.toml')).toBeTruthy();
    const row = screen.getByText('config/generated-edited.toml').closest('li')!;
    expect(within(row).getByText('généré, retouché').getAttribute('title')).toMatch(/pas dans le clean/);
    expect(screen.getByText(/40 fichiers inchangés/)).toBeTruthy();
    expect(screen.getByText('config/gone.toml')).toBeTruthy();
  });

  it('keeps a file in the pack through the plan of the played instance, and offers no button on a removed file', async () => {
    wrap(<CustomizationsView />);
    await pickThree();
    const row = (await screen.findByText('config/generated-edited.toml')).closest('li')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Garder dans le pack' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.url.endsWith('/configs/customizations/plan'))).toBe(true));
    expect(JSON.parse(calls.find((c) => c.method === 'PUT')!.body!)).toEqual({ clean: 1, launched: 2, played: 3, paths: ['config/generated-edited.toml'], selected: true });
    expect(await within(row).findByText('✓ Gardé')).toBeTruthy();
    expect(within(screen.getByText('config/gone.toml').closest('li')!).queryByRole('button', { name: 'Garder dans le pack' })).toBeNull();
  });

  it('keeps every changed or added file of the list at once, then prepares the pack and links the zip', async () => {
    wrap(<CustomizationsView />);
    await pickThree();
    await userEvent.click(await screen.findByRole('button', { name: 'Tout garder' }));
    expect(await screen.findByText('Dans le plan : 3')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Préparer le pack de mise à jour' }));
    expect(await screen.findByText('Pack prêt : update-pack-1')).toBeTruthy();
    expect(JSON.parse(calls.find((c) => c.url.endsWith('/plan/export'))!.body!)).toEqual({ base: 3, other: 2 });
    expect(screen.getByRole('link', { name: 'Télécharger le zip' }).getAttribute('href')).toBe('/api/v1/plan/exports/update-pack-1/download');
  });

  it('shows why the export could not start instead of failing silently', async () => {
    const base = globalThis.fetch;
    wrap(<CustomizationsView />);
    await pickThree();
    await userEvent.click(await screen.findByRole('button', { name: 'Tout garder' }));
    expect(await screen.findByText('Dans le plan : 3')).toBeTruthy();
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => (String(url).endsWith('/plan/export') ? new Response(JSON.stringify({ error: 'the reference location cannot be read' }), { status: 409, headers: { 'content-type': 'application/json' } }) : base(url, init)));
    await userEvent.click(screen.getByRole('button', { name: 'Préparer le pack de mise à jour' }));
    expect(await screen.findByText(/La préparation a échoué : the reference location cannot be read/)).toBeTruthy();
  });

  it('says so when the export job ends cancelled or interrupted', async () => {
    const base = globalThis.fetch;
    wrap(<CustomizationsView />);
    await pickThree();
    await userEvent.click(await screen.findByRole('button', { name: 'Tout garder' }));
    expect(await screen.findByText('Dans le plan : 3')).toBeTruthy();
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => (String(url).includes('/plan/jobs/job-1') ? new Response(JSON.stringify({ id: 'job-1', status: 'interrupted', progress: null, message: null, name: null }), { status: 200, headers: { 'content-type': 'application/json' } }) : base(url, init)));
    await userEvent.click(screen.getByRole('button', { name: 'Préparer le pack de mise à jour' }));
    expect(await screen.findByText(/a été interrompue/)).toBeTruthy();
  });

  it('shows why a plan change was refused', async () => {
    const base = globalThis.fetch;
    wrap(<CustomizationsView />);
    await pickThree();
    const row = (await screen.findByText('config/mine.toml')).closest('li')!;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => (init?.method === 'PUT' ? new Response(JSON.stringify({ error: 'only changed or added files can go into the pack' }), { status: 400, headers: { 'content-type': 'application/json' } }) : base(url, init)));
    await userEvent.click(within(row).getByRole('button', { name: 'Garder dans le pack' }));
    expect(await screen.findByText(/Plan non enregistré : only changed or added files/)).toBeTruthy();
  });

  it('shows an error when the profile list cannot be read', async () => {
    mockApi(() => ({ status: 500, body: { error: 'matrix broke' } }));
    wrap(<CustomizationsView />);
    expect(await screen.findByText(/Impossible de lire les profils : matrix broke/)).toBeTruthy();
  });

  it('tells that the launched profile is only the comparison reference of the exported pack', async () => {
    wrap(<CustomizationsView />);
    await pickThree();
    await userEvent.click(await screen.findByRole('button', { name: 'Tout garder' }));
    expect(await screen.findByText(/ne lui applique pas le pack/)).toBeTruthy();
  });
});

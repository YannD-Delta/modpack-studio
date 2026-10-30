// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigDiff, DiffLine, FileDiff } from '../../../src/web/api-configs.js';
import { collapseUnchanged, Configs, fmtSize } from '../../../src/web/pages/Configs.js';

type Reply = { status?: number; body: unknown };
type Handler = (url: string, init?: RequestInit) => Reply | undefined;
let calls: { url: string; method: string; body?: string }[] = [];

function mockApi(handler: Handler) {
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined });
    const r = handler(url, init) ?? { body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  });
}
const wrap = (ui: ReactElement) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const profile = (id: number, pack: string, version: string, side: string, state: string) => ({ id, packVersionId: 1, pack, version, side, state, locationKind: 'folder', location: 'x', immutable: state !== 'run' });
const matrix = [
  { pack: 'Base', version: '8.3', cells: { 'client-clean': profile(2, 'Base', '8.3', 'client', 'clean'), 'client-launched': null, 'client-run': null, 'server-clean': null, 'server-launched': null, 'server-run': null } },
  { pack: 'Own', version: '1.0', cells: { 'client-clean': null, 'client-launched': profile(3, 'Own', '1.0', 'client', 'launched'), 'client-run': null, 'server-clean': null, 'server-launched': null, 'server-run': null } },
];
const inventory = (id: number) => ({ profile: { id }, scannedAt: '2026-10-29T10:00:00.000Z', total: 5, bytes: 100, perRoot: {}, issueCount: 0, issues: [] });
const counts = (o: Partial<Record<string, number>>) => ({ onlyInBase: 0, modified: 0, binaryDiffers: 0, tooLarge: 0, onlyInOther: 0, cosmetic: 0, identical: 0, ...o });
const diff: ConfigDiff = {
  base: { id: 2, pack: 'Base', version: '8.3', side: 'client', state: 'clean', immutable: true, scannedAt: 'x' },
  other: { id: 3, pack: 'Own', version: '1.0', side: 'client', state: 'launched', immutable: true, scannedAt: 'x' },
  summary: {
    perStatus: counts({ onlyInBase: 1, modified: 1, onlyInOther: 1, cosmetic: 1, identical: 1 }),
    perRoot: { config: counts({ onlyInBase: 1, modified: 1, cosmetic: 1, identical: 1 }), kubejs: counts({ onlyInOther: 1 }) },
  },
  files: [
    { path: 'config/only-upstream.toml', root: 'config', ext: 'toml', kind: 'text', status: 'onlyInBase', baseSize: 10, otherSize: null },
    { path: 'config/sub/changed.toml', root: 'config', ext: 'toml', kind: 'text', status: 'modified', baseSize: 2048, otherSize: 2100 },
    { path: 'kubejs/server_scripts/mine.js', root: 'kubejs', ext: 'js', kind: 'text', status: 'onlyInOther', baseSize: null, otherSize: 8 },
    { path: 'config/format.json', root: 'config', ext: 'json', kind: 'text', status: 'cosmetic', baseSize: 13, otherSize: 20 },
    { path: 'config/same.toml', root: 'config', ext: 'toml', kind: 'text', status: 'identical', baseSize: 5, otherSize: 5 },
  ],
  total: 5,
  truncated: false,
};
const lines: DiffLine[] = [
  ...Array.from({ length: 10 }, (_, i): DiffLine => ({ type: 'equal', text: `l${i}`, oldNo: i + 1, newNo: i + 1 })),
  { type: 'del', text: 'speed = 1', oldNo: 11, newNo: null },
  { type: 'add', text: 'speed = 3', oldNo: null, newNo: 11 },
];
const fileDiff: FileDiff = { path: 'config/sub/changed.toml', status: 'modified', kind: 'text', baseSize: 1, otherSize: 1, binary: false, tooLarge: false, truncated: false, coarse: false, stale: false, added: 1, removed: 1, lines };

function standard(extra: Handler = () => undefined): Handler {
  let plan: string[] = [];
  return (url, init) => {
    const custom = extra(url, init);
    if (custom) return custom;
    if (url.includes('/profiles/matrix')) return { body: matrix };
    if (url.includes('/configs/inventory')) return { body: inventory(Number(/profile=(\d+)/.exec(url)![1])) };
    if (url.includes('/configs/diff')) return { body: diff };
    if (url.includes('/configs/filediff')) return { body: fileDiff };
    if (url.includes('/configs/plan') && init?.method === 'PUT') {
      const b = JSON.parse(init.body as string) as { paths: string[]; selected: boolean };
      plan = b.selected ? [...new Set([...plan, ...b.paths])].sort() : plan.filter((p) => !b.paths.includes(p));
      return { body: { ok: true, paths: plan } };
    }
    if (url.includes('/configs/plan')) return { body: { paths: plan } };
    return undefined;
  };
}

async function pick() {
  await userEvent.selectOptions(await screen.findByLabelText('Référence'), '2');
  await userEvent.selectOptions(screen.getByLabelText('Comparé à'), '3');
}

describe('Configs page', () => {
  it('warns when some binary files were only compared by size, and says nothing otherwise', async () => {
    mockApi(standard((url) => (url.includes('/configs/diff') ? { body: { ...diff, sizeOnlyIdentical: 3 } } : undefined)));
    wrap(<Configs />);
    await pick();
    expect((await screen.findByRole('note')).textContent).toContain('3 fichiers binaires');
    cleanup();
    mockApi(standard());
    wrap(<Configs />);
    await pick();
    await screen.findByText('Le fichier existe dans Base 8.3 mais pas dans Own 1.0.');
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('shows French statuses, reasons and states, hiding identical files by default', async () => {
    mockApi(standard());
    wrap(<Configs />);
    await pick();
    expect(await screen.findByText('Le fichier existe dans Base 8.3 mais pas dans Own 1.0.')).toBeTruthy();
    expect(screen.getByText('Le fichier existe dans Own 1.0 mais pas dans Base 8.3.')).toBeTruthy();
    expect(screen.getAllByText('manque dans Own 1.0').length).toBeGreaterThan(0);
    expect(screen.getAllByTestId('config-row')).toHaveLength(4);
    expect(screen.queryByText('same.toml')).toBeNull();
    // the state of each profile is visible, with a tooltip explaining what it means for configs
    expect(screen.getByText('propre').getAttribute('title')).toMatch(/jamais lancé/);
    expect(screen.getByText('lancé').getAttribute('title')).toMatch(/réécrit des configs/);
    expect(screen.getByText(/Une partie des différences peut venir du lancement/)).toBeTruthy();
    // every status badge carries a tooltip
    expect(screen.getAllByText('forme seulement')[0]!.closest('[title]')!.getAttribute('title')).toMatch(/Rien à faire/);

    await userEvent.click(screen.getByLabelText('Afficher les identiques'));
    expect(screen.getAllByTestId('config-row')).toHaveLength(5);
    expect(screen.getByText('same.toml')).toBeTruthy();
  });

  it('filters by status, root folder and search text', async () => {
    mockApi(standard());
    wrap(<Configs />);
    await pick();
    await screen.findByText('changed.toml');
    await userEvent.click(screen.getByRole('button', { name: /kubejs\/ · 1/ }));
    expect(screen.getAllByTestId('config-row')).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Tous les dossiers' }));
    await userEvent.click(screen.getByRole('button', { name: /modifié · 1/ }));
    expect(screen.getAllByTestId('config-row')).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: /^Tout · / }));
    await userEvent.type(screen.getByLabelText('Rechercher un chemin'), 'format');
    expect(screen.getAllByTestId('config-row')).toHaveLength(1);
    await userEvent.type(screen.getByLabelText('Rechercher un chemin'), 'zzz');
    expect(screen.getByText('Aucun fichier ne correspond aux filtres.')).toBeTruthy();
  });

  it('expands an inline diff and then counts the changed lines', async () => {
    mockApi(standard());
    wrap(<Configs />);
    await pick();
    expect(await screen.findByText('Contenu différent.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Détails config/sub/changed.toml' }));
    const view = await screen.findByTestId('file-diff');
    expect(within(view).getByText('speed = 1')).toBeTruthy();
    expect(within(view).getByText('speed = 3')).toBeTruthy();
    expect(await screen.findByText('Contenu différent : 2 lignes changées.')).toBeTruthy();
    // the 10 unchanged lines before the change collapse, keeping 3 lines of context
    const gap = within(view).getByRole('button', { name: '… 7 lignes identiques' });
    expect(within(view).queryByText('l0')).toBeNull();
    await userEvent.click(gap);
    expect(within(view).getByText('l0')).toBeTruthy();
    expect(calls.some((c) => c.url.includes('/configs/filediff?base=2&other=3&path=config%2Fsub%2Fchanged.toml'))).toBe(true);
  });

  it('adds a file to the update plan and explains that nothing is modified now', async () => {
    mockApi(standard());
    wrap(<Configs />);
    await pick();
    const take = await screen.findByRole('button', { name: 'Prendre la version de Base 8.3 config/sub/changed.toml' });
    expect(take.getAttribute('title')).toMatch(/Ne modifie rien maintenant/);
    expect(take.getAttribute('title')).toMatch(/Ne touche jamais à l'instance/);
    // only plannable statuses get the toggle
    expect(screen.queryByRole('button', { name: /Prendre la version de Base 8\.3 kubejs/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Prendre la version de Base 8\.3 config\/format\.json/ })).toBeNull();
    await userEvent.click(take);
    expect(await screen.findByRole('button', { name: '✓ Prévu config/sub/changed.toml' })).toBeTruthy();
    expect(JSON.parse(calls.find((c) => c.method === 'PUT')!.body!)).toEqual({ base: 2, other: 3, paths: ['config/sub/changed.toml'], selected: true });
    expect(screen.getByText('Prévus dans le plan : 1')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Tout sélectionner (filtre courant)' }));
    await waitFor(() => expect(screen.getByText('Prévus dans le plan : 2')).toBeTruthy());
    expect(JSON.parse(calls.filter((c) => c.method === 'PUT')[1]!.body!)).toMatchObject({ paths: ['config/only-upstream.toml'], selected: true });
    await userEvent.click(screen.getByRole('button', { name: 'Vider' }));
    await waitFor(() => expect(screen.getByText('Prévus dans le plan : 0')).toBeTruthy());
  });

  it('offers a scan for a never-scanned profile, follows the job, then shows the diff', async () => {
    let scanned = false;
    let polls = 0;
    mockApi(standard((url, init) => {
      if (url.includes('/configs/inventory?profile=3') && !scanned) return { status: 409, body: { error: 'never scanned' } };
      if (url.endsWith('/configs/scan') && init?.method === 'POST') return { status: 202, body: { jobId: '00000000-0000-4000-8000-000000000001' } };
      if (url.includes('/configs/scan/')) {
        polls++;
        if (polls < 2) return { body: { status: 'running', progress: 40, message: 'config/a.toml' } };
        scanned = true;
        return { body: { status: 'done', progress: 100, message: 'scanned 5 files' } };
      }
      return undefined;
    }));
    wrap(<Configs />);
    await pick();
    expect(await screen.findByText('jamais analysé')).toBeTruthy();
    expect(screen.getByText('Analyse les deux profils pour voir leurs différences.')).toBeTruthy();
    const btn = screen.getAllByRole('button', { name: 'Analyser' })[0]!;
    expect(btn.getAttribute('title')).toMatch(/sans rien modifier/);
    await userEvent.click(btn);
    expect(JSON.parse(calls.find((c) => c.method === 'POST')!.body!)).toEqual({ profile: 3, force: false, deep: false });
    expect(await screen.findByText('Contenu différent.', {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Réanalyser' })).toHaveLength(2);
  });

  it('reports a failed scan in French', async () => {
    mockApi(standard((url, init) => {
      if (url.includes('/configs/inventory?profile=3')) return { status: 409, body: { error: 'never scanned' } };
      if (url.endsWith('/configs/scan') && init?.method === 'POST') return { status: 202, body: { jobId: '00000000-0000-4000-8000-000000000002' } };
      if (url.includes('/configs/scan/')) return { body: { status: 'failed', progress: 0, message: 'cannot read the location: access denied' } };
      return undefined;
    }));
    wrap(<Configs />);
    await pick();
    await userEvent.click((await screen.findAllByRole('button', { name: 'Analyser' }))[0]!);
    expect(await screen.findByText('Analyse échouée : cannot read the location: access denied')).toBeTruthy();
  });

  it('shows an error, not "Chargement…", when the profile list cannot be read', async () => {
    mockApi(() => ({ status: 500, body: { error: 'matrix broke' } }));
    wrap(<Configs />);
    expect(await screen.findByText(/Impossible de lire les profils : matrix broke/)).toBeTruthy();
    expect(screen.queryByText('Chargement…')).toBeNull();
  });

  it('applies a plan answer to the pair that asked, not to the pair selected meanwhile', async () => {
    const withFour = [...matrix, { pack: 'Own', version: '2.0', cells: { 'client-clean': null, 'client-launched': profile(4, 'Own', '2.0', 'client', 'launched'), 'client-run': null, 'server-clean': null, 'server-launched': null, 'server-run': null } }];
    mockApi(standard((url, init) => {
      if (url.includes('/profiles/matrix')) return { body: withFour };
      if (url.includes('/configs/plan') && init?.method !== 'PUT') return { body: { paths: [] } };
      if (url.includes('/configs/plan') && init?.method === 'PUT') return { body: { ok: true, paths: ['config/sub/changed.toml'] } };
      return undefined;
    }));
    const inner = globalThis.fetch;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') await gate;
      return inner(url, init);
    });
    wrap(<Configs />);
    await pick();
    await userEvent.click(await screen.findByRole('button', { name: 'Prendre la version de Base 8.3 config/sub/changed.toml' }));
    await userEvent.selectOptions(screen.getByLabelText('Comparé à'), '4');
    release();
    await new Promise((r) => setTimeout(r, 100));
    expect(await screen.findByText('Prévus dans le plan : 0')).toBeTruthy();
  });

  it('does not track a scan job on a card that shows another profile by now', async () => {
    const withFour = [...matrix, { pack: 'Own', version: '2.0', cells: { 'client-clean': null, 'client-launched': profile(4, 'Own', '2.0', 'client', 'launched'), 'client-run': null, 'server-clean': null, 'server-launched': null, 'server-run': null } }];
    mockApi(standard((url, init) => {
      if (url.includes('/profiles/matrix')) return { body: withFour };
      if (url.includes('/configs/inventory?profile=3')) return { status: 409, body: { error: 'never scanned' } };
      if (url.endsWith('/configs/scan') && init?.method === 'POST') return { status: 202, body: { jobId: '00000000-0000-4000-8000-000000000003' } };
      if (url.includes('/configs/scan/')) return { body: { status: 'running', progress: 10, message: null } };
      return undefined;
    }));
    const inner = globalThis.fetch;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && String(url).endsWith('/configs/scan')) await gate;
      return inner(url, init);
    });
    wrap(<Configs />);
    await pick();
    await userEvent.click((await screen.findAllByRole('button', { name: 'Analyser' }))[0]!);
    await userEvent.selectOptions(screen.getByLabelText('Comparé à'), '4');
    release();
    await new Promise((r) => setTimeout(r, 150));
    expect(screen.queryByText(/Analyse en cours/)).toBeNull();
    expect(screen.queryByText(/Analyse en attente/)).toBeNull();
  });

  it('virtualises long lists', async () => {
    const many = Array.from({ length: 1500 }, (_, i) => ({ path: `config/f${String(i).padStart(4, '0')}.toml`, root: 'config', ext: 'toml', kind: 'text' as const, status: 'modified' as const, baseSize: 1, otherSize: 2 }));
    mockApi(standard((url) => (url.includes('/configs/diff') ? { body: { ...diff, files: many, total: many.length, summary: { perStatus: counts({ modified: 1500 }), perRoot: { config: counts({ modified: 1500 }) } } } } : undefined)));
    wrap(<Configs />);
    await pick();
    await screen.findByRole('button', { name: /modifié · 1500/ });
    expect(screen.queryAllByTestId('config-row').length).toBeLessThan(200);
  });
});

describe('helpers', () => {
  it('collapses long unchanged runs but keeps context around changes', () => {
    const eq = (n: number) => Array.from({ length: n }, (_, i): DiffLine => ({ type: 'equal', text: String(i), oldNo: i + 1, newNo: i + 1 }));
    const add: DiffLine = { type: 'add', text: 'x', oldNo: null, newNo: 1 };
    expect(collapseUnchanged([...eq(10), add, ...eq(10)])).toEqual([
      { kind: 'gap', from: 0, to: 7 },
      { kind: 'lines', from: 7, to: 10 },
      { kind: 'lines', from: 10, to: 11 },
      { kind: 'lines', from: 11, to: 14 },
      { kind: 'gap', from: 14, to: 21 },
    ]);
    expect(collapseUnchanged(eq(4))).toEqual([{ kind: 'gap', from: 0, to: 4 }]);
    expect(collapseUnchanged([add, ...eq(4), add])).toEqual([{ kind: 'lines', from: 0, to: 1 }, { kind: 'lines', from: 1, to: 5 }, { kind: 'lines', from: 5, to: 6 }]);
  });

  it('formats sizes in French units', () => {
    expect(fmtSize(null)).toBe('—');
    expect(fmtSize(12)).toBe('12 o');
    expect(fmtSize(2048)).toBe('2,0 Ko');
    expect(fmtSize(5 * 1024 * 1024)).toBe('5,0 Mo');
  });
});
